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

describe('evals/frozen — historie po uzavření freeze', () => {
  const freezeClosed = existsSync(anchorPath);

  it('marker FROZEN existuje, jakmile existuje kotva', () => {
    if (!freezeClosed) return;
    expect(existsSync(markerPath), 'kotva existuje, ale marker FROZEN chybí — freeze byl rozmrazen').toBe(true);
  });

  // Tohle je ta půlka AC, kterou nejde splnit přepočítáním obsahu spolu s lockem:
  // historie commitů je to, co se nedá přepsat bez viditelné stopy.
  //
  // **Autoritou je kotva, ne „právě jeden přidávající commit".** Původní znění
  // počítalo commity s `--diff-filter=A` nad markerem a trvalo na jediném — což
  // je invariant, který PŘEMRAZENÍ (T2b, evals-frozen-v2) porušuje ze své
  // podstaty: druhé zmrazení marker přepíše, ne přidá. Kontrola se proto ptá na
  // to, co doopravdy platit má — poslední commit, který sáhl do evals/frozen/,
  // je ten, který zapsal aktuální marker — a autoritu bere z `evals/FROZEN_ANCHOR`,
  // tedy ze souboru MIMO zmrazený strom. Zuby zůstávají stejné: jakýkoli pozdější
  // commit dotýkající se adresáře tenhle test shodí.
  it('žádný commit se nedotkl evals/frozen/ po commitu, který zapsal FROZEN', () => {
    if (!freezeClosed) return;

    const anchor = JSON.parse(readFileSync(anchorPath, 'utf8')) as { markerCommit: string };
    const markerCommit = git('log', '-1', '--format=%H', '--', 'evals/frozen/FROZEN');
    expect(markerCommit, 'FROZEN naposledy zapsal jiný commit, než na který ukazuje kotva').toBe(
      anchor.markerCommit,
    );

    const newestTouching = git('log', '-1', '--format=%H', '--', 'evals/frozen');
    expect(newestTouching, 'po markeru se do evals/frozen/ znovu sáhlo').toBe(anchor.markerCommit);
  });

  it('kotva ukazuje na tree hash markerového commitu i na podstrom evals/frozen', () => {
    if (!freezeClosed) return;

    const anchor = JSON.parse(readFileSync(anchorPath, 'utf8')) as {
      markerCommit: string;
      treeHash: string;
      frozenSubtreeHash: string;
      tag: string;
    };
    expect(git('rev-parse', `${anchor.markerCommit}^{tree}`)).toBe(anchor.treeHash);
    // Podvrh musí lhát na dvou místech, ne na jednom: tenhle hash kryje výhradně
    // zmrazený podstrom, takže ho nezakryje změna kdekoli jinde v commitu.
    expect(git('rev-parse', `${anchor.markerCommit}:evals/frozen`)).toBe(anchor.frozenSubtreeHash);
    expect(git('rev-parse', `${anchor.tag}^{commit}`)).toBe(anchor.markerCommit);
  });
});
