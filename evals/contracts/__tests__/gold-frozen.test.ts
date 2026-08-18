import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, posix, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyPatch, type Operation } from 'rfc6902';
import { describe, expect, it } from 'vitest';

import { changedLeafEffects } from '../../../src/patch/scope';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const contractsDir = join(repoRoot, 'evals', 'contracts');
const goldDir = join(contractsDir, 'gold');
const manifestPath = join(contractsDir, 'MANIFEST.lock');
const authorshipPath = join(contractsDir, 'AUTHORSHIP.md');

/**
 * `--no-replace-objects` na KAŽDÉM volání gitu, ne jen u `show`.
 *
 * `refs/replace/*` jsou defaultně zapnuté a nahrazují objekt jiným objektem se
 * zachovaným OID. Bez tohohle příznaku by šlo podvrhnout blob i strom tak, že
 * všechna OID, hashe stromů i tagy zůstanou bitově shodné, `git status` prázdný
 * a celá sada zelená nad zfalšovaným obsahem. Náhrada nad stromem nebo nad
 * objektem tagu obejde i čtení historie, proto to nesmí být jen u čtení souboru.
 */
function git(...args: string[]): string {
  return execFileSync('git', ['--no-replace-objects', ...args], { cwd: repoRoot, encoding: 'utf8' }).trim();
}

function normalisedSha256(absolutePath: string): string {
  const normalised = readFileSync(absolutePath).toString('utf8').replace(/\r\n/g, '\n');
  return createHash('sha256').update(Buffer.from(normalised, 'utf8')).digest('hex');
}

function listFilesRecursive(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    if (statSync(abs).isDirectory()) out.push(...listFilesRecursive(abs));
    else out.push(abs);
  }
  return out;
}

function readJsonl<T>(relativePath: string): T[] {
  return readFileSync(join(repoRoot, relativePath), 'utf8')
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line) as T);
}

interface Requirement {
  kind: string;
  value?: unknown;
}

interface FrozenContract {
  id: string;
  kind: string;
  editClass: string;
  baseWorld: string;
  allowedPaths?: { op: string; path: string }[];
  requirements: Requirement[];
}

interface FrozenResponse {
  forPrompt: string;
  body: unknown;
}

interface CreateTriple {
  kind: string;
  parentId: string;
  semanticRole: string;
}

interface GoldContract {
  id: string;
  editClass: string;
  baseWorld: string;
  baseRevision: number;
  derivable: boolean;
  applyFailure?: string;
  allowedWrites: string[];
  allowedCreates: CreateTriple[];
  allowedDeletes: string[];
  withinFrozenAllowedPaths?: boolean;
  escapingLeaves?: string[];
  requiredPostconditions: unknown[];
  protectedObservations: unknown[];
  preservedWitnesses: boolean | null;
  note?: string;
}

interface Manifest {
  algorithm: string;
  files: Record<string, string>;
}

/**
 * Třída úpravy → kolik jejích kontraktů musí být odvoditelných.
 *
 * **Podlahy jsou per třída, nikdy agregát**, a `topology_rewire` s `goal_swap`
 * mají vlastní právě proto: v korpusu jich je po pěti proti třem u ostatních,
 * takže agregátní podlaha by je nechala projít i tehdy, kdyby z nich zbyl jeden.
 * Čísla jsou naměřená nad zmrazeným korpusem, ne zvolená — čtyři patche se
 * neaplikují (E06, E19, E20, E24) a podlahy to přiznávají místo aby to zakrývaly.
 */
const DERIVABLE_FLOOR: Record<string, number> = {
  param_change: 3,
  predicate_flip: 2,
  action_swap: 3,
  rule_insert: 3,
  rule_delete: 3,
  topology_rewire: 3,
  goal_swap: 4,
};

/**
 * Kontejner → třída uzlu, který v něm vzniká. Tabulka je ZDE, ne v kontraktech:
 * kdyby si kontrakt nesl vlastní `kind`, mohl by si k sobě přinést i povolení
 * a granularita by přestala být kontrolovatelná.
 */
const KIND_BY_PARENT: Record<string, string> = {
  '/sim/rules': 'rule',
  '/sim/entities': 'entity',
  '/sim/collisionAabb': 'collisionAabb',
  '/sim/sockets': 'socket',
  '/sim/state/counters': 'counter',
  '/sim/state/flags': 'flag',
  '/sim/state/timers': 'timer',
  '/sim/layout/portals': 'portal',
};

