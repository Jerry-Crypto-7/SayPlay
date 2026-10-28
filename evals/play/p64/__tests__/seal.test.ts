/**
 * Zapečetěná sada P64 (T1): 24 nových vět, otevře se jednou v T8. Sada, která se tiše změní, zneplatní bránu; věta
 * sdílená se sadou, na které se ladilo (P61 až P63), z brány udělá měření na tréninkových větách. Žánr věty je to, co
 * dnes vybere klasifikátor rychlé hry bez modelu – posune-li ho změna klasifikátoru, sada už nepokrývá každý žánr.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { normalizeSentence } from '../../../../scripts/play-fidelity.mjs';
import { GENRES } from '../../../../src/play/genre/contract';
import { classifyGenre } from '../../../../src/play/genre/classify';
import { knownSets, P64_HOLDOUT_SHA256, sha256Lf, textsOf } from '../seal';

const PLAY = join(process.cwd(), 'evals', 'play');
const DIR = join(PLAY, 'p64');
const README = join(DIR, 'README.md');
const readLf = (path: string): string => readFileSync(path, 'utf8').replace(/\r\n/g, '\n');

interface Sentence { readonly id: string; readonly genre: string; readonly text: string }
const holdout = (): Sentence[] => (JSON.parse(readLf(join(DIR, 'holdout.json'))) as { sentences: Sentence[] }).sentences;

describe('P64 sealed portrait holdout', () => {
  it('matches its recorded SHA-256, also written in the README once it exists', () => {
    expect(sha256Lf(readLf(join(DIR, 'holdout.json')))).toBe(P64_HOLDOUT_SHA256);
    // README píše až konec T1; do té doby drží otisk jen `seal.ts`.
    if (existsSync(README)) expect(readLf(README)).toContain(P64_HOLDOUT_SHA256);
  });

  it('has 24 sentences with unique ids', () => {
    const sentences = holdout();
    expect(sentences).toHaveLength(24);
    expect(new Set(sentences.map((s) => s.id)).size).toBe(24);
  });

  it('covers every genre at least once, each sentence labelled with the genre the offline classifier picks today', () => {
    const sentences = holdout();
    for (const genre of GENRES) expect(sentences.filter((s) => s.genre === genre).length, genre).toBeGreaterThan(0);
    expect(sentences.filter((s) => classifyGenre(s.text, null).ranked[0]!.genre !== s.genre).map((s) => s.id)).toEqual([]);
  });

  it('shares no sentence with p30, p58b, p56c, p61, p62, p63 or another known set, nor within itself', () => {
    const own = holdout().map((s) => normalizeSentence(s.text));
    expect(new Set(own).size).toBe(own.length);
    const dir = (name: string): string[] => readdirSync(join(PLAY, name)).filter((file) => file.endsWith('.json')).map((file) => `${name}/${file}`);
    const later = ['p61/holdout.json', 'p62/holdout.json', 'p62/holdout-b.json', 'p63/holdout.json', 'p63/read-set.json', 'p63/reread-set.json'].filter((set) => existsSync(join(PLAY, set)));
    const sets = [...new Set([...knownSets(), 'p58b/holdout.json', ...dir('p56c'), ...dir('p30'), ...later])].filter((set) => textsOf(set).length > 0);
    expect(sets).toEqual(expect.arrayContaining(['p30/dev.json', 'p58b/holdout.json', 'p56c/holdout.json', 'p61/holdout.json', 'p62/holdout.json', 'p63/holdout.json']));
    const seen = new Set(sets.flatMap((set) => textsOf(set).map((text) => normalizeSentence(text))));
    expect(own.filter((text) => seen.has(text))).toEqual([]);
  });
});
