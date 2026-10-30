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
import { knownSets, P64_HOLDOUT_SHA256, P64_R3_HOLDOUT_SHA256, P64_R4_HOLDOUT_SHA256, sha256Lf, textsOf } from '../seal';

const PLAY = join(process.cwd(), 'evals', 'play');
const DIR = join(PLAY, 'p64');
const README = join(DIR, 'README.md');
const readLf = (path: string): string => readFileSync(path, 'utf8').replace(/\r\n/g, '\n');

interface Sentence { readonly id: string; readonly genre: string; readonly text: string }
/** Žánry v době zapečetění obou sad; žánry P66 přišly až po nich a zapečetěná sada se nemění. */
const P66_GENRES: readonly string[] = ['survivor', 'hole', 'steal', 'sort', 'arrows'];
const SEALED_GENRES = GENRES.filter((genre) => !P66_GENRES.includes(genre));
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
    for (const genre of SEALED_GENRES) expect(sentences.filter((s) => s.genre === genre).length, genre).toBeGreaterThan(0);
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

// T8-R3: na této sadě se ladí kamery deskových žánrů. Věta z kterékoli zapečetěné sady by ladění přenesla do brány.
const BOARD = ['timing', 'rhythm', 'duel', 'quest', 'catch', 'whack', 'defense', 'slice', 'hop', 'crowd', 'merge', 'push'];
const boardDev = (): Sentence[] => (JSON.parse(readLf(join(DIR, 'board-dev.json'))) as { sentences: Sentence[] }).sentences;

describe('P64 board-genre dev set', () => {
  it('covers every board genre, each sentence labelled with the genre the offline classifier picks today', () => {
    const sentences = boardDev();
    expect(new Set(sentences.map((s) => s.id)).size).toBe(sentences.length);
    expect([...new Set(sentences.map((s) => s.genre))].sort()).toEqual([...BOARD].sort());
    expect(sentences.filter((s) => classifyGenre(s.text, null).ranked[0]!.genre !== s.genre).map((s) => `${s.id} → ${classifyGenre(s.text, null).ranked[0]!.genre}`)).toEqual([]);
  });

  it('shares no sentence with the P64 sealed set or any known set', () => {
    const own = boardDev().map((s) => normalizeSentence(s.text));
    expect(new Set(own).size).toBe(own.length);
    const sets = [...new Set([...knownSets(), 'p58b/holdout.json', 'p30/dev.json', 'p61/holdout.json', 'p62/holdout.json', 'p62/holdout-b.json', 'p63/holdout.json', 'p63/read-set.json', 'p63/reread-set.json', 'p64/holdout.json'])].filter((set) => existsSync(join(PLAY, set)));
    expect(sets).toContain('p64/holdout.json');
    const seen = new Set(sets.flatMap((set) => textsOf(set).map((text) => normalizeSentence(text))));
    expect(own.filter((text) => seen.has(text))).toEqual([]);
  });
});

// T8-R3 krok 3: první sada je otevřená a kód se po ní změnil, brána běží na nové. Věta z `board-dev.json` by do ní
// přenesla ladění kamer deskových žánrů.
const r3Holdout = (): Sentence[] => (JSON.parse(readLf(join(DIR, 'r3', 'holdout.json'))) as { sentences: Sentence[] }).sentences;

