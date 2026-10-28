/**
 * Zapečetěná sada P63 (T1): 24 nových vět, otevře se jednou v T6. Sada, která se tiše změní, zneplatní bránu; věta
 * sdílená se sadou, na které se ladilo (P61 holdout je od 26. 10. otevřený), z brány udělá měření na tréninkových větách.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { normalizeSentence } from '../../../../scripts/play-fidelity.mjs';
import { knownSets, P63_HOLDOUT_SHA256, sha256Lf, textsOf } from '../seal';

const PLAY = join(process.cwd(), 'evals', 'play');
const DIR = join(PLAY, 'p63');
const readLf = (path: string): string => readFileSync(path, 'utf8').replace(/\r\n/g, '\n');

interface Sentence { readonly id: string; readonly family: string; readonly text: string; readonly count: number | null }
const holdout = (): Sentence[] => (JSON.parse(readLf(join(DIR, 'holdout.json'))) as { sentences: Sentence[] }).sentences;

describe('P63 sealed reading-game holdout', () => {
  it('matches its recorded SHA-256, also written in the README', () => {
    expect(sha256Lf(readLf(join(DIR, 'holdout.json')))).toBe(P63_HOLDOUT_SHA256);
    expect(readLf(join(DIR, 'README.md'))).toContain(P63_HOLDOUT_SHA256);
  });

  it('has 24 sentences, eight of each family, and every count sentence names its count', () => {
    const sentences = holdout();
    expect(sentences).toHaveLength(24);
    expect(new Set(sentences.map((s) => s.id)).size).toBe(24);
    for (const family of ['verb', 'count', 'general']) expect(sentences.filter((s) => s.family === family), family).toHaveLength(8);
    expect(sentences.filter((s) => s.family === 'count').every((s) => Number.isInteger(s.count) && s.count! > 0)).toBe(true);
  });

  it('shares no sentence with p30, p58b, p56c, p61, p62 (once merged), the P63 read set or another known set', () => {
    const own = holdout().map((s) => normalizeSentence(s.text));
    expect(new Set(own).size).toBe(own.length);
    const p56c = readdirSync(join(PLAY, 'p56c')).filter((name) => name.endsWith('.json')).map((name) => `p56c/${name}`);
    const later = ['p61/holdout.json', 'p62/holdout.json', 'p63/read-set.json'].filter((set) => existsSync(join(PLAY, set)));
    const sets = [...new Set([...knownSets(), 'p58b/holdout.json', ...p56c, ...later])].filter((set) => textsOf(set).length > 0);
    expect(sets).toEqual(expect.arrayContaining(['p30/dev.json', 'p58b/holdout.json', 'p56c/holdout.json', 'p61/holdout.json']));
    const seen = new Set(sets.flatMap((set) => textsOf(set).map((text) => normalizeSentence(text))));
    expect(own.filter((text) => seen.has(text))).toEqual([]);
  });
});
