/**
 * Pečeť zapečetěné sady P42 round7 (P44A T2).
 *
 * Číslo kola je jediné rozhodovací číslo P42, takže se hlídá, že sada je přesně ta zapečetěná:
 * SHA-256 z LF bajtů na disku i z blobu v gitu, skupiny ve stejném poměru jako round6, žádná
 * věta shodná (po normalizaci) s dřívějšími sadami a žádná věta round7 v `src/`.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ACTIONS, MOVES, OBJECTIVES, THREATS } from '../../../../src/play/intent/contract';

const ROUND7 = 'evals/play/p42/round7/sentences.json';
const SEAL = 'evals/play/p42/round7/dataset-seal.json';
const OVERLAP_SOURCES = [
  'evals/play/p42/sentences.json',
  'evals/play/p42/round2/sentences.json',
  'evals/play/p42/round3/sentences.json',
  'evals/play/p42/round4/sentences.json',
  'evals/play/p42/round5/sentences.json',
  'evals/play/p42/round6/sentences.json',
  'evals/play/p42/development.json',
  'evals/play/p30/dev.json',
  'evals/play/p30/test-200.json',
  'evals/play/p41/sentences.json',
];

interface Row {
  readonly id: string;
  readonly kind: string;
  readonly sentence: string;
  readonly hero: string | null;
  readonly essential: readonly { actor: string; verb: string; object: string | null }[];
  readonly unsupported: boolean;
}

const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const normalizeSentence = (s: string) =>
  s.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

function stringLeaves(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const v of value) stringLeaves(v, out);
  else if (value && typeof value === 'object') for (const v of Object.values(value)) stringLeaves(v, out);
  return out;
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sourceFiles(path, out);
    else if (/\.(ts|tsx|json|mjs|js)$/.test(name)) out.push(path);
  }
  return out;
}

const axesOf = (verb: string) =>
  new Set(
    [
      (MOVES as readonly string[]).includes(verb) && 'move',
      (ACTIONS as readonly string[]).includes(verb) && 'action',
      (OBJECTIVES as readonly string[]).includes(verb) && 'objective',
      (THREATS as readonly string[]).includes(verb) && 'threat',
    ].filter(Boolean),
  );

const bytes = readFileSync(ROUND7);
const seal = JSON.parse(readFileSync(SEAL, 'utf8'));
const rows: Row[] = JSON.parse(bytes.toString('utf8')).groups['held-out'];

describe('P42 round7 sealed sentence set', () => {
  it('matches its seal byte for byte on disk, LF only', () => {
    expect(bytes.includes(0x0d)).toBe(false);
    expect(seal.bytes).toBe(bytes.length);
    expect(sha256(bytes)).toBe(seal.sha256);
  });

  it('matches its seal as the blob git stores', () => {
    const blob = execFileSync('git', ['--no-replace-objects', 'show', `:${ROUND7}`], { maxBuffer: 1 << 24 });
    expect(sha256(blob)).toBe(seal.sha256);
  });

  it('keeps the round6 group ratios and two-axis multi-action rows', () => {
    const round6 = JSON.parse(readFileSync('evals/play/p42/round6/dataset-seal.json', 'utf8'));
    const counts: Record<string, number> = {};
    for (const r of rows) counts[r.kind] = (counts[r.kind] ?? 0) + 1;
    expect(counts).toEqual(round6.kindCounts);
    expect(seal.kindCounts).toEqual(round6.kindCounts);
    expect(rows).toHaveLength(seal.count);
    // `collect` sedí na ose akce i cíle, takže stačí, když se dvě hrdinovy položky dají přečíst na různých osách.
    const twoAxis = rows.filter((r) => {
      if (r.kind !== 'multi-action') return false;
      const hero = r.essential.filter((e) => e.actor === r.hero);
      return hero.some((a, i) => hero.some((b, j) => j > i && a.verb !== b.verb && [...axesOf(a.verb)].some((x) => [...axesOf(b.verb)].some((y) => x !== y))));
    });
    expect(twoAxis.length).toBeGreaterThanOrEqual(22);
  });

  it('shares no normalized sentence with any earlier set or with itself', () => {
    const own = rows.map((r) => sha256(normalizeSentence(r.sentence)));
    expect(new Set(own).size).toBe(own.length);
    const earlier = new Set<string>();
    for (const path of OVERLAP_SOURCES) {
      expect(existsSync(path), path).toBe(true);
      for (const s of stringLeaves(JSON.parse(readFileSync(path, 'utf8')))) earlier.add(sha256(normalizeSentence(s)));
    }
    const leaked = rows.filter((r, i) => earlier.has(own[i])).map((r) => r.id);
    expect(leaked).toEqual([]);
  });

  it('never appears in src/', () => {
    const needles = rows.map((r) => ({ id: r.id, text: r.sentence.toLowerCase() }));
    const hits: string[] = [];
    for (const file of sourceFiles('src')) {
      const text = readFileSync(file, 'utf8').toLowerCase();
      for (const n of needles) if (text.includes(n.text)) hits.push(`${n.id} in ${file}`);
    }
    expect(hits).toEqual([]);
  });
});
