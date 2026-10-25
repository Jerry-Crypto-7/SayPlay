/**
 * Cílové řádky (P56A T9). „Knock out 5 waves of bees“ u věty o zombiích nebo „without hitting a asteroid“
 * jsou hladké věty, které žádný test tvaru nechytí – proto pin nad cílovým řádkem (`objective.description`,
 * `tutorial.goalLine`) všech dev vět P56A, bez čtení i se čtením gpt-oss-20b z `evals/play/p56a/readings/`.
 */

import { readFileSync } from 'node:fs';

import { beforeAll, describe, expect, it } from 'vitest';

import { loadRapier } from '@/play/arcade/physics/world';

import { draftGameSpecWithMeta } from '../../draft/draft';
import { plural, singular } from '../../draft/lexicon';
import { readingSchema, type Reading } from '../../read/schema';
import type { GameSpecV1 } from '../../spec';
import { DEFAULT_LABELS } from '../roles';

interface Entry { readonly id: string; readonly text: string }

const evals = (path: string): unknown => JSON.parse(readFileSync(new URL(`../../../../evals/play/${path}`, import.meta.url), 'utf8'));

/** Dev sady P56A (T2: ladí se jen na nich) a čtení téže sady lokálním gpt-oss-20b (T4). */
const SETS = { 'p55/holdout': 'p55-holdout', 'p54c/dev': 'p54c-dev', 'p54c/holdout': 'p54c-holdout', 'p30/dev': 'p30-dev', 'p43/panel': 'p43-panel', 'p56a/audit-12': 'audit-12' } as const;

const sentences: Entry[] = Object.keys(SETS).flatMap((set) => (evals(`${set}.json`) as { sentences: Entry[] }).sentences);
const readings = new Map<string, Reading>(
  Object.values(SETS).flatMap((file) =>
    (evals(`p56a/readings/${file}.gpt-oss-20b.json`) as { readings: { text: string; reading: object | null }[] }).readings.flatMap((row) => {
      // Čtení jsou uložená před P58B T5, pole `sure` nemají – `classifyGenre` je bere jako jistá.
      const parsed = readingSchema.safeParse(row.reading === null ? null : { sure: true, ...row.reading });
      return parsed.success ? [[row.text, parsed.data] as const] : [];
    }),
  ),
);

const cases: { readonly label: string; readonly text: string; readonly reading: Reading | null }[] = [
  ...sentences.map((entry) => ({ label: `${entry.id} words`, text: entry.text, reading: null })),
  ...sentences.flatMap((entry) => {
    const reading = readings.get(entry.text);
    return reading === undefined ? [] : [{ label: `${entry.id} read`, text: entry.text, reading }];
  }),
];

const drafted = new Map<string, GameSpecV1>();
/** Návrh je drahý (robot ověří hru) – každá dvojice věta × čtení jednou za běh. */
const draft = (text: string, reading: Reading | null): GameSpecV1 => {
  const key = `${reading === null ? 'words' : 'read'}:${text}`;
  const known = drafted.get(key);
  if (known !== undefined) return known;
  const spec = draftGameSpecWithMeta(text, 1, { reading }).spec;
  drafted.set(key, spec);
  return spec;
};
const goalLines = (spec: GameSpecV1): string[] => [spec.objective.description, spec.tutorial.goalLine];

const wordsOf = (text: string): string[] => text.toLowerCase().split(/[^a-z']+/).filter(Boolean).map(singular);
/** Slovo věty i v jiném čísle („zombie“ v „zombies“, „fly“ ve „flies“, „three-headed hydra“). */
const said = (label: string, text: string): boolean => wordsOf(label).every((word) => wordsOf(text).includes(word));

/** Popisek v řádku v jednotném i množném čísle („bee“, „bees“). */
const named = (label: string, line: string): boolean => new RegExp(`\\b(?:${label}|${plural(label, 2)})\\b`, 'i').test(line);

beforeAll(async () => {
  await loadRapier();
});

describe('goal text of every dev sentence', () => {
  it('covers the dev sets with and without a reading', () => {
    expect(sentences.length).toBe(342);
    // Čtečka T4 přečetla skoro všechny – sada bez čtení by tiše testovala jen slovník.
    expect(cases.length - sentences.length).toBeGreaterThan(320);
  });

  it.each(cases)('$label: takes „an“ before a vowel and a singular noun after one', ({ text, reading }) => {
    const lines = goalLines(draft(text, reading));
    expect(lines.filter((line) => /\ba [aeiou]/i.test(line))).toEqual([]);
    expect(lines.filter((line) => /\b1 [a-z]+(?<!s)s\b/i.test(line))).toEqual([]);
  });

  it.each(cases)('$label: names only things the game has', ({ text, reading }) => {
    const spec = draft(text, reading);
    const cast = spec.roles.map((role) => singular(role.label.toLowerCase()));
    // Výchozí popisky rolí (`DEFAULT_LABELS`) jsou podstatná jména, která řádek umí říct, aniž je věta řekla.
    // Slova šablon, která se s popisky jen potkají, rolí nejsou: „switch lanes“, „wind-up“, „rival vehicles“ (soupeři závodu).
    const lines = goalLines(spec).map((line) => line.replace(/\bswitch lanes\b|\bwind-up\b|\brival vehicles\b/gi, ''));
    const strays = lines.flatMap((line) => [...DEFAULT_LABELS].filter((label) => named(label, line) && !cast.some((role) => role === label || role.endsWith(` ${label}`)) && !said(label, text)));
    expect(strays).toEqual([]);
  });

  it.each(cases)('$label: an arena fight names its rival from the sentence or as the hero', ({ text, reading }) => {
    const spec = draft(text, reading);
    if (spec.genre?.id !== 'arena' || spec.genre.mode !== 'fight') return;
    const hero = spec.roles.find((role) => role.kind === 'player')?.label ?? '';
    const rival = spec.roles.find((role) => role.id === 'rival')!;
    // Soupeř z výchozího místa (farma → včela) ve větě není: „bez jmenovaného soupeře bojuje hrdina se sobě rovným“.
    expect(said(rival.label, text) || singular(rival.label) === singular(hero), `${rival.label} in „${text}“`).toBe(true);
    for (const line of goalLines(spec)) expect(named(singular(rival.label), line), line).toBe(true);
  });
});

describe('plural nouns in goal lines', () => {
  it('reads back through singular, irregulars included („5 waves of wolves“)', () => {
    for (const noun of ['wolf', 'knife', 'leaf', 'mouse', 'goose', 'child', 'bee', 'fly', 'box', 'zombie']) expect(singular(plural(noun, 2))).toBe(noun);
    expect(plural('wolf', 5)).toBe('wolves');
    expect(plural('wolf', 1)).toBe('wolf');
  });
});

describe('audit sentences (P56A audit-12)', () => {
  it('a02: zombies fight zombies, not bees', () => {
    const spec = draft('zombies attack my farm at night', null);
    expect(goalLines(spec).join(' ')).not.toMatch(/\bbees?\b/);
    expect(goalLines(spec).join(' ')).toMatch(/\bzombies\b/);
  });

  it('a09: dodges „an asteroid“', () => {
    expect(goalLines(draft('an astronaut dodges asteroids to reach the space station', null)).join(' ')).not.toMatch(/\ba asteroid/);
  });
});
