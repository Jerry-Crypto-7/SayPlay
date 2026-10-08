/**
 * Pečeť zapečetěné sady P44C (T2). Test čte jen tvar, počty a hashe – věty nevypisuje.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ACTIONS, MOVES, OBJECTIVES } from '../../../../src/play/intent/contract';
import { openSealedOnce, SEALED } from '../open-sealed';

const SEAL = 'evals/play/p44c/dataset-seal.json';
const OVERLAP_SOURCES = [
  'evals/play/p30/test-200.json',
  'evals/play/p30/dev.json',
  'evals/play/p37a/dev-150.json',
  'evals/play/p41/sentences.json',
  ...readdirSync('evals/play/p42', { recursive: true, encoding: 'utf8' })
    .filter((path) => path.replace(/\\/g, '/').endsWith('sentences.json'))
    .map((path) => `evals/play/p42/${path.replace(/\\/g, '/')}`),
  ...(existsSync('evals/play/p43/sealed-100.json') ? ['evals/play/p43/sealed-100.json'] : []),
];

interface Row {
  readonly id: string;
  readonly sentence: string;
  readonly tags: readonly string[];
  readonly essential: readonly { actor: string; verb: string; object: string | null; said?: string }[];
  readonly unsupported: boolean;
  readonly said?: string;
}

/** CRLF → LF před hashem: pečeť nezávisí na tom, jak git soubor vybalil (poučení P42 round6). */
const sealHash = (bytes: Buffer) => createHash('sha256').update(bytes.toString('utf8').replace(/\r\n/g, '\n')).digest('hex');
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const normalizeSentence = (s: string) => s.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const CANONICAL = new Set<string>([...MOVES, ...ACTIONS, ...OBJECTIVES]);

function stringLeaves(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const v of value) stringLeaves(v, out);
  else if (value && typeof value === 'object') for (const v of Object.values(value)) stringLeaves(v, out);
  return out;
}

const bytes = readFileSync(SEALED);
const seal = JSON.parse(readFileSync(SEAL, 'utf8')) as { sha256: string; count: number; tagCounts: Record<string, number> };
const rows = (JSON.parse(bytes.toString('utf8')) as { groups: { sealed: Row[] } }).groups.sealed;

describe('P44C sealed open-vocabulary set', () => {
  it('matches its seal over LF bytes', () => {
    expect(sealHash(bytes)).toBe(seal.sha256);
    expect(readFileSync('evals/play/p44c/README.md', 'utf8')).toContain(seal.sha256);
  });

  it('has the required groups and label shape', () => {
    const counts: Record<string, number> = {};
    for (const row of rows) for (const tag of row.tags) counts[tag] = (counts[tag] ?? 0) + 1;
    expect(rows.length).toBeGreaterThanOrEqual(110);
    expect(rows).toHaveLength(seal.count);
    expect(counts).toEqual(seal.tagCounts);
    expect(counts['unknown-verb']).toBeGreaterThanOrEqual(50);
    expect(counts.fantasy).toBeGreaterThanOrEqual(30);
    expect(counts['non-game']).toBeGreaterThanOrEqual(15);
    expect(counts.control).toBeGreaterThanOrEqual(10);
    for (const row of rows) {
      for (const triple of row.essential) expect(CANONICAL.has(triple.verb), row.id).toBe(true);
      if (row.tags.includes('unknown-verb')) expect(row.essential.some((t) => typeof t.said === 'string' && t.said !== t.verb), row.id).toBe(true);
      if (row.tags.includes('non-game')) expect(row.essential.length === 0 && row.unsupported && typeof row.said === 'string', row.id).toBe(true);
    }
  });

  it('shares no normalized sentence with the open sets or with itself', () => {
    const own = rows.map((row) => sha256(normalizeSentence(row.sentence)));
    expect(new Set(own).size).toBe(own.length);
    const earlier = new Set<string>();
    for (const path of OVERLAP_SOURCES) for (const s of stringLeaves(JSON.parse(readFileSync(path, 'utf8')))) earlier.add(sha256(normalizeSentence(s)));
    expect(rows.filter((_, i) => earlier.has(own[i]!)).map((row) => row.id)).toEqual([]);
  });

  it('opens only with --open-sealed-once, and only once', () => {
    const dir = mkdtempSync(join(tmpdir(), 'p44c-seal-'));
    const paths = { sealed: join(dir, 'set.json'), opened: join(dir, 'opened.json') };
    writeFileSync(paths.sealed, '{"groups":{"sealed":[]}}\n');
    expect(() => openSealedOnce([], paths)).toThrow(/--open-sealed-once/);
    expect(existsSync(paths.opened)).toBe(false);
    expect(openSealedOnce(['--open-sealed-once'], paths)).toEqual({ groups: { sealed: [] } });
    expect(statSync(paths.opened).isFile()).toBe(true);
    expect(() => openSealedOnce(['--open-sealed-once'], paths)).toThrow();
  });
});
