/**
 * Zapečetěná sada P68 (T1): 105 nových vět mimo repo, otevře se jednou v T15. Sada, která se tiše změní, zneplatní
 * bránu; věta sdílená se sadou, na které se ladilo, z brány udělá měření na tréninkových větách. Sada leží jen na
 * stroji, který ji zapečetil – kde chybí, hlídá test jen dev sadu (ta je v repu a kategorie na ní smějí ladit).
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { normalizeSentence } from '../../../../scripts/play-fidelity.mjs';
import { HOLDOUT_PATH, holdoutPresent, knownSets, P68_HOLDOUT_SHA256, sha256Lf, textsOf } from '../seal';

const DIR = join(process.cwd(), 'evals', 'play', 'p68');
const readLf = (path: string): string => readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
const NEW = ['stunt', 'minigolf', 'railfps', 'buildshift', 'drawsave'];

interface Sentence { readonly id: string; readonly half?: 'new' | 'general'; readonly genre: string; readonly game?: string; readonly text: string }
const sentencesOf = (path: string): Sentence[] => (JSON.parse(readLf(path)) as { sentences: Sentence[] }).sentences;
const seenIn = (sets: readonly string[]): Set<string> => new Set(sets.flatMap((set) => textsOf(set).map((text) => normalizeSentence(text))));

describe.skipIf(!holdoutPresent())('P68 sealed holdout (outside the repo)', () => {
  it('matches its recorded SHA-256, also written in the README', () => {
    expect(sha256Lf(readLf(HOLDOUT_PATH))).toBe(P68_HOLDOUT_SHA256);
    expect(readLf(join(DIR, 'README.md'))).toContain(P68_HOLDOUT_SHA256);
  });

  it('has 105 sentences: 15 aimed at each new game and 30 general ones over at least 10 current genres', () => {
    const sentences = sentencesOf(HOLDOUT_PATH);
    expect(sentences).toHaveLength(105);
    expect(new Set(sentences.map((s) => s.id)).size).toBe(105);
    const fresh = sentences.filter((s) => s.half === 'new');
    const general = sentences.filter((s) => s.half === 'general');
    expect([fresh.length, general.length]).toEqual([75, 30]);
    for (const game of NEW) expect(fresh.filter((s) => s.genre === game && s.game === game), game).toHaveLength(15);
    expect(general.every((s) => !NEW.includes(s.genre))).toBe(true);
    expect(new Set(general.map((s) => s.genre)).size).toBeGreaterThanOrEqual(10);
  });

  it('shares no sentence with the P68 dev set, P66 dev and holdout, or another known set', () => {
    const own = sentencesOf(HOLDOUT_PATH).map((s) => normalizeSentence(s.text));
    expect(new Set(own).size).toBe(own.length);
    const seen = seenIn(knownSets());
    expect(own.filter((text) => seen.has(text))).toEqual([]);
  });
});

describe('P68 dev set', () => {
  it('knows every set tuned on so far, including P66 and its own dev set', () => {
    expect(knownSets()).toEqual(expect.arrayContaining(['p30/dev.json', 'p58b/holdout.json', 'p63/read-set.json', 'p66/dev.json', 'p66/holdout.json', 'p68/dev.json']));
  });

  it('has 40 new sentences, eight per new game, none repeated and none from a known set', () => {
    const dev = sentencesOf(join(DIR, 'dev.json'));
    expect(dev).toHaveLength(40);
    for (const game of NEW) expect(dev.filter((s) => s.genre === game), game).toHaveLength(8);
    const own = dev.map((s) => normalizeSentence(s.text));
    expect(new Set(own).size).toBe(40);
    const seen = seenIn(knownSets().filter((set) => set !== 'p68/dev.json'));
    expect(own.filter((text) => seen.has(text))).toEqual([]);
  });
});
