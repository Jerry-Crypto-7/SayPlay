/**
 * Zapečetěná sada P62 (T1): 24 nových vět o místě, otevře se jednou v T7. Sada, která se tiše změní, zneplatní
 * bránu; věta sdílená (nebo skoro stejná) se sadou, na které se ladilo, z brány udělá měření na tréninkových větách.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { normalizeSentence } from '../../../../scripts/play-fidelity.mjs';
import { knownSets, P62_HOLDOUT_SHA256, sha256Lf, textsOf } from '../seal';

const PLAY = join(process.cwd(), 'evals', 'play');
const DIR = join(PLAY, 'p62');
const readLf = (path: string): string => readFileSync(path, 'utf8').replace(/\r\n/g, '\n');

interface Sentence { readonly id: string; readonly family: string; readonly text: string; readonly foe: string | null; readonly item: string | null; readonly world: string }
const holdout = (): Sentence[] => (JSON.parse(readLf(join(DIR, 'holdout.json'))) as { sentences: Sentence[] }).sentences;

/** Sady, se kterými nová věta nesmí nic sdílet: každá sada vět P30, P56C, P58B (holdout), P61 (holdout) a známé sady P58B. */
function otherSets(): string[] {
  const dir = (name: string): string[] => readdirSync(join(PLAY, name)).filter((file) => file.endsWith('.json')).map((file) => `${name}/${file}`);
  return [...new Set([...knownSets(), ...dir('p30'), ...dir('p56c'), 'p58b/holdout.json', 'p61/holdout.json'])].filter((set) => textsOf(set).length > 0);
}

/** Slova věty s obsahem (čtyři a víc písmen) – na nich se pozná skoro stejná věta s jiným členem nebo předložkou. */
const content = (text: string): Set<string> => new Set(normalizeSentence(text).split(' ').filter((word) => word.length >= 4));
const jaccard = (a: Set<string>, b: Set<string>): number => {
  const shared = [...a].filter((word) => b.has(word)).length;
  return shared / Math.max(1, a.size + b.size - shared);
};
/**
 * Od tohohle podílu sdílených slov je věta „skoro stejná“: přepsané věty z návrhu sady ležely na 0,33–0,38
 * („Moles keep popping up … bonks them“ proti P55). Nejbližší dvojice zapečetěné sady je 0,22 (README).
 */
const NEAR = 0.3;

describe('P62 sealed scene holdout', () => {
  it('matches its recorded SHA-256, also written in the README', () => {
    expect(sha256Lf(readLf(join(DIR, 'holdout.json')))).toBe(P62_HOLDOUT_SHA256);
    expect(readLf(join(DIR, 'README.md'))).toContain(P62_HOLDOUT_SHA256);
  });

  it('has 24 sentences: 8 interiors, 8 outdoor places, 8 named foes without a model; each names a place and a foe or an item', () => {
    const sentences = holdout();
    expect(sentences).toHaveLength(24);
    expect(new Set(sentences.map((s) => s.id)).size).toBe(24);
    for (const family of ['interior', 'outdoor', 'missing-foe']) expect(sentences.filter((s) => s.family === family), family).toHaveLength(8);
    for (const s of sentences) {
      expect(s.world, s.id).toBeTruthy();
      expect(s.foe ?? s.item, s.id).toBeTruthy();
    }
    expect(sentences.filter((s) => s.family === 'missing-foe').every((s) => s.foe !== null)).toBe(true);
  });

  it('shares no sentence, exact or near, with p30, p56c, p58b/holdout.json, p61/holdout.json or another known set, nor within itself', () => {
    const own = holdout().map((s) => s.text);
    expect(new Set(own.map(normalizeSentence)).size).toBe(own.length);
    const sets = otherSets();
    expect(sets).toEqual(expect.arrayContaining(['p30/dev.json', 'p30/test-200.json', 'p56c/holdout.json', 'p58b/holdout.json', 'p61/holdout.json']));
    const seen = sets.flatMap((set) => textsOf(set));
    const exact = new Set(seen.map(normalizeSentence));
    expect(own.filter((text) => exact.has(normalizeSentence(text)))).toEqual([]);
    const near = own.flatMap((text) => seen.filter((other) => jaccard(content(text), content(other)) >= NEAR).map((other) => `${text} ~ ${other}`));
    const inside = own.flatMap((text, i) => own.slice(i + 1).filter((other) => jaccard(content(text), content(other)) >= NEAR).map((other) => `${text} ~ ${other}`));
    expect([...near, ...inside]).toEqual([]);
  });
});