function at(doc: unknown, pointer: string): unknown {
  let node: unknown = doc;
  for (const token of pointer.split('/').slice(1)) {
    if (node === null || typeof node !== 'object') return undefined;
    node = (node as Record<string, unknown>)[token];
  }
  return node;
}

/** Nejvyšší uzel na cestě, který ve `before` neexistuje — hranice vzniku. */
function emergingNode(leafPointer: string, before: unknown): string {
  const tokens = leafPointer.split('/').slice(1);
  for (let i = 1; i <= tokens.length; i += 1) {
    const candidate = '/' + tokens.slice(0, i).join('/');
    if (at(before, candidate) === undefined) return candidate;
  }
  return leafPointer;
}

/**
 * Atomická hodnota: skalár, `null`, prázdný objekt nebo prázdné pole.
 *
 * **Nepřítomnost atomická NENÍ** a je to nosný rozdíl, ne detail. Kdyby
 * `undefined` platilo za atomickou hodnotu, prošel by kořen smazaného podstromu
 * jako „list" — po smazání totiž na té adrese není nic — a `allowedDeletes`
 * s `/sim/rules/unlock` vedle jeho šestnácti potomků by se ohlásilo jako
 * v pořádku. To je přesně to implikování potomků, které AC zakazuje. Naměřeno
 * mutací nad `E15`.
 */
function atomicAt(doc: unknown, pointer: string): boolean | null {
  const value = at(doc, pointer);
  if (value === undefined) return null;
  if (value === null || typeof value !== 'object') return true;
  return Object.keys(value as object).length === 0;
}

/** Je hodnota atomická alespoň na jedné straně, kde vůbec existuje? */
function atomicSomewhere(before: unknown, after: unknown, pointer: string): boolean {
  return atomicAt(before, pointer) === true || atomicAt(after, pointer) === true;
}

const frozenContracts = readJsonl<FrozenContract>('evals/frozen/contracts.v1.jsonl').filter((c) => c.kind === 'edit');
const frozenResponses = readJsonl<FrozenResponse>('evals/frozen/responses/index.jsonl');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest;
const authorship = readFileSync(authorshipPath, 'utf8');

const gold = new Map<string, GoldContract>(
  readdirSync(goldDir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      const parsed = JSON.parse(readFileSync(join(goldDir, f), 'utf8')) as GoldContract;
      return [parsed.id, parsed];
    }),
);

/**
 * Referenční aplikace: základní svět + zmrazený patch, a z rozdílu stavu
 * rozvinutá množina listů. **Týž výpočet, jaký používá produkční cesta**
 * (`src/patch/scope.ts`) — kdyby si tenhle test počítal dosah po svém, ověřoval
 * by shodu se svou vlastní představou, ne s tím, co systém doopravdy udělá.
 */
function reference(contract: FrozenContract) {
  const base = frozenResponses.find((r) => r.forPrompt === contract.baseWorld)!;
  const patch = frozenResponses.find((r) => r.forPrompt === contract.id)!;
  const before = JSON.parse(JSON.stringify(base.body));
  const after = JSON.parse(JSON.stringify(base.body));
  let failure: string | null = null;
  try {
    const rejected = applyPatch(after, patch.body as Operation[]).filter(Boolean);
    if (rejected.length > 0) failure = rejected.map((e) => (e as Error).message).join(' | ');
  } catch (error) {
    failure = (error as Error).message;
  }
  if (failure !== null) return { failure, before, after: null, writes: [], deletes: [], creates: [], escaping: [] };

  const leaves = changedLeafEffects(before, after, '');
  const declared = (contract.allowedPaths ?? []).map((p) => p.path);
  return {
    failure: null,
    before,
    after,
    writes: leaves.filter((l) => l.effect === 'replace').map((l) => l.path).sort(),
    deletes: leaves.filter((l) => l.effect === 'remove').map((l) => l.path).sort(),
    creates: [...new Set(leaves.filter((l) => l.effect === 'add').map((l) => emergingNode(l.path, before)))].sort(),
    escaping: leaves
      .map((l) => l.path)
      .filter((path) => !declared.some((d) => path === d || path.startsWith(d + '/')))
      .sort(),
  };
}

const references = new Map(frozenContracts.map((c) => [c.id, reference(c)]));

