/**
 * Pokrytí obsazení (P58A T6): slovo z věty, které katalog nemá, dostane nejbližší model
 * nebo třídní náhradu – nikdy výchozího robota. Náhrada musí být i správné třídy: krtek
 * kreslený goblinem nebo knedlík popelnicí vypadá jako model a soudce slovo stejně nepozná.
 */

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { draftGameSpecWithMeta } from '../../draft/draft';
import { singular } from '../../draft/lexicon';
import { heroChoice } from '../models';

const nouns = (JSON.parse(readFileSync('evals/play/p58a/missing-nouns.json', 'utf8')) as { nouns: { noun: string }[] }).nouns.map((entry) => entry.noun);

/** Nahraná čtení dev sad (T1): hra se z nich skládá stejně jako na serveru s přehrávačem čtečky. */
const readings = ['audit-12', 'p56a-holdout'].flatMap(
  (set) => (JSON.parse(readFileSync(`evals/play/p58a/readings/${set}.gpt-oss-20b.json`, 'utf8')) as { readings: { id: string; text: string; reading: unknown }[] }).readings,
);
/** Popisky rolí hry kromě hrdiny pro větu dev sady `id`. */
const castLabels = (id: string): string[] => {
  const entry = readings.find((row) => row.id === id)!;
  const meta = draftGameSpecWithMeta(entry.text, 1, { reading: entry.reading as never });
  return meta.spec.roles.filter((role) => role.kind !== 'player').map((role) => role.label);
};
const head = (label: string): string => singular(label.toLowerCase()).split(' ').at(-1)!;

const choice = (noun: string) => heroChoice(noun, undefined, 'shooter', 'enemy');

describe('casting coverage of sentence nouns the catalog lacks (P58A)', () => {
  it('reads the dev-set list of missing nouns', () => {
    expect(nouns.length).toBeGreaterThanOrEqual(70);
  });

  it('gives every missing noun a nearest model or a class stand-in, never the default robot', () => {
    const fallen = nouns.filter((noun) => choice(noun).level === 'fallback');
    expect(fallen).toEqual([]);
    for (const noun of nouns) expect(choice(noun).model, noun).not.toMatch(/robot|^rigged:q-cowboy-hair$/);
  });

  it('casts animals as animals and people as people', () => {
    for (const noun of ['gopher', 'mole', 'lemming', 'bulldog', 'cheetah']) expect(choice(noun).entry?.class, noun).toBe('animal');
    // Zloděj a boxer (shoplifter, champ) jsou statické postavy katalogu bez záznamu manifestu – třídu nenesou.
    for (const noun of ['blacksmith', 'citizen', 'guest', 'hostage', 'leader', 'lord', 'master', 'seeker', 'traveler']) expect(choice(noun).entry?.class, noun).toBe('humanoid');
  });

  it('keeps nearest-model picks that only share letters out of the cast', () => {
    const lookalike: Record<string, RegExp> = { dumpling: /dumpster/, snowplow: /snowflake/, starfighter: /^star$/, trout: /fishing/, mole: /goblin/, patty: /penguin/, master: /penguin/ };
    for (const [noun, wrong] of Object.entries(lookalike)) expect(choice(noun).model, noun).not.toMatch(wrong);
  });
});

describe('every sentence noun gets a role the genre has (P58A T6, no-role from T2)', () => {
  // Slovo věty z `why.json` třídy no-role → role hry, která ho nese. Výchozí popisek žánru (rival, marker, pipe,
  // ogre, ball) ani slovo z okolí věty („sand“, „him back“) slovo věty nenahradí.
  const cases: Record<string, string> = {
    s03: 'yeti',
    s26: 'crocodile',
    s42: 'seagull',
    s48: 'rooster',
    s06: 'patty',
    s20: 'pancake',
    s44: 'coconut',
    s19: 'king',
    s35: 'stalactite',
    s38: 'coconut',
    s23: 'dolphin',
  };
  // s40 („swarm the huge troll at the end“) je věta davu, kterou volba žánru hraje běžcem bez bosse – P58B.
  for (const [id, noun] of Object.entries(cases)) {
    it(`${id}: «${noun}» is cast`, () => {
      expect(castLabels(id).map(head), id).toContain(noun);
    });
  }
});
