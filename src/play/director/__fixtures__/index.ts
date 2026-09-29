/**
 * Odpovědi „jako model" (P23-B T4): osm dobrých – jiná jména rolí než fixtury
 * základu, plná `verification` – a šest rozbitých, každá na jeden důvod
 * odmítnutí. `bad-truncated` je text, ne JSON: čte se přes `parseAnswerText`
 * a musí skončit výjimkou, protože je useknutý uprostřed řetězce.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import type { GenreModule, GenreSpec } from '../../genre/contract';
import { GENRE_MODULES } from '../../genre/index';
import { ARCHETYPE_IDS } from '../../registry';
import { readyModes } from '../answer-schema';

/**
 * Dobrá odpověď režiséra na novou hru (P32B T4): `{plan, spec}` se
 * `GenreSpec`, tak jak ji čte `readGenreAnswer`. Výchozí je útěk v Aréně;
 * `spec` přepíše, co test potřebuje.
 */
export function genreAnswer(spec: Partial<GenreSpec> = {}): { readonly plan: string; readonly spec: GenreSpec } {
  return { plan: 'play the sentence', spec: { genre: 'arena', mode: 'escape', hero: 'fox', enemy: 'wolf', collectible: 'acorn', setting: 'dark forest', palette: 'forest', ...spec } as GenreSpec };
}

/** Jedna dobrá odpověď na každý režim `ready` – náhrada `GOOD_ANSWERS` pro testy, které projdou všechny tvary hry. */
export const GENRE_ANSWERS: readonly { readonly name: string; readonly answer: ReturnType<typeof genreAnswer> }[] = (Object.values(GENRE_MODULES) as GenreModule[]).flatMap((module) =>
  readyModes(module).map((mode) => ({ name: `${module.id}.${mode}`, answer: genreAnswer({ genre: module.id, mode } as Partial<GenreSpec>) })),
);

const answersDir = fileURLToPath(new URL('./answers/', import.meta.url));

export const GOOD_ANSWERS = ARCHETYPE_IDS.map((id) => `good-${id}` as const);

export const BAD_ANSWERS = [
  'bad-unknown-mechanic',
  'bad-no-player',
  'bad-foreign-archetype',
  'bad-over-budget',
  'bad-worlddoc',
] as const;

export const ANSWER_FIXTURES = [...GOOD_ANSWERS, ...BAD_ANSWERS] as const;
export type AnswerFixtureName = (typeof ANSWER_FIXTURES)[number];

/** Rozparsované JSON tělo, přesně to, co by `GenerationBranch` vrátil v `body`. */
export function answerFixture(name: AnswerFixtureName): unknown {
  return JSON.parse(readFileSync(new URL(`${name}.json`, `file://${answersDir.replace(/\\/g, '/')}`), 'utf8'));
}

/**
 * Dobrá odpověď s ovládáním běžce (P25E T5). Mimo `GOOD_ANSWERS`: ty jdou po
 * archetypech mřížky a běžec je `hazard_crossing` s jiným ovládáním.
 */
export function runnerAnswer(): unknown {
  return JSON.parse(readFileSync(new URL('good-runner.json', `file://${answersDir.replace(/\\/g, '/')}`), 'utf8'));
}

/** Useknutý text odpovědi – jediná fixtura, která nejde přečíst jako JSON. */
export function truncatedAnswerText(): string {
  return readFileSync(new URL('bad-truncated.txt', `file://${answersDir.replace(/\\/g, '/')}`), 'utf8');
}