describe('evals/contracts — každá benchmarková úprava má gold kontrakt', () => {
  it('kontraktů je přesně tolik co zmrazených editačních promptů', () => {
    expect([...gold.keys()].sort()).toEqual(frozenContracts.map((c) => c.id).sort());
  });

  it('každý kontrakt nese všech sedm povinných polí', () => {
    for (const contract of gold.values()) {
      for (const field of [
        'baseRevision',
        'allowedWrites',
        'allowedCreates',
        'allowedDeletes',
        'requiredPostconditions',
        'protectedObservations',
        'preservedWitnesses',
      ] as const) {
        expect(contract[field], `${contract.id}: chybí ${field}`).toBeDefined();
      }
    }
  });

  it('baseRevision sedí na revizi základního světa', () => {
    for (const contract of gold.values()) {
      const base = frozenResponses.find((r) => r.forPrompt === contract.baseWorld)!;
      expect(contract.baseRevision, `${contract.id}`).toBe((base.body as { simRevision: number }).simRevision);
    }
  });

  // Podlaha na třídu, nikdy agregát — viz DERIVABLE_FLOOR.
  it('každá ze sedmi tříd má svou vlastní podlahu odvoditelných kontraktů', () => {
    for (const [editClass, floor] of Object.entries(DERIVABLE_FLOOR)) {
      const derivable = [...gold.values()].filter((c) => c.editClass === editClass && c.derivable);
      expect(derivable.length, `${editClass}: ${derivable.length} odvoditelných, podlaha ${floor}`).toBeGreaterThanOrEqual(
        floor,
      );
    }
  });

  it('žádná třída úprav nechybí', () => {
    expect([...new Set([...gold.values()].map((c) => c.editClass))].sort()).toEqual(Object.keys(DERIVABLE_FLOOR).sort());
  });
});

describe('evals/contracts — kontrola 1: kanonická atomická granularita', () => {
  // **Atomický na ALESPOŇ jedné straně, ne na té po úpravě.** Změna tvaru
  // (`condition: null` -> objekt) hýbe dvěma různými atomickými fakty: starým
  // skalárem, který přestal být hodnotou, a novými poli, která vznikla. Kdyby se
  // list posuzoval jen po úpravě, vypadl by ten první — a s ním jediný záznam
  // o tom, že se na tu adresu vůbec sáhlo. Naměřeno na `E13` a `E23`.
  it('allowedWrites nese výhradně pointery na atomickou hodnotu, nikdy na objekt ani pole', () => {
    for (const contract of gold.values()) {
      const ref = references.get(contract.id)!;
      if (!contract.derivable) continue;
      for (const pointer of contract.allowedWrites) {
        expect(
          atomicSomewhere(ref.before, ref.after, pointer),
          `${contract.id}: ${pointer} nikde nenese atomickou hodnotu`,
        ).toBe(true);
      }
    }
  });

  // **Předek je laundering jen tehdy, když je kontejnerem na OBOU stranách** —
  // tam a jen tam implikuje potomky, aniž by sám nesl hodnotu. Předek, který byl
  // skalárem a stal se objektem, popisuje vlastní atomický fakt a potomky
  // neimplikuje; zakázat i jeho by znamenalo zakázat legální změnu tvaru.
  it('žádný zápis ani smazání neimplikuje své potomky', () => {
    for (const contract of gold.values()) {
      if (!contract.derivable) continue;
      const ref = references.get(contract.id)!;
      for (const field of ['allowedWrites', 'allowedDeletes'] as const) {
        const entries = contract[field];
        for (const outer of entries) {
          // Implikuje potomky právě tehdy, když na žádné existující straně
          // nenese atomickou hodnotu — tedy je všude, kde vůbec je, kontejner.
          const impliesChildren = !atomicSomewhere(ref.before, ref.after, outer);
          for (const inner of entries) {
            if (outer === inner || !inner.startsWith(outer + '/')) continue;
            expect(impliesChildren, `${contract.id}.${field}: ${outer} implikuje ${inner}`).toBe(false);
          }
        }
      }
    }
  });

  it('allowedCreates nese trojice bez wildcardu a bez cizích klíčů', () => {
    for (const contract of gold.values()) {
      for (const triple of contract.allowedCreates) {
        expect(Object.keys(triple).sort(), `${contract.id}: trojice má cizí klíč`).toEqual([
          'kind',
          'parentId',
          'semanticRole',
        ]);
        for (const part of [triple.parentId, triple.semanticRole]) {
          expect(/[*?]/.test(part), `${contract.id}: wildcard v ${part}`).toBe(false);
        }
        expect(triple.semanticRole.includes('/'), `${contract.id}: role ukazuje hlouběji než na jeden uzel`).toBe(false);
      }
    }
  });

  it('každá trojice pojmenuje právě jeden uzel, který doopravdy vzniká', () => {
    for (const contract of gold.values()) {
      if (!contract.derivable) continue;
      const ref = references.get(contract.id)!;
      for (const triple of contract.allowedCreates) {
        const node = `${triple.parentId}/${triple.semanticRole}`;
        expect(at(ref.before, node), `${contract.id}: ${node} existoval už předtím`).toBeUndefined();
        expect(at(ref.after, node), `${contract.id}: ${node} po úpravě neexistuje`).toBeDefined();
      }
    }
  });

  it('kind trojice pochází ze zamčené tabulky kontejnerů, ne z kontraktu', () => {
    for (const contract of gold.values()) {
      for (const triple of contract.allowedCreates) {
        expect(triple.kind, `${contract.id}: ${triple.parentId}`).toBe(KIND_BY_PARENT[triple.parentId] ?? 'field');
      }
    }
  });
});

