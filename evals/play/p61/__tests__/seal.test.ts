/**
 * Zapečetěná sada P61 (T1): 24 nových vět, otevře se jednou v T8. Sada, která se tiše změní, zneplatní bránu; věta
 * sdílená se sadou, na které se ladilo, z brány udělá měření na tréninkových větách.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { normalizeSentence } from '../../../../scripts/play-fidelity.mjs';
import { knownSets, P61_HOLDOUT_SHA256, sha256Lf, textsOf } from '../seal';

const PLAY = join(process.cwd(), 'evals', 'play');
const DIR = join(PLAY, 'p61');
const readLf = (path: string): string => readFileSync(path, 'utf8').replace(/\r\n/g, '\n');

interface Sentence { readonly id: string; readonly family: string; readonly text: string }
const holdout = (): Sentence[] => (JSON.parse(readLf(join(DIR, 'holdout.json'))) as { sentences: Sentence[] }).sentences;

describe('P61 sealed quality holdout', () => {
  it('matches its recorded SHA-256, also written in the README', () => {
    expect(sha256Lf(readLf(join(DIR, 'holdout.json')))).toBe(P61_HOLDOUT_SHA256);
    expect(readLf(join(DIR, 'README.md'))).toContain(P61_HOLDOUT_SHA256);
  });

  it('has 24 sentences, six of each family', () => {
    const sentences = holdout();
    expect(sentences).toHaveLength(24);
    expect(new Set(sentences.map((s) => s.id)).size).toBe(24);
    for (const family of ['shooter', 'collect', 'multi', 'other']) expect(sentences.filter((s) => s.family === family), family).toHaveLength(6);
  });

  it('shares no sentence with p30, p58b/holdout.json, p56c or another known set, nor within itself', () => {
    const own = holdout().map((s) => normalizeSentence(s.text));
    expect(new Set(own).size).toBe(own.length);
    const p56c = readdirSync(join(PLAY, 'p56c')).filter((name) => name.endsWith('.json')).map((name) => `p56c/${name}`);
    const sets = [...new Set([...knownSets(), 'p58b/holdout.json', ...p56c])].filter((set) => textsOf(set).length > 0);
    expect(sets).toEqual(expect.arrayContaining(['p30/dev.json', 'p58b/holdout.json', 'p56c/holdout.json']));
    const seen = new Set(sets.flatMap((set) => textsOf(set).map((text) => normalizeSentence(text))));
    expect(own.filter((text) => seen.has(text))).toEqual([]);
  });
});