describe('P64 second sealed portrait holdout (T8-R3)', () => {
  it('matches its recorded SHA-256, also written in the README', () => {
    expect(sha256Lf(readLf(join(DIR, 'r3', 'holdout.json')))).toBe(P64_R3_HOLDOUT_SHA256);
    expect(readLf(README)).toContain(P64_R3_HOLDOUT_SHA256);
  });

  it('has 24 sentences with unique ids, every genre at least once and the four board genres that lost twice', () => {
    const sentences = r3Holdout();
    expect(sentences).toHaveLength(24);
    expect(new Set(sentences.map((s) => s.id)).size).toBe(24);
    for (const genre of SEALED_GENRES) expect(sentences.filter((s) => s.genre === genre).length, genre).toBeGreaterThan(0);
    for (const genre of ['timing', 'slice', 'catch', 'merge']) expect(sentences.filter((s) => s.genre === genre).length, genre).toBeGreaterThanOrEqual(2);
    expect(sentences.filter((s) => classifyGenre(s.text, null).ranked[0]!.genre !== s.genre).map((s) => s.id)).toEqual([]);
  });

  it('shares no sentence with the first P64 set, the board dev set or any known set', () => {
    const own = r3Holdout().map((s) => normalizeSentence(s.text));
    expect(new Set(own).size).toBe(own.length);
    const dir = (name: string): string[] => readdirSync(join(PLAY, name)).filter((file) => file.endsWith('.json')).map((file) => `${name}/${file}`);
    const sets = [...new Set([...knownSets(), 'p58b/holdout.json', ...dir('p56c'), ...dir('p30'), 'p61/holdout.json', 'p62/holdout.json', 'p62/holdout-b.json', 'p63/holdout.json', 'p63/read-set.json', 'p63/reread-set.json', 'p64/holdout.json', 'p64/board-dev.json'])].filter((set) => existsSync(join(PLAY, set)));
    expect(sets).toEqual(expect.arrayContaining(['p30/dev.json', 'p56c/holdout.json', 'p64/holdout.json', 'p64/board-dev.json']));
    const seen = new Set(sets.flatMap((set) => textsOf(set).map((text) => normalizeSentence(text))));
    expect(own.filter((text) => seen.has(text))).toEqual([]);
  });
});

// T8-R7: druhá sada je otevřená a krájení se po ní změnilo (T8-R5), brána běží na třetí. Krájení ztrácelo ve všech
// soudech, proto aspoň tři jeho věty.
const r4Holdout = (): Sentence[] => (JSON.parse(readLf(join(DIR, 'r4', 'holdout.json'))) as { sentences: Sentence[] }).sentences;

describe('P64 third sealed portrait holdout (T8-R7)', () => {
  it('matches its recorded SHA-256, also written in the README', () => {
    expect(sha256Lf(readLf(join(DIR, 'r4', 'holdout.json')))).toBe(P64_R4_HOLDOUT_SHA256);
    expect(readLf(README)).toContain(P64_R4_HOLDOUT_SHA256);
  });

  it('has 24 sentences with unique ids, every sealed genre and at least three slice sentences', () => {
    const sentences = r4Holdout();
    expect(sentences).toHaveLength(24);
    expect(new Set(sentences.map((s) => s.id)).size).toBe(24);
    for (const genre of SEALED_GENRES) expect(sentences.filter((s) => s.genre === genre).length, genre).toBeGreaterThan(0);
    expect(sentences.filter((s) => s.genre === 'slice').length).toBeGreaterThanOrEqual(3);
    expect(sentences.filter((s) => classifyGenre(s.text, null).ranked[0]!.genre !== s.genre).map((s) => s.id)).toEqual([]);
  });

  it('shares no sentence with the earlier P64 sets, the board dev set or any known set', () => {
    const own = r4Holdout().map((s) => normalizeSentence(s.text));
    expect(new Set(own).size).toBe(own.length);
    const dir = (name: string): string[] => readdirSync(join(PLAY, name)).filter((file) => file.endsWith('.json')).map((file) => `${name}/${file}`);
    const sets = [...new Set([...knownSets(), 'p58b/holdout.json', ...dir('p56c'), ...dir('p30'), 'p61/holdout.json', 'p62/holdout.json', 'p62/holdout-b.json', 'p63/holdout.json', 'p63/read-set.json', 'p63/reread-set.json', 'p64/holdout.json', 'p64/r3/holdout.json', 'p64/board-dev.json'])].filter((set) => existsSync(join(PLAY, set)));
    expect(sets).toEqual(expect.arrayContaining(['p30/dev.json', 'p56c/holdout.json', 'p64/holdout.json', 'p64/r3/holdout.json', 'p64/board-dev.json']));
    const seen = new Set(sets.flatMap((set) => textsOf(set).map((text) => normalizeSentence(text))));
    expect(own.filter((text) => seen.has(text))).toEqual([]);
  });
});