describe('evals/contracts — kontrola 2: přesná rovnost, ne podmnožina', () => {
  it('všechna tři oprávnění se rovnají tomu, co referenční aplikace doopravdy udělá', () => {
    for (const contract of gold.values()) {
      const ref = references.get(contract.id)!;
      if (!contract.derivable) continue;
      expect(contract.allowedWrites, `${contract.id}.allowedWrites`).toEqual(ref.writes);
      expect(contract.allowedDeletes, `${contract.id}.allowedDeletes`).toEqual(ref.deletes);
      expect(
        contract.allowedCreates.map((t) => `${t.parentId}/${t.semanticRole}`).sort(),
        `${contract.id}.allowedCreates`,
      ).toEqual(ref.creates);
    }
  });

  it('neodvoditelný kontrakt uvádí přesně tu chybu, na které patch padne', () => {
    for (const contract of gold.values()) {
      const ref = references.get(contract.id)!;
      if (contract.derivable) {
        expect(ref.failure, `${contract.id} se prohlašuje za odvoditelný, ale patch nejde aplikovat`).toBeNull();
        continue;
      }
      expect(ref.failure, `${contract.id} se prohlašuje za neodvoditelný, ale patch se aplikuje`).not.toBeNull();
      expect(contract.applyFailure, `${contract.id}: jiná chyba než naměřená`).toBe(ref.failure);
      expect(contract.allowedWrites).toEqual([]);
      expect(contract.allowedCreates).toEqual([]);
      expect(contract.allowedDeletes).toEqual([]);
    }
  });

  /**
   * **Tohle je ta kontrola, která není opisem.**
   *
   * Oprávnění výš se rovnají referenční aplikaci, takže je z ní lze odvodit.
   * Tenhle blok je porovnává s DRUHÝM, nezávislým zdrojem — s `allowedPaths`
   * zmrazeného popisu. Tam, kde se rozejdou, nemůže kontrakt sedět na obojí,
   * a rozpor musí být vypsaný do posledního listu, ne zaokrouhlený.
   */
  it('únik mimo zmrazené allowedPaths je deklarovaný a přesně vyjmenovaný', () => {
    for (const contract of gold.values()) {
      if (!contract.derivable) continue;
      const ref = references.get(contract.id)!;
      expect(contract.withinFrozenAllowedPaths, `${contract.id}: nedeklaruje vztah ke zmrazeným allowedPaths`).toBe(
        ref.escaping.length === 0,
      );
      expect(contract.escapingLeaves ?? [], `${contract.id}: seznam uniků nesedí`).toEqual(ref.escaping);
    }
  });

  // Naměřeno 18. 8. 2026 a shodné s tím, co si projekt zapsal nezávisle
  // (CLAUDE.md, rozpor 4b): osm záznamů, sedm z nich s verdiktem FULFILLED.
  it('uniků je právě osm a jsou to ty naměřené', () => {
    const escaping = [...gold.values()].filter((c) => c.derivable && c.withinFrozenAllowedPaths === false).map((c) => c.id);
    expect(escaping.sort()).toEqual(['E01', 'E04', 'E13', 'E14', 'E15', 'E16', 'E22', 'E23']);
  });
});

describe('evals/contracts — kontrola 3: minimalita a dostatečnost', () => {
  it('s celou množinou úprava sedí, po odebrání kterékoli položky ne', () => {
    for (const contract of gold.values()) {
      if (!contract.derivable) continue;
      const ref = references.get(contract.id)!;
      const fields = [
        { name: 'allowedWrites', mine: contract.allowedWrites, truth: ref.writes },
        { name: 'allowedDeletes', mine: contract.allowedDeletes, truth: ref.deletes },
        {
          name: 'allowedCreates',
          mine: contract.allowedCreates.map((t) => `${t.parentId}/${t.semanticRole}`).sort(),
          truth: ref.creates,
        },
      ];
      for (const field of fields) {
        expect(field.mine, `${contract.id}.${field.name}: dostatečnost`).toEqual(field.truth);
        for (let i = 0; i < field.mine.length; i += 1) {
          const reduced = field.mine.filter((_, index) => index !== i);
          expect(reduced, `${contract.id}.${field.name}: ${field.mine[i]} je nadbytečná`).not.toEqual(field.truth);
        }
      }
    }
  });
});

