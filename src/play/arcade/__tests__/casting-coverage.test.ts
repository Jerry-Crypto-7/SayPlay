/**
 * Pokrytí obsazení (P58A T6): slovo z věty, které katalog nemá, dostane nejbližší model
 * nebo třídní náhradu – nikdy výchozího robota. Náhrada musí být i správné třídy: krtek
 * kreslený goblinem nebo knedlík popelnicí vypadá jako model a soudce slovo stejně nepozná.
 */

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { heroChoice } from '../models';

const nouns = (JSON.parse(readFileSync('evals/play/p58a/missing-nouns.json', 'utf8')) as { nouns: { noun: string }[] }).nouns.map((entry) => entry.noun);

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
