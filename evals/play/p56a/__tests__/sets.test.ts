/**
 * Zapečetěná sada P56A (T2): 80 vět nezávislého autora – 60 cílů přes 19 žánrů a 20 pastí s lákavým žánrem (`lure`).
 * Do zapečetěného měření (T13) ji kromě tohoto testu nic nečte a test na výstup dává jen id. Průnik s kteroukoli
 * sadou, na které se ladí nebo kterou kdy kdo četl, by z měření udělal měření na tréninkových větách.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { normalizeSentence } from '../../../../scripts/play-fidelity.mjs';
import { LOOK_IDS } from '../../../../src/play/arcade/look';
import { GENRES, isGenreMode, type GenreId } from '../../../../src/play/genre/contract';
import { P56A_HOLDOUT_SHA256, sha256Lf } from '../seal';

const PLAY = join(process.cwd(), 'evals', 'play');
const DIR = join(PLAY, 'p56a');
const readLf = (path: string): string => readFileSync(path, 'utf8').replace(/\r\n/g, '\n');

interface Sentence {
  readonly id: string; readonly family: string; readonly genre: string | null; readonly lure: string | null; readonly text: string;
  readonly hero: string | null; readonly foe: string | null; readonly item: string | null; readonly world: string | null;
}
const holdout = (): Sentence[] => (JSON.parse(readLf(join(DIR, 'holdout.json'))) as { sentences: Sentence[] }).sentences;
const textsOf = (path: string): string[] => {
  const json = JSON.parse(readLf(join(PLAY, path))) as { sentences: { text: string }[] } | { text: string }[];
  return (Array.isArray(json) ? json : json.sentences).map((s) => s.text);
};

/** Každá sada v `evals/play`, na které se ladilo, nebo kterou kdo otevřel. */
const KNOWN_SETS = [
  'p30/dev.json', 'p30/test-200.json', 'p43/panel.json', 'p43/sealed-100.json', 'p45/panel.json', 'p45/sealed-100.json',
  'p52/dev.json', 'p52/holdout.json', 'p54c/dev.json', 'p54c/holdout.json', 'p55/holdout.json', 'demand/corpus.json', 'p56a/audit-12.json',
] as const;

const validMode = (value: string | null): boolean => {
  if (value === null) return false;
  const [genre, mode] = value.split('.');
  return (GENRES as readonly string[]).includes(genre!) && mode !== undefined && isGenreMode(genre as GenreId, mode);
};

describe('P56A sealed holdout', () => {
  it('matches its recorded SHA-256, also written in the README', () => {
    expect(sha256Lf(readLf(join(DIR, 'holdout.json')))).toBe(P56A_HOLDOUT_SHA256);
    expect(readLf(join(DIR, 'README.md'))).toContain(P56A_HOLDOUT_SHA256);
  });

  it('has 60 targets with every genre at least 3 times and 20 traps luring elsewhere', () => {
    const sentences = holdout();
    expect(sentences).toHaveLength(80);
    expect(new Set(sentences.map((s) => s.id)).size).toBe(80);
    const targets = sentences.filter((s) => s.family === 'target');
    const traps = sentences.filter((s) => s.family === 'trap');
    expect([targets.length, traps.length]).toEqual([60, 20]);
    expect(targets.filter((s) => !validMode(s.genre) || s.lure !== null).map((s) => s.id)).toEqual([]);
    // Sada je zapečetěná před P66 – pět žánrů, které P66 T2 přidal, ani pět her P68 T1 v ní být nemůže.
    const sealed = GENRES.filter((genre) => !['survivor', 'hole', 'steal', 'sort', 'arrows', 'stunt', 'minigolf', 'railfps', 'buildshift', 'drawsave'].includes(genre));
    for (const genre of sealed) expect(targets.filter((s) => s.genre!.startsWith(`${genre}.`)).length, genre).toBeGreaterThanOrEqual(3);
    expect(traps.filter((s) => !validMode(s.lure) || (s.genre !== null && !validMode(s.genre)) || s.genre === s.lure).map((s) => s.id)).toEqual([]);
  });

  it('labels hero, foe, item and world on every record', () => {
    const bad = holdout().filter((s) => !['hero', 'foe', 'item', 'world'].every((key) => key in s)
      || (s.world !== null && !(LOOK_IDS as readonly string[]).includes(s.world))
      || [s.hero, s.foe, s.item].some((label) => label !== null && (typeof label !== 'string' || label.trim() === '')));
    expect(bad.map((s) => s.id)).toEqual([]);
  });

  it('shares no sentence with any known set in evals/play, nor within itself', () => {
    const known = new Set(KNOWN_SETS.flatMap(textsOf).map(normalizeSentence));
    // Kontrola sama kolizi pozná: věta auditu se přepisem velikosti a interpunkce neschová.
    expect(known.has(normalizeSentence(`${textsOf('p56a/audit-12.json')[0]!.toUpperCase()}!`))).toBe(true);
    const sentences = holdout();
    // Jen id, ne věta: sada se do výstupu testu nedostane.
    expect(sentences.filter((s) => known.has(normalizeSentence(s.text))).map((s) => s.id)).toEqual([]);
    expect(new Set(sentences.map((s) => normalizeSentence(s.text))).size).toBe(sentences.length);
  });
});
