/**
 * Smlouva rolí (P32B T3). Vzorový popisek („giant Roomba“, „race car“, hrdina
 * losovaný ze seznamu) vypadá na snímku jako legitimní role – proto pin: role
 * nové hry jsou jen slova věty nebo výchozí z prostředí. Od P32B T6 běží proti
 * skutečným modulům (`GENRE_MODULES`), ne proti dvojníkům.
 */

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { goldenPrompts } from '../../../../evals/play/golden';
import sentenceSet from '../../../../evals/play/p32/sentences.json';
import { draftForControl, draftGameSpecWithMeta } from '../../draft/draft';
import { singular } from '../../draft/lexicon';
import type { GameSpecV1 } from '../../spec';
import { DEFAULT_LABELS, craftOf, defaultCollectible, defaultEnemy, defaultHero, heroClass, heroFits } from '../roles';

const demand = JSON.parse(readFileSync(new URL('../../../../evals/play/demand/corpus.json', import.meta.url), 'utf8')) as { readonly text: string }[];
const corpus = [...sentenceSet.sentences.map((entry) => entry.text), ...goldenPrompts().map((entry) => entry.prompt), ...demand.map((entry) => entry.text)];

const draft = (sentence: string) => draftGameSpecWithMeta(sentence, 1);
/** Co hráč vidí: titulek, popisky rolí, cíl a nápověda. Id rolí drží fixtury kvůli hashům („roomba“), ta hráč nevidí. */
const shown = (spec: GameSpecV1): string => JSON.stringify([spec.title, spec.roles.map((role) => role.label), spec.objective.description, spec.tutorial]);
const sentence = (id: string): string => sentenceSet.sentences.find((entry) => entry.id === id)!.text;

