import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, posix, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const frozenDir = join(repoRoot, 'evals', 'frozen');
const manifestPath = join(frozenDir, 'MANIFEST.lock');
const markerPath = join(frozenDir, 'FROZEN');
const anchorPath = join(repoRoot, 'evals', 'FROZEN_ANCHOR');

interface Manifest {
  algorithm: string;
  files: Record<string, string>;
}

interface Requirement {
  rid: string;
  layer: string;
  kind: string;
}

interface Contract {
  id: string;
  verdictCeiling: 'FULFILLED' | 'ROBUST';
  scoreAs?: 'FULFILLABLE' | 'ROBUST_ONLY';
  scoreAsReason?: string;
  requirements: Requirement[];
}

/**
 * `sceneMustBuild` platí pro každý prompt, který projde moderací (§13.4), takže
 * sám o sobě nic neodlišuje. Kontrakt, jehož jediný požadavek je tenhle, je
 * vakuózní — a musí to o sobě říct štítkem, ne mlčením.
 */
const NON_DISCRIMINATING_KINDS = new Set(['sceneMustBuild']);

/**
 * Hash se počítá nad obsahem normalizovaným na LF. Bez toho by tentýž soubor
 * dal na Windows jiný hash než na Linuxu a zmrazení by neznamenalo nic
 * ověřitelného. Repo to vynucuje i gitem (.gitattributes), tohle je druhá vrstva.
 */
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

function frozenRelativePaths(): string[] {
  return listFilesRecursive(frozenDir)
    .map((abs) => relative(frozenDir, abs).split(sep).join(posix.sep))
    .sort();
}

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).trim();
}

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest;

describe('evals/frozen — hash lock', () => {
  it('používá sha256', () => {
    expect(manifest.algorithm).toBe('sha256');
  });

  it('každý soubor v manifestu existuje a jeho hash sedí', () => {
    for (const [rel, expected] of Object.entries(manifest.files)) {
      const abs = join(frozenDir, rel);
      expect(existsSync(abs), `chybí zmrazený soubor ${rel}`).toBe(true);
      expect(normalisedSha256(abs), `hash nesedí u ${rel}`).toBe(expected);
    }
  });

  // Bez téhle kontroly by šlo do zmrazeného adresáře nepozorovaně PŘIDAT obsah:
  // hash existujících souborů by dál seděl a lock by o novém souboru mlčel.
  it('manifest kryje každý soubor uvnitř evals/frozen/', () => {
    const onDisk = frozenRelativePaths().filter((rel) => rel !== 'MANIFEST.lock');
    const covered = Object.keys(manifest.files).sort();
    expect(onDisk).toEqual(covered);
  });
});

