import { loadRapier } from '@/play/arcade/physics/world';
/**
 * Smlouva rolí (P32B T3). Vzorový popisek („giant Roomba“, „race car“, hrdina
 * losovaný ze seznamu) vypadá na snímku jako legitimní role – proto pin: role
 * nové hry jsou jen slova věty nebo výchozí z prostředí. Od P32B T6 běží proti
 * skutečným modulům (`GENRE_MODULES`), ne proti dvojníkům.
 */

import { readFileSync } from 'node:fs';

import { beforeAll, describe, expect, it } from 'vitest';

import { goldenPrompts } from '../../../../evals/play/golden';
import sentenceSet from '../../../../evals/play/p32/sentences.json';
import { draftForControl, draftGameSpecWithMeta } from '../../draft/draft';
import { singular } from '../../draft/lexicon';
import type { GameSpecV1 } from '../../spec';
import type { CastRole, GenreSpec } from '../contract';
import { DEFAULT_LABELS, craftOf, defaultCollectible, defaultFoe, defaultHero, heroClass, heroFits, semanticRoleDefaults } from '../roles';

const demand = JSON.parse(readFileSync(new URL('../../../../evals/play/demand/corpus.json', import.meta.url), 'utf8')) as { readonly text: string }[];
const corpus = [...sentenceSet.sentences.map((entry) => entry.text), ...goldenPrompts().map((entry) => entry.prompt), ...demand.map((entry) => entry.text)];

const draft = (sentence: string) => draftGameSpecWithMeta(sentence, 1);
/** Co hráč vidí: titulek, popisky rolí, cíl a nápověda. Id rolí drží fixtury kvůli hashům („roomba“), ta hráč nevidí. */
const shown = (spec: GameSpecV1): string => JSON.stringify([spec.title, spec.roles.map((role) => role.label), spec.objective.description, spec.tutorial]);
/** Popisek první položky obsazení s rolí z `does`. */
const castLabel = (genre: GenreSpec, ...does: CastRole[]): string | undefined => genre.cast?.find((item) => does.includes(item.does))?.label;
const sentence = (id: string): string => sentenceSet.sentences.find((entry) => entry.id === id)!.text;

