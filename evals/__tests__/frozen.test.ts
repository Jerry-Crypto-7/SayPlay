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

describe('evals/frozen — historie po uzavření freeze', () => {
  const freezeClosed = existsSync(anchorPath);

  it('marker FROZEN existuje, jakmile existuje kotva', () => {
    if (!freezeClosed) return;
    expect(existsSync(markerPath), 'kotva existuje, ale marker FROZEN chybí — freeze byl rozmrazen').toBe(true);
  });

  // Tohle je ta půlka AC, kterou nejde splnit přepočítáním obsahu spolu s lockem:
  // historie commitů je to, co se nedá přepsat bez viditelné stopy.
  it('žádný commit se nedotkl evals/frozen/ po commitu, který přidal FROZEN', () => {
    if (!freezeClosed) return;

    const markerCommits = git('log', '--diff-filter=A', '--format=%H', '--', 'evals/frozen/FROZEN')
      .split('\n')
      .filter(Boolean);
    expect(markerCommits, 'FROZEN musí být přidán právě jedním commitem').toHaveLength(1);

    const newestTouching = git('log', '-1', '--format=%H', '--', 'evals/frozen').split('\n')[0];
    expect(newestTouching, 'po markeru se do evals/frozen/ znovu sáhlo').toBe(markerCommits[0]);
  });

  it('kotva ukazuje na tree hash markerového commitu', () => {
    if (!freezeClosed) return;

    const anchor = JSON.parse(readFileSync(anchorPath, 'utf8')) as {
      markerCommit: string;
      treeHash: string;
      tag: string;
    };
    expect(git('rev-parse', `${anchor.markerCommit}^{tree}`)).toBe(anchor.treeHash);
    expect(git('rev-parse', `${anchor.tag}^{commit}`)).toBe(anchor.markerCommit);
  });
});