describe('evals/frozen — žádný kontrakt neprochází mlčením', () => {
  const contracts = readFileSync(join(frozenDir, 'contracts.v1.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Contract);

  const prompts = readFileSync(join(frozenDir, 'prompts.v1.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as { id: string });

  it('každý zmrazený prompt má právě jeden kontrakt', () => {
    expect(contracts.map((c) => c.id).sort()).toEqual(prompts.map((p) => p.id).sort());
  });

  // Tohle je ta kontrola, bez které by se zabetonovala nadhodnocující metrika:
  // 42 ze 116 promptů v evals/gold.jsonl má prázdný `required` a projde čímkoli.
  it('každý kontrakt deklaruje scoreAs', () => {
    for (const c of contracts) {
      expect(c.scoreAs, `${c.id} nemá scoreAs`).toBeDefined();
      expect(['FULFILLABLE', 'ROBUST_ONLY'], `${c.id} má neznámé scoreAs`).toContain(c.scoreAs);
    }
  });

  it('ROBUST_ONLY nese odůvodnění a FULFILLABLE nese skutečný požadavek', () => {
    for (const c of contracts) {
      if (c.scoreAs === 'ROBUST_ONLY') {
        expect((c.scoreAsReason ?? '').length, `${c.id} je ROBUST_ONLY bez odůvodnění`).toBeGreaterThan(0);
        continue;
      }
      const discriminating = c.requirements.filter((r) => !NON_DISCRIMINATING_KINDS.has(r.kind));
      expect(discriminating.length, `${c.id} je FULFILLABLE, ale nemá jediný odlišující požadavek`).toBeGreaterThan(0);
    }
  });

  it('scoreAs souhlasí s verdictCeiling', () => {
    for (const c of contracts) {
      expect(c.scoreAs === 'ROBUST_ONLY', `${c.id}: scoreAs a verdictCeiling si odporují`).toBe(
        c.verdictCeiling === 'ROBUST',
      );
    }
  });

  // T16 mutuje požadavky PO JEDNOM a čeká překlopení verdiktu. Bez jedinečného
  // rid se "poruš právě tenhle jeden" nedá strojově adresovat.
  it('každé rid je v celé sadě jedinečné', () => {
    const rids = contracts.flatMap((c) => c.requirements.map((r) => r.rid));
    expect(rids.length).toBe(new Set(rids).size);
  });
});

/**
 * Historická půlka AC — ta, kterou nejde splnit přepočítáním obsahu spolu
 * s lockem, protože historie commitů se nedá přepsat bez viditelné stopy.
 *
 * **Západka, a proč vypadá takhle.** v1 měl invariant „FROZEN přidal právě
 * jeden commit" (`--diff-filter=A` + `toHaveLength(1)`). Byl monotónní: jakmile
 * marker jednou vznikl, žádná pozdější změna korpusu ho už nemohla uspokojit,
 * ani dopředu. Přemrazení na v2 ten invariant porušilo ze své podstaty — druhé
 * zmrazení marker přepíše — a první náprava ho nahradila otázkou „zapsal marker
 * ten commit, na který ukazuje kotva?". **To byl krok zpátky a review to
 * doložilo scénářem:** kotva je obyčejný soubor mimo `MANIFEST.lock`, takže
 * commit Z přepíše korpus, lock i marker a commit Z+1 přepíše kotvu na sebe —
 * celá sada zelená, nikde stopa. Přesně to praní, kterému má zmrazení bránit,
 * a po Phase 4 by šlo o ladění metriky podle výsledků.
 *
 * Západka je proto zobecněná, ne zrušená: **seznam commitů, které kdy zapsaly
 * `evals/frozen/FROZEN`, se musí přesně a v pořadí rovnat seznamu `generations`
 * v kotvě, a každá generace musí mít ANOTOVANÝ tag na svém commitu se sedícím
 * tree hashem i hashem podstromu.** Přepsat korpus jde dál — ale jen tak, že se
 * nahlásí další generace a všechny předchozí tagy zůstanou na místě s pravdivými
 * hashi. Tiché přemrazení tím není nemožné, je nepřehlédnutelné; a víc než to
 * lokální repo bez remote nabídnout neumí, jak říká sám marker.
 */
describe('evals/frozen — historie po uzavření freeze', () => {
  interface Generation {
    generation: number;
    tag: string;
    markerCommit: string;
    treeHash: string;
    frozenSubtreeHash: string;
  }

  /** Commity, které kdy zapsaly marker, nejstarší první. Prázdné = freeze nikdy nebyl uzavřen. */
  const markerCommits = git('log', '--reverse', '--format=%H', '--', 'evals/frozen/FROZEN')
    .split('\n')
    .filter(Boolean);
  const freezeEverClosed = markerCommits.length > 0;

  // Autoritou je HISTORIE, ne přítomnost souboru. Původní znění gatovalo celý
  // blok na `existsSync(anchorPath)`, takže SMAZÁNÍ kotvy z něj udělalo no-op —
  // jeden commit „smaž kotvu + přepiš korpus + přepočítej lock" byl zelený.
  // Přemrazení v2 tou dírou samo prošlo; tohle ji zavírá.
  it('kotva existuje, jakmile historie ukazuje, že FROZEN kdy vznikl', () => {
    if (!freezeEverClosed) return;
    expect(existsSync(anchorPath), 'FROZEN v historii je, ale kotva chybí — freeze byl odzbrojen').toBe(true);
  });

  it('marker FROZEN existuje, jakmile existuje kotva', () => {
    if (!existsSync(anchorPath)) return;
    expect(existsSync(markerPath), 'kotva existuje, ale marker FROZEN chybí — freeze byl rozmrazen').toBe(true);
  });

  it('řetěz generací se přesně kryje s commity, které kdy zapsaly FROZEN', () => {
    if (!freezeEverClosed) return;

    const anchor = JSON.parse(readFileSync(anchorPath, 'utf8')) as { generations?: Generation[] };
    const generations = anchor.generations ?? [];
    // Nerovnost tady znamená jedno ze dvou: buď se korpus přemrazil a nikdo to
    // nenahlásil, nebo někdo z řetězu vyškrtl generaci, aby zmizela její vada.
    expect(
      generations.map((g) => g.markerCommit),
      'seznam nahlášených generací nesouhlasí s commity, které zapsaly FROZEN',
    ).toEqual(markerCommits);
  });

  it('každá nahlášená generace má anotovaný tag se sedícími tree hashi', () => {
    if (!freezeEverClosed) return;

    const anchor = JSON.parse(readFileSync(anchorPath, 'utf8')) as { generations?: Generation[] };
    for (const g of anchor.generations ?? []) {
      // Lightweight tag by šlo přepsat bez stopy a anotace by neexistovala —
      // právě v ní je zapsaná vada té generace.
      expect(git('cat-file', '-t', g.tag), `${g.tag} není anotovaný tag`).toBe('tag');
      expect(git('rev-parse', `${g.tag}^{commit}`), `${g.tag} neukazuje na svůj markerový commit`).toBe(
        g.markerCommit,
      );
      expect(git('rev-parse', `${g.markerCommit}^{tree}`), `${g.tag}: tree hash nesedí`).toBe(g.treeHash);
      // Podvrh musí lhát na dvou místech, ne na jednom: tenhle hash kryje
      // výhradně zmrazený podstrom, takže ho nezakryje změna jinde v commitu.
      expect(git('rev-parse', `${g.markerCommit}:evals/frozen`), `${g.tag}: hash podstromu nesedí`).toBe(
        g.frozenSubtreeHash,
      );
    }
  });

  it('po markeru poslední generace se do evals/frozen/ znovu nesáhlo', () => {
    if (!freezeEverClosed) return;

    const newest = markerCommits[markerCommits.length - 1];
    expect(git('log', '-1', '--format=%H', '--', 'evals/frozen'), 'po markeru se do evals/frozen/ znovu sáhlo').toBe(
      newest,
    );
  });
});
