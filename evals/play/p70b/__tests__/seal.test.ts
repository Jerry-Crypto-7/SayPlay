/**
 * Zapečetěná sada P70B (T1): 70 nových vět a jejich slepé štítky mimo repo, otevřou se jednou v T5. Sada, která se
 * tiše změní, zneplatní verdikt; věta sdílená se sadou, na které se ladí (věty auditu `dev.json`, otevřená P68T
 * a všechny dřívější), z verdiktu udělá měření na tréninkových větách. Sada leží jen na stroji, který ji zapečetil –
 * jinde test hlídá seznam sad a dev sadu.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import rigged from '../../../../src/assets/rigged.json';
import riggedP32 from '../../../../src/assets/rigged-p32.json';
import riggedP54 from '../../../../src/assets/rigged-p54.json';
import { normalizeSentence } from '../../../../scripts/play-fidelity.mjs';
import { ANIMAL_COUNTS, ANIMALS, GENERAL_COUNTS, HOLDOUT_PATH, holdoutPresent, knownSets, LABELS_PATH, P70B_HOLDOUT_SHA256, P70B_LABELS_SHA256, sha256Lf, textsOf } from '../seal';

const DIR = join(process.cwd(), 'evals', 'play', 'p70b');
const readLf = (path: string): string => readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
/** Žánry P68 – obecná třetina je jen ze starších. */
const P68_GAMES = ['stunt', 'minigolf', 'railfps', 'buildshift', 'drawsave'];

interface Sentence { readonly id: string; readonly half: 'animal' | 'golf' | 'general'; readonly genre: string; readonly hero?: string; readonly heroModels?: readonly string[]; readonly text: string }
interface Label { readonly id: string; readonly text: string; readonly aimed: string; readonly hero?: string; readonly heroModels?: readonly string[]; readonly best: string; readonly acceptable: readonly string[] }
const sentencesOf = (path: string): Sentence[] => (JSON.parse(readLf(path)) as { sentences: Sentence[] }).sentences;

describe.skipIf(!holdoutPresent())('P70B sealed holdout (outside the repo)', () => {
  it('matches its recorded SHA-256 for the sentences and the labels, both also written in the README', () => {
    const readme = readLf(join(DIR, 'README.md'));
    expect(sha256Lf(readLf(HOLDOUT_PATH))).toBe(P70B_HOLDOUT_SHA256);
    expect(sha256Lf(readLf(LABELS_PATH))).toBe(P70B_LABELS_SHA256);
    expect(readme).toContain(P70B_HOLDOUT_SHA256);
    expect(readme).toContain(P70B_LABELS_SHA256);
  });

  it('has 70 sentences: 30 with an animal hero over 15 rigged kinds, 20 golf, 20 general over 14 genres before P68', () => {
    const sentences = sentencesOf(HOLDOUT_PATH);
    expect(sentences).toHaveLength(70);
    expect(new Set(sentences.map((s) => s.id)).size).toBe(70);
    const animals = sentences.filter((s) => s.half === 'animal');
    const golf = sentences.filter((s) => s.half === 'golf');
    const general = sentences.filter((s) => s.half === 'general');
    expect([animals.length, golf.length, general.length]).toEqual([30, 20, 20]);
    for (const [animal, count] of Object.entries(ANIMAL_COUNTS)) {
      const own = animals.filter((s) => s.hero === animal);
      expect(own, animal).toHaveLength(count);
      for (const s of own) expect(s.heroModels, s.id).toEqual(ANIMALS[animal]);
    }
    expect(new Set(animals.map((s) => s.hero)).size).toBeGreaterThanOrEqual(12);
    expect(golf.every((s) => s.genre === 'minigolf' && s.hero === undefined)).toBe(true);
    for (const [genre, count] of Object.entries(GENERAL_COUNTS)) expect(general.filter((s) => s.genre === genre), genre).toHaveLength(count);
    expect(general.every((s) => !P68_GAMES.includes(s.genre) && s.hero === undefined)).toBe(true);
    expect(new Set(general.map((s) => s.genre)).size).toBeGreaterThanOrEqual(8);
  });

  it('shares no sentence with the audit sentences, the open P68T set or another known set', () => {
    const own = sentencesOf(HOLDOUT_PATH).map((s) => normalizeSentence(s.text));
    expect(new Set(own).size).toBe(own.length);
    const seen = new Set(knownSets().flatMap((set) => textsOf(set).map((text) => normalizeSentence(text))));
    expect(own.filter((text) => seen.has(text))).toEqual([]);
  });

  it('labels every sentence once, aimed at its game, with the same hero, and a best type among 1-3 acceptable ones', () => {
    const sentences = sentencesOf(HOLDOUT_PATH);
    const labels = (JSON.parse(readLf(LABELS_PATH)) as { sentences: Label[] }).sentences;
    expect(labels.map((l) => [l.id, l.text, l.aimed, l.hero, l.heroModels])).toEqual(sentences.map((s) => [s.id, s.text, s.genre, s.hero, s.heroModels]));
    for (const label of labels) {
      expect(label.acceptable.length, label.id).toBeGreaterThanOrEqual(label.best === 'none' ? 0 : 1);
      expect(label.acceptable.length, label.id).toBeLessThanOrEqual(3);
      if (label.best !== 'none') expect(label.acceptable, label.id).toContain(label.best);
    }
  });
});

describe('P70B known sets and hero models', () => {
  it('include the audit sentences, the open P68T set and every set P68T knew', () => {
    expect(knownSets()).toEqual(expect.arrayContaining(['p30/dev.json', 'p30/test-200.json', 'p68/dev.json', 'p68/holdout.json', 'p68r/holdout.json', 'p68t/holdout.json', 'p70b/dev.json']));
    expect(textsOf('p70b/dev.json')).toHaveLength(40);
  });

  it('count only rigged characters tagged with the animal as that animal', () => {
    const tags = new Map([...rigged.characters, ...riggedP32.characters, ...riggedP54.characters].map((c) => [`rigged:${c.id}`, c.tags as readonly string[]]));
    const kin: Record<string, readonly string[]> = { rabbit: ['rabbit', 'bunny'], 'polar bear': ['polar-bear'], deer: ['deer', 'stag'] };
    for (const [animal, models] of Object.entries(ANIMALS)) {
      for (const model of models) expect(tags.get(model)?.some((tag) => (kin[animal] ?? [animal]).includes(tag)), model).toBe(true);
    }
  });
});
