/**
 * Zapečetěná sada P68T (T1): 90 nových vět a jejich slepé štítky mimo repo, otevřou se jednou v T3. Sada, která se
 * tiše změní, zneplatní verdikt; věta sdílená se sadou, na které se ladí (dev a holdout P68, otevřená P68R), z verdiktu
 * udělá měření na tréninkových větách. Sada leží jen na stroji, který ji zapečetil – jinde test hlídá seznam sad.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { normalizeSentence } from '../../../../scripts/play-fidelity.mjs';
import { HOLDOUT_PATH, holdoutPresent, knownSets, LABELS_PATH, P68T_HOLDOUT_SHA256, P68T_LABELS_SHA256, sha256Lf, textsOf } from '../seal';

const DIR = join(process.cwd(), 'evals', 'play', 'p68t');
const readLf = (path: string): string => readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
const GAMES = ['railfps', 'buildshift', 'drawsave', 'minigolf'];
const NEW = ['stunt', ...GAMES];

interface Sentence { readonly id: string; readonly half: 'new' | 'general'; readonly genre: string; readonly game: string; readonly text: string }
interface Label { readonly id: string; readonly text: string; readonly aimed: string; readonly best: string; readonly acceptable: readonly string[] }
const sentencesOf = (path: string): Sentence[] => (JSON.parse(readLf(path)) as { sentences: Sentence[] }).sentences;

describe.skipIf(!holdoutPresent())('P68T sealed holdout (outside the repo)', () => {
  it('matches its recorded SHA-256 for the sentences and the labels, both also written in the README', () => {
    const readme = readLf(join(DIR, 'README.md'));
    expect(sha256Lf(readLf(HOLDOUT_PATH))).toBe(P68T_HOLDOUT_SHA256);
    expect(sha256Lf(readLf(LABELS_PATH))).toBe(P68T_LABELS_SHA256);
    expect(readme).toContain(P68T_HOLDOUT_SHA256);
    expect(readme).toContain(P68T_LABELS_SHA256);
  });

  it('has 90 sentences: 15 aimed at each of railfps, buildshift, drawsave and minigolf, 30 general over at least 10 current genres', () => {
    const sentences = sentencesOf(HOLDOUT_PATH);
    expect(sentences).toHaveLength(90);
    expect(new Set(sentences.map((s) => s.id)).size).toBe(90);
    const fresh = sentences.filter((s) => s.half === 'new');
    const general = sentences.filter((s) => s.half === 'general');
    expect([fresh.length, general.length]).toEqual([60, 30]);
    for (const game of GAMES) expect(fresh.filter((s) => s.genre === game && s.game === game), game).toHaveLength(15);
    expect(general.every((s) => !NEW.includes(s.genre))).toBe(true);
    expect(new Set(general.map((s) => s.genre)).size).toBeGreaterThanOrEqual(10);
  });

  it('shares no sentence with the open P68R set, the P68 holdout and dev set or another known set', () => {
    const own = sentencesOf(HOLDOUT_PATH).map((s) => normalizeSentence(s.text));
    expect(new Set(own).size).toBe(own.length);
    const seen = new Set(knownSets().flatMap((set) => textsOf(set).map((text) => normalizeSentence(text))));
    expect(own.filter((text) => seen.has(text))).toEqual([]);
  });

  it('labels every sentence once, aimed at the game it was written for, with a best type among 1-3 acceptable ones', () => {
    const sentences = sentencesOf(HOLDOUT_PATH);
    const labels = (JSON.parse(readLf(LABELS_PATH)) as { sentences: Label[] }).sentences;
    expect(labels.map((l) => [l.id, l.text, l.aimed])).toEqual(sentences.map((s) => [s.id, s.text, s.genre]));
    for (const label of labels) {
      expect(label.acceptable.length, label.id).toBeGreaterThanOrEqual(label.best === 'none' ? 0 : 1);
      expect(label.acceptable.length, label.id).toBeLessThanOrEqual(3);
      if (label.best !== 'none') expect(label.acceptable, label.id).toContain(label.best);
    }
  });
});

describe('P68T known sets', () => {
  it('include the open P68R set and every set P68R knew, the P68 holdout and dev set among them', () => {
    expect(knownSets()).toEqual(expect.arrayContaining(['p30/dev.json', 'p30/test-200.json', 'p66/holdout.json', 'p68/dev.json', 'p68/holdout.json', 'p68r/holdout.json']));
  });
});
