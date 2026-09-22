/**
 * Odpovědi „jako model" (P23-B T4): osm dobrých – jiná jména rolí než fixtury
 * základu, plná `verification` – a šest rozbitých, každá na jeden důvod
 * odmítnutí. `bad-truncated` je text, ne JSON: čte se přes `parseAnswerText`
 * a musí skončit výjimkou, protože je useknutý uprostřed řetězce.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { ARCHETYPE_IDS } from '../../registry';

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
