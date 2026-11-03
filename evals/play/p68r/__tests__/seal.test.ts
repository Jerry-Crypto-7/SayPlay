/**
 * Zapečetěná sada P68R (T1): 105 nových vět a jejich slepé štítky mimo repo, otevřou se jednou v T6. Sada, která se
 * tiše změní, zneplatní verdikt; věta sdílená se sadou, na které se ladí (dev P68 a otevřený holdout P68), z verdiktu
 * udělá měření na tréninkových větách. Sada leží jen na stroji, který ji zapečetil – jinde test hlídá seznam sad.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { normalizeSentence } from '../../../../scripts/play-fidelity.mjs';
import { HOLDOUT_PATH, holdoutPresent, knownSets, LABELS_PATH, P68R_HOLDOUT_SHA256, P68R_LABELS_SHA256, sha256Lf, textsOf } from '../seal';

const DIR = join(process.cwd(), 'evals', 'play', 'p68r');
const readLf = (path: string): string => readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
const NEW = ['stunt', 'minigolf', 'railfps', 'buildshift', 'drawsave'];

interface Sentence { readonly id: string; readonly half: 'new' | 'general'; readonly genre: string; readonly game: string; readonly text: string }
interface Label { readonly id: string; readonly text: string; readonly aimed: string; readonly best: string; readonly acceptable: readonly string[] }
const sentencesOf = (path: string): Sentence[] => (JSON.parse(readLf(path)) as { sentences: Sentence[] }).sentences;

describe.skipIf(!holdoutPresent())('P68R sealed holdout (outside the repo)', () => {
  it('matches its recorded SHA-256 for the sentences and the labels, both also written in the README', () => {
    const readme = readLf(join(DIR, 'README.md'));
    expect(sha256Lf(readLf(HOLDOUT_PATH))).toBe(P68R_HOLDOUT_SHA256);
    expect(sha256Lf(readLf(LABELS_PATH))).toBe(P68R_LABELS_SHA256);
    expect(readme).toContain(P68R_HOLDOUT_SHA256);
    expect(readme).toContain(P68R_LABELS_SHA256);
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

  it('shares no sentence with the open P68 holdout, the P68 dev set or another known set', () => {
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

describe('P68R known sets', () => {
  it('include the open P68 holdout and dev set the routing is tuned on, and every set P68 knew', () => {
    expect(knownSets()).toEqual(expect.arrayContaining(['p30/dev.json', 'p30/test-200.json', 'p66/holdout.json', 'p68/dev.json', 'p68/holdout.json']));
  });
});
