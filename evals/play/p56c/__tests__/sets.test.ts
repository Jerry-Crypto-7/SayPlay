/**
 * Sady vět P56C (T2): dev (40) a zapečetěný holdout (40) nezávislého autora, oba ve čtyřech rodinách. Holdout hlídá
 * otisk; kromě tohoto testu ho do konečného měření (T14) nic nečte a test na výstup dává jen id. Průnik s dřívějšími
 * sadami (p30, p54c, p55) nebo s dev by z měření udělal měření na větách, na kterých se ladilo.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { normalizeSentence } from '../../../../scripts/play-fidelity.mjs';
import { P56C_FAMILY_COUNTS, P56C_HOLDOUT_SHA256, sha256Lf } from '../seal';

const PLAY = join(process.cwd(), 'evals', 'play');
const DIR = join(PLAY, 'p56c');
const readLf = (path: string): string => readFileSync(path, 'utf8').replace(/\r\n/g, '\n');

interface Sentence { readonly id: string; readonly family: string; readonly text: string }
const setOf = (name: 'dev' | 'holdout'): Sentence[] => (JSON.parse(readLf(join(DIR, `${name}.json`))) as { sentences: Sentence[] }).sentences;

const countBy = <T>(list: readonly T[], key: (item: T) => string): Record<string, number> => {
  const counts: Record<string, number> = {};
  for (const item of list) counts[key(item)] = (counts[key(item)] ?? 0) + 1;
  return counts;
};

/** Každý řetězec kdekoli v JSON – sady i výsledky měření nesou věty pod různými klíči. */
function stringsIn(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const item of value) stringsIn(item, out);
  else if (value !== null && typeof value === 'object') for (const item of Object.values(value)) stringsIn(item, out);
  return out;
}

const jsonFiles = (dir: string, recursive: boolean): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return recursive ? jsonFiles(path, true) : [];
    return entry.name.endsWith('.json') ? [path] : [];
  });

const earlierFiles = (): string[] => [...jsonFiles(join(PLAY, 'p30'), true), ...jsonFiles(join(PLAY, 'p54c'), false), ...jsonFiles(join(PLAY, 'p55'), false)];

describe('P56C sentence sets', () => {
  it('seals the holdout with the SHA-256 written in the README', () => {
    expect(sha256Lf(readLf(join(DIR, 'holdout.json')))).toBe(P56C_HOLDOUT_SHA256);
    expect(readLf(join(DIR, 'README.md'))).toContain(P56C_HOLDOUT_SHA256);
  });

  it.each(['dev', 'holdout'] as const)('%s has 40 sentences in the planned family shares', (name) => {
    const sentences = setOf(name);
    expect(sentences).toHaveLength(40);
    expect(countBy(sentences, (s) => s.family)).toEqual(P56C_FAMILY_COUNTS);
    expect(new Set(sentences.map((s) => s.id)).size).toBe(40);
  });

  it('shares no sentence with p30, p54c, p55, with each other, nor within a set', () => {
    const earlier = new Set(earlierFiles().flatMap((path) => stringsIn(JSON.parse(readLf(path)))).map(normalizeSentence));
    // Kontrola sama kolizi pozná: věta p55 holdoutu se přepisem velikosti a interpunkce neschová.
    const probe = (JSON.parse(readLf(join(PLAY, 'p55', 'holdout.json'))) as { sentences: { text: string }[] }).sentences[0]!.text;
    expect(earlier.has(normalizeSentence(`${probe.toUpperCase()}!`))).toBe(true);
    expect(earlierFiles().some((path) => path.includes(join('p30', 'test-200.json')))).toBe(true);

    const dev = setOf('dev');
    const holdout = setOf('holdout');
    // Jen id, ne věta: holdout se do výstupu testu nedostane.
    expect([...dev, ...holdout].filter((s) => earlier.has(normalizeSentence(s.text))).map((s) => s.id)).toEqual([]);
    const devTexts = new Set(dev.map((s) => normalizeSentence(s.text)));
    expect(holdout.filter((s) => devTexts.has(normalizeSentence(s.text))).map((s) => s.id)).toEqual([]);
    expect(devTexts.size).toBe(dev.length);
    expect(new Set(holdout.map((s) => normalizeSentence(s.text))).size).toBe(holdout.length);
  });

  it('opens the holdout only through the once-only seal', () => {
    const measure = readLf(join(DIR, 'holdout.measure.ts'));
    expect(measure).toContain('openSealedOnce(DIR, P56C_HOLDOUT_SHA256');
    // Žádné čtení holdoutu kolem pečeti.
    expect(measure).not.toMatch(/readFileSync\([^)]*holdout\.json/);
  });
});