/** Slovo popisku ve větě i v jiném čísle („ghost“ ve „ghosts“, „puppy“ v „puppies“, „knife“ v „knives“). */
function said(word: string, text: string): boolean {
  if (word === 'snowman' && /\bsnowmen\b/.test(text)) return true;
  const stem = word.replace(/(?:ies|es|s|y)$/, '');
  return new RegExp(`\\b(?:${word}|${stem}(?:s|es|ies|y|ys)?)\\b`).test(text) || text.split(/[^a-z']+/).some((spoken) => singular(spoken) === word);
}

/** Popisek je z věty, když tam je každé jeho slovo, jinak musí být výchozí ze smlouvy rolí. */
const fromSentenceOrDefault = (label: string, text: string): boolean =>
  DEFAULT_LABELS.has(label.toLowerCase()) || semanticRoleDefaults(text).includes(label.toLowerCase()) || label.toLowerCase().split(/[^a-z0-9']+/).filter(Boolean).every((word) => said(word, text.toLowerCase()));

describe('roles of a new game', () => {
  it.each(corpus)('come only from the sentence or setting defaults: %s', (text) => {
    const genre = draft(text).genre;
    const labels = genre === null ? [] : [genre.hero, ...(genre.cast ?? []).map((item) => item.label)];
    const strays = labels.filter((label) => !fromSentenceOrDefault(label, text));
    expect(strays).toEqual([]);
  });

  it.each(corpus.filter((text) => !/roomba/i.test(text)))('never carry an unnamed fixture Roomba: %s', (text) => {
    expect(shown(draft(text).spec)).not.toMatch(/roomba/i);
  });

  it.each(sentenceSet.sentences)('give $id the genre, mode and hero the set expects', (entry) => {
    const meta = draft(entry.text);
    const genre = meta.genre!;
    // P41 prioritizes the explicit movement over the legacy single interaction:
    // jumping over logs is jump; riding a broom is drive in the current table.
    const movement = entry.id === 'firefighter' ? 'jump' : entry.id === 'wizard' ? 'drive' : null;
    if (movement !== null) {
      expect(meta.intent?.items).toContainEqual(expect.objectContaining({ axis: 'move', verb: movement, essential: true }));
      expect(meta.composition?.recipe.move).toBe(movement);
    }
    // P42 chooses movement once: an escape the sentence gives no movement for runs the course
    // with its pursuer and pickups – the walker was only main's cell-list tie-break.
    if (entry.id === 'cat') expect(meta.composition?.recipe).toMatchObject({ move: 'run', objective: 'escape', actions: ['collect'], threats: ['chaser'] });
    const expected = entry.id === 'firefighter' ? 'platformer.default' : entry.id === 'wizard' ? 'voyage.race' : entry.id === 'cat' ? 'runner.default' : entry.genre;
    const [id, mode] = expected.split('.');
    const nativeMove = entry.id === 'dog' ? 'walk' : null;
    if (entry.id === 'rocket') {
      expect(meta.composition?.recipe.objective).toBe('land');
      expect(meta.composition?.recipe.move).toBe('glide');
      expect(meta.spec.control).toBe('steer');
      expect(meta.composition?.witnesses).toContainEqual(expect.objectContaining({ verb: 'land', object: expect.objectContaining({ label: 'mars' }) }));
    } else if (nativeMove !== null) {
      expect(meta.composition?.recipe.move).toBe(nativeMove);
      expect(meta.spec.control).toBe(nativeMove === 'walk' ? 'walker' : 'glide');
      expect(meta.spec.genre).toBeUndefined();
    } else {
      expect(genre.genre).toBe(id);
      if (mode !== undefined) expect(genre.mode).toBe(mode);
    }
    expect(genre.hero).toContain(entry.hero.split(' ').at(-1));
    expect(heroFits(genre.genre, genre.hero)).toBe(true);
  });

  it('give the pirate a boat and the wizard ghosts', () => {
    expect(heroClass(draft(sentence('pirate')).genre!.hero)).toBe('boat');
    expect(castLabel(draft(sentence('wizard')).genre!, 'chase_me', 'avoid')).toBe('ghost');
  });

  it('fill a foe the sentence leaves out from the place it is set in', () => {
    // Pes ve městě a raketa na Marsu nepřítele neříkají; hra ho má z prostředí.
    expect(castLabel(draft(sentence('dog')).genre!, 'chase_me', 'avoid')).toBe('car');
    expect(castLabel(draft(sentence('rocket')).genre!, 'chase_me', 'avoid')).toBe('asteroid');
    const mushrooms = draft('Collect five glowing mushrooms in a moonlit forest').genre!;
    expect(castLabel(mushrooms, 'collect')).toBe('glowing mushroom');
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
    expect(defaultFoe(setting, 'arena')).toEqual({ label: enemy, does: 'chase_me' });
  });

  it('the foe of the place plays the role its genre gives an unnamed foe', () => {
    // Výchozí obsazení: les dá vlka, žánr říká, co vlk dělá – střílečka ho sestřelí. Čemu se žánr jen
    // vyhýbá, je překážka na trati, a ta je v lese kmen (P46D T6).
    expect(defaultFoe('dark forest', 'platformer')).toEqual({ label: 'log', does: 'avoid' });
    expect(defaultFoe('dark forest', 'shooter')).toEqual({ label: 'wolf', does: 'shoot_at' });
    expect(defaultFoe('dark forest', 'duel')).toEqual({ label: 'wolf', does: 'fight' });
    expect(defaultFoe('village', 'timing')).toEqual({ label: 'wind', does: 'scenery' });
  });

  it('fall back per genre when the place is unknown', () => {
    expect(defaultFoe('village', 'runner')).toEqual({ label: 'rock', does: 'avoid' });
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

// Composition now executes physical ball witnesses even in synchronous draft tests.
beforeAll(async () => { await loadRapier(); });