describe('evals/contracts — hash lock', () => {
  it('používá sha256', () => {
    expect(manifest.algorithm).toBe('sha256');
  });

  it('každý zamčený soubor existuje a jeho hash sedí', () => {
    for (const [rel, expected] of Object.entries(manifest.files)) {
      const abs = join(contractsDir, rel);
      expect(existsSync(abs), `chybí ${rel}`).toBe(true);
      expect(normalisedSha256(abs), `hash nesedí u ${rel}`).toBe(expected);
    }
  });

  it('manifest kryje každý gold kontrakt na disku', () => {
    const onDisk = listFilesRecursive(goldDir)
      .map((abs) => relative(contractsDir, abs).split(sep).join(posix.sep))
      .sort();
    expect(onDisk).toEqual(Object.keys(manifest.files).sort());
  });
});

/**
 * **Důkaz pořadím se v tomhle repozitáři vést NEDÁ, a dokument to musí říkat.**
 *
 * AC T702 ho žádá: podepsaný commit předcházející prvnímu evidovanému běhu
 * modelu. Obě půlky jsou dnes nesplnitelné a je to měřitelné, ne názor — žádný
 * commit v repu není podepsaný, a `evals/live/` nese běhy ze 14. 8. 2026, tedy
 * o čtyři dny STARŠÍ než tyhle kontrakty. Běh, který se už odehrál, nejde
 * předběhnout.
 *
 * Testy níž proto neověřují důkaz, ale **shodu dokumentu se skutečností**.
 * Jakmile se skutečnost změní — někdo začne podepisovat, nebo vznikne nový
 * korpus běhů — jde aserce červeně a `AUTHORSHIP.md` se musí přepsat. To je
 * jediná forma, ve které tvrzení o provenienci nezestárne tiše.
 */
describe('evals/contracts — provenience je vykázaná tak, jak je', () => {
  const goldCommits = (() => {
    try {
      return git('log', '--full-history', '--reverse', '--format=%H %ct %G?', '--', 'evals/contracts/gold')
        .split('\n')
        .filter(Boolean);
    } catch {
      return [];
    }
  })();

  it('dokument přiznává, že důkaz pořadím není k dispozici', () => {
    expect(authorship).toContain('orderingProof: unavailable');
  });

  it('žádný commit s kontrakty není podepsaný — a dokument to tvrdí taky', () => {
    if (goldCommits.length === 0) return;
    const signed = goldCommits.filter((line) => !line.endsWith(' N'));
    expect(signed, 'commit s kontrakty je podepsaný — AUTHORSHIP.md tvrdí opak').toEqual([]);
    expect(authorship).toContain('signedCommit: false');
  });

  it('běhy v evals/live jsou starší než kontrakty, a dokument to tvrdí taky', () => {
    if (goldCommits.length === 0) return;
    const goldFirstAt = Number(goldCommits[0].split(' ')[1]);
    const liveFirst = git('log', '--full-history', '--reverse', '--format=%ct', '--', 'evals/live')
      .split('\n')
      .filter(Boolean);
    if (liveFirst.length === 0) return;
    expect(
      Number(liveFirst[0]) < goldFirstAt,
      'běhy v evals/live už nejsou starší než kontrakty — AUTHORSHIP.md je potřeba přepsat',
    ).toBe(true);
    expect(authorship).toContain('liveRunsPredateContracts: true');
  });

  it('do gold/ nepřibyl commit po tom, který zapsal manifest', () => {
    if (goldCommits.length === 0) return;
    const manifestCommits = git('log', '--full-history', '--format=%H', '--', 'evals/contracts/MANIFEST.lock')
      .split('\n')
      .filter(Boolean);
    if (manifestCommits.length === 0) return;
    const newest = manifestCommits[0];
    const after = git('log', '--full-history', '--format=%H', `${newest}..HEAD`, '--', 'evals/contracts/gold')
      .split('\n')
      .filter(Boolean);
    expect(after, 'gold/ se změnil po zámku, aniž by se přepsal manifest').toEqual([]);
  });
});
