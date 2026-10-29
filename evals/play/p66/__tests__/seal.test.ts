/**
 * Zapečetěná sada P66 (T1): 30 nových vět, otevře se jednou v T16. Sada, která se tiše změní, zneplatní bránu; věta
 * sdílená se sadou, na které se ladilo (P66 dev, P30 dev, otevřené sady P56C–P63), z brány udělá měření na tréninkových
 * větách. Dev sada P66 je taky nová: nesdílí větu s žádnou známou sadou kromě sebe.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { normalizeSentence } from '../../../../scripts/play-fidelity.mjs';
import { knownSets, P66_HOLDOUT_SHA256, sha256Lf, textsOf } from '../seal';

const DIR = join(process.cwd(), 'evals', 'play', 'p66');
const readLf = (path: string): string => readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
const NEW = ['survivor', 'hole', 'steal', 'sort', 'arrows'];

interface Sentence { readonly id: string; readonly half?: 'new' | 'general'; readonly genre: string; readonly text: string }
const setOf = (name: string): Sentence[] => (JSON.parse(readLf(join(DIR, name))) as { sentences: Sentence[] }).sentences;
const seenIn = (sets: readonly string[]): Set<string> => new Set(sets.flatMap((set) => textsOf(set).map((text) => normalizeSentence(text))));

describe('P66 sealed new-genre holdout', () => {
  it('matches its recorded SHA-256, also written in the README', () => {
    expect(sha256Lf(readLf(join(DIR, 'holdout.json')))).toBe(P66_HOLDOUT_SHA256);
    expect(readLf(join(DIR, 'README.md'))).toContain(P66_HOLDOUT_SHA256);
  });

  it('has 30 sentences: three aimed at each new genre and 15 general ones over at least 10 current genres', () => {
    const sentences = setOf('holdout.json');
    expect(sentences).toHaveLength(30);
    expect(new Set(sentences.map((s) => s.id)).size).toBe(30);
    const fresh = sentences.filter((s) => s.half === 'new');
    const general = sentences.filter((s) => s.half === 'general');
    expect([fresh.length, general.length]).toEqual([15, 15]);
    for (const genre of NEW) expect(fresh.filter((s) => s.genre === genre), genre).toHaveLength(3);
    expect(general.every((s) => !NEW.includes(s.genre))).toBe(true);
    expect(new Set(general.map((s) => s.genre)).size).toBeGreaterThanOrEqual(10);
  });

  it('shares no sentence with P30, P56C, P58B, P61–P64, the P66 dev set or another known set', () => {
    const own = setOf('holdout.json').map((s) => normalizeSentence(s.text));
    expect(new Set(own).size).toBe(own.length);
    const sets = knownSets();
    expect(sets).toEqual(expect.arrayContaining(['p30/dev.json', 'p30/test-200.json', 'p56c/holdout.json', 'p58b/holdout.json', 'p61/holdout.json', 'p62/holdout-b.json', 'p63/read-set.json', 'p66/dev.json']));
    const seen = seenIn(sets);
    expect(own.filter((text) => seen.has(text))).toEqual([]);
  });

  it('dev set: 20 new sentences, four per new genre, none from a known set', () => {
    const dev = setOf('dev.json');
    expect(dev).toHaveLength(20);
    for (const genre of NEW) expect(dev.filter((s) => s.genre === genre), genre).toHaveLength(4);
    const seen = seenIn(knownSets().filter((set) => set !== 'p66/dev.json'));
    expect(dev.map((s) => normalizeSentence(s.text)).filter((text) => seen.has(text))).toEqual([]);
  });
});
