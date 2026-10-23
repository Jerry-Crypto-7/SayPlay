/**
 * Zapečetěná sada P58B (T1): 80 vět, které napsal Codex bez přístupu ke kódu a sadám – 60 cílů přes všechny žánry
 * a 20 pastí s lákavým žánrem (`lure`); štítky potvrdil druhý soudce (Opus), rozpory vyřazené. Do měření brány (T8)
 * ji kromě tohoto testu nic nečte a test na výstup dává jen id. Průnik se sadou, na které se ladí nebo kterou kdo
 * otevřel, by z brány udělal měření na tréninkových větách.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { normalizeSentence } from '../../../../scripts/play-fidelity.mjs';
import { LOOK_IDS } from '../../../../src/play/arcade/look';
import { GENRES, isGenreMode, type GenreId } from '../../../../src/play/genre/contract';
import { P58B_HOLDOUT_SHA256, sha256Lf } from '../seal';

const PLAY = join(process.cwd(), 'evals', 'play');
const DIR = join(PLAY, 'p58b');
const readLf = (path: string): string => readFileSync(path, 'utf8').replace(/\r\n/g, '\n');

interface Sentence {
  readonly id: string; readonly family: string; readonly genre: string | null; readonly lure: string | null; readonly text: string;
  readonly hero: string | null; readonly foe: string | null; readonly item: string | null; readonly world: string | null;
}
const holdout = (): Sentence[] => (JSON.parse(readLf(join(DIR, 'holdout.json'))) as { sentences: Sentence[] }).sentences;

/** Věty sady, je-li soubor sadou vět (pole `{ text }` nebo `{ sentences: [{ text }] }`); jinak nic. */
const textsOf = (path: string): string[] => {
  const json = JSON.parse(readLf(path)) as unknown;
  const rows = Array.isArray(json) ? json : (json as { sentences?: unknown }).sentences;
  return Array.isArray(rows) && rows.every((row) => typeof (row as { text?: unknown }).text === 'string') ? rows.map((row) => (row as { text: string }).text) : [];
};

/** Každá sada vět ve složkách, které plán jmenuje (p58a až po sloučení P58A); prázdné soubory výsledků se nepočítají. */
const SCANNED_DIRS = ['p30', 'p55', 'p56a', 'p58a'] as const;
/** Další sady, na kterých se ladilo nebo které kdo otevřel (seznam P56A). */
const OTHER_SETS = ['p43/panel.json', 'p43/sealed-100.json', 'p45/panel.json', 'p45/sealed-100.json', 'p52/dev.json', 'p52/holdout.json', 'p54c/dev.json', 'p54c/holdout.json', 'demand/corpus.json'] as const;
const knownSets = (): string[] => [
  ...SCANNED_DIRS.flatMap((dir) => (existsSync(join(PLAY, dir)) ? readdirSync(join(PLAY, dir)).filter((name) => name.endsWith('.json')).map((name) => `${dir}/${name}`) : [])),
  ...OTHER_SETS,
].filter((set) => textsOf(join(PLAY, set)).length > 0);

const validMode = (value: string | null): boolean => {
  if (value === null) return false;
  const [genre, mode] = value.split('.');
  return (GENRES as readonly string[]).includes(genre!) && mode !== undefined && isGenreMode(genre as GenreId, mode);
};
const genreOf = (value: string): string => value.split('.')[0]!;

describe('P58B sealed genre holdout', () => {
  it('matches its recorded SHA-256, also written in the README', () => {
    expect(sha256Lf(readLf(join(DIR, 'holdout.json')))).toBe(P58B_HOLDOUT_SHA256);
    expect(readLf(join(DIR, 'README.md'))).toContain(P58B_HOLDOUT_SHA256);
  });

  it('has 60 targets with every genre at least 3 times and 20 traps luring to another genre', () => {
    const sentences = holdout();
    expect(sentences).toHaveLength(80);
    expect(new Set(sentences.map((s) => s.id)).size).toBe(80);
    const targets = sentences.filter((s) => s.family === 'target');
    const traps = sentences.filter((s) => s.family === 'trap');
    expect([targets.length, traps.length]).toEqual([60, 20]);
    expect(targets.filter((s) => !validMode(s.genre) || s.lure !== null).map((s) => s.id)).toEqual([]);
    for (const genre of GENRES) expect(targets.filter((s) => genreOf(s.genre!) === genre).length, genre).toBeGreaterThanOrEqual(3);
    expect(traps.filter((s) => !validMode(s.lure) || (s.genre !== null && (!validMode(s.genre) || genreOf(s.genre) === genreOf(s.lure!)))).map((s) => s.id)).toEqual([]);
  });

  it('labels hero, foe, item and world on every record', () => {
    const bad = holdout().filter((s) => !['hero', 'foe', 'item', 'world'].every((key) => key in s)
      || (s.world !== null && !(LOOK_IDS as readonly string[]).includes(s.world))
      || [s.hero, s.foe, s.item].some((label) => label !== null && (typeof label !== 'string' || label.trim() === '')));
    expect(bad.map((s) => s.id)).toEqual([]);
  });

  it('shares no sentence with any set in p30, p55, p56a, p58a or another known set, nor within itself', () => {
    const sets = knownSets();
    // Prohledání složek samo něco najde: bez dev a otevřených sad by nulový průnik nic neříkal.
    expect(sets).toEqual(expect.arrayContaining(['p30/dev.json', 'p30/test-200.json', 'p55/holdout.json', 'p56a/holdout.json', 'p56a/audit-12.json']));
    const known = new Set(sets.flatMap((set) => textsOf(join(PLAY, set))).map(normalizeSentence));
    // Kontrola sama kolizi pozná: věta otevřené sady se přepisem velikosti a interpunkce neschová.
    expect(known.has(normalizeSentence(`${textsOf(join(PLAY, 'p56a', 'holdout.json'))[0]!.toUpperCase()}!`))).toBe(true);
    const sentences = holdout();
    // Jen id, ne věta: sada se do výstupu testu nedostane.
    expect(sentences.filter((s) => known.has(normalizeSentence(s.text))).map((s) => s.id)).toEqual([]);
    expect(new Set(sentences.map((s) => normalizeSentence(s.text))).size).toBe(sentences.length);
  });
});