/** Slovo popisku ve větě i v jiném čísle („ghost“ ve „ghosts“, „puppy“ v „puppies“, „knife“ v „knives“). */
function said(word: string, text: string): boolean {
  const stem = word.replace(/(?:ies|es|s|y)$/, '');
  return new RegExp(`\\b(?:${word}|${stem}(?:s|es|ies|y|ys)?)\\b`).test(text) || text.split(/[^a-z']+/).some((spoken) => singular(spoken) === word);
}

/** Popisek je z věty, když tam je každé jeho slovo, jinak musí být výchozí ze smlouvy rolí. */
const fromSentenceOrDefault = (label: string, text: string): boolean =>
  DEFAULT_LABELS.has(label.toLowerCase()) || label.toLowerCase().split(/[^a-z0-9']+/).filter(Boolean).every((word) => said(word, text.toLowerCase()));

describe('roles of a new game', () => {
  it('come only from the sentence or the setting defaults, across the whole draft corpus', () => {
    const strays = corpus.flatMap((text) => {
      const genre = draft(text).genre;
      if (genre === null) return [];
      const labels = [genre.hero, genre.enemy, genre.collectible, genre.target?.label].filter((label): label is string => label !== undefined);
      return labels.filter((label) => !fromSentenceOrDefault(label, text)).map((label) => `${label} ← ${text}`);
    });
    expect(strays).toEqual([]);
  });

  it('never carry the Roomba of the chase fixture unless the sentence names it', () => {
    const leaks = corpus.filter((text) => !/roomba/i.test(text) && /roomba/i.test(shown(draft(text).spec)));
    expect(leaks).toEqual([]);
  });

  it.each(sentenceSet.sentences)('give $id the genre, mode and hero the set expects', (entry) => {
    const genre = draft(entry.text).genre!;
    const [id, mode] = entry.genre.split('.');
    expect(genre.genre).toBe(id);
    if (mode !== undefined) expect(genre.mode).toBe(mode);
    expect(genre.hero).toContain(entry.hero.split(' ').at(-1));
    expect(heroFits(genre.genre, genre.hero)).toBe(true);
  });

  it('give the pirate a boat and the wizard ghosts', () => {
    expect(heroClass(draft(sentence('pirate')).genre!.hero)).toBe('boat');
    expect(draft(sentence('wizard')).genre!.enemy).toBe('ghost');
  });

  it('fill a foe the sentence leaves out from the place it is set in', () => {
    // Pes ve městě a raketa na Marsu nepřítele neříkají; hra ho má z prostředí.
    expect(draft(sentence('dog')).genre!.enemy).toBe('car');
    expect(draft(sentence('rocket')).genre!.enemy).toBe('asteroid');
    const mushrooms = draft('Collect five glowing mushrooms in a moonlit forest').genre!;
    expect(mushrooms.collectible).toBe('glowing mushroom');
    expect(mushrooms.hero).toBe(defaultHero('moonlit forest', mushrooms.genre, ''));
  });
});

describe('setting defaults', () => {
  it.each([
    ['haunted castle', 'ghost'],
    ['stormy sea', 'shark'],
    ['snowy mountain', 'polar bear'],
    ['dark forest', 'wolf'],
    ['busy city', 'car'],
    ['outer space', 'asteroid'],
  ])('%s → %s', (setting, enemy) => {
    expect(defaultEnemy(setting, 'arena')).toBe(enemy);
  });

  it('fall back per genre when the place is unknown', () => {
    expect(defaultEnemy('village', 'runner')).toBe('rock');
    expect(defaultCollectible('village')).toBe('coin');
    expect(defaultCollectible('snowy mountain')).toBe('snowflake');
  });
});

describe('heroFits', () => {
  it('lets a genre take only the hero classes it plays', () => {
    expect(heroFits('voyage', 'pirate ship')).toBe(true);
    expect(heroFits('runner', 'pirate ship')).toBe(false);
    expect(heroFits('platformer', 'rocket')).toBe(false);
    expect(heroFits('quest', 'tiny wizard')).toBe(true);
    // Slovo bez třídy nic nedokazuje – scéna nakreslí náhradu.
    expect(heroFits('runner', 'grandma')).toBe(true);
  });

  it('reads the class from the noun, not the adjective', () => {
    expect(heroClass('pirate ship')).toBe('boat');
    expect(heroClass('firefighter robot')).toBe('robot');
    expect(heroClass('polar bears')).toBe('animal');
  });
});

describe('Voyage never gives a car when the sentence names a craft', () => {
  it.each([
    ['A pirate ship dodges cannonballs while sailing between islands to find buried treasure', 'pirate ship'],
    ['Ride a broom through the haunted castle', 'broom'],
    ['Pilot a paper plane over the rooftops', 'paper plane'],
    ['A rocket lands on Mars', 'rocket'],
  ])('%s', (text, craft) => {
    expect(craftOf(text)).toBe(craft);
    expect(defaultHero('city', 'voyage', text)).toBe(craft);
    // Kompaktní režisér dá větě řízení: hrdina šablony („race car“) nesmí zůstat.
    const steer = draftForControl(text, 'steer');
    const hero = steer!.roles.find((role) => role.kind === 'player')!.label;
    expect(hero).not.toMatch(/race car/i);
    expect(heroClass(hero)).not.toBe('vehicle');
  });

  it('gives the craft of the place when the sentence names none', () => {
    expect(defaultHero('stormy sea', 'voyage', 'Sail to the lighthouse')).toBe('boat');
    expect(defaultHero('outer space', 'voyage', 'Zoom past the planets')).toBe('rocket');
  });
});

describe('the grid chase keeps no fixture chaser', () => {
  it('hunts the hero with the foe of the place, not the Roomba', () => {
    const chase = draftForControl('A mouse escapes a haunted castle', 'tap_go')!;
    expect(chase.archetype).toBe('chase_escape');
    expect(chase.roles.find((role) => role.id === 'roomba')!.label).toBe('ghost');
    expect(shown(chase)).not.toMatch(/roomba/i);
  });
});
