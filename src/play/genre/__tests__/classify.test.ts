/**
 * Klasifikátor žánru (P32B T1): věta → žánr a režim. Špatně zařazená věta dá
 * funkční, jen nesprávnou hru, a to by na snímku nikdo nepoznal – proto pin nad
 * pevnou sadou P32 (`evals/play/p32/sentences.json`) a nad draftovým korpusem.
 * Sada 9 vět běží od P32B T6 proti skutečným modulům; dvojníci (`./doubles`)
 * zůstali tam, kde test potřebuje režim `fallback`.
 */

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { goldenPrompts } from '../../../../evals/play/golden';
import sentenceSet from '../../../../evals/play/p32/sentences.json';
import type { Reading } from '../../read/schema';
import { readGameSpec } from '../../spec';
import { classifyGenre } from '../classify';
import type { GenreModule, GenreSpec } from '../contract';
import { GENRE_MODULES } from '../index';

import { genreDoubles } from './doubles';

const demand = JSON.parse(readFileSync(new URL('../../../../evals/play/demand/corpus.json', import.meta.url), 'utf8')) as { readonly text: string }[];

const LEGACY_CONTROLS = ['tap_go', 'flap', 'shooter', 'throw', 'timing', 'rhythm'];

const top = (sentence: string, modules = genreDoubles()) => classifyGenre(sentence, null, modules).ranked[0];

describe('classifyGenre', () => {
  it.each(sentenceSet.sentences)('puts the expected genre and mode first for $id', (entry) => {
    const [genre, mode] = entry.genre.split('.');
    const result = classifyGenre(entry.text, null, GENRE_MODULES);
    expect(result.ranked[0].genre).toBe(genre);
    if (mode !== undefined) expect(result.ranked[0].mode).toBe(mode);
    expect(result.ranked[0].score).toBeGreaterThan(0);
    expect(result.verb).toBe(entry.verb);
    expect(result.fallback).toBe(false);
  });

  it('never puts a fallback mode first while a ready mode scored', () => {
    // Úkol hraje náhradu: čaroděj dostane hratelný ready žánr, ne pahýl.
    const wizard = classifyGenre('A tiny wizard rides a broom through a haunted castle and must light five candles before the ghosts catch him', null, genreDoubles(['quest.spatial', 'quest.station']));
    expect(wizard.ranked[0].genre).not.toBe('quest');
    expect(wizard.fallback).toBe(false);
    // Úkol pořád slyšel nejvíc – oprava ho zkusí, jen ne jako první.
    expect(wizard.ranked.findIndex((choice) => choice.genre === 'quest')).toBeGreaterThan(0);
  });

  it('puts a fallback mode first only when nothing else scored, and says so', () => {
    const chef = classifyGenre('A chef cooks pancakes', null, genreDoubles(['quest.spatial', 'quest.station']));
    expect(chef.ranked[0]).toMatchObject({ genre: 'quest', mode: 'station' });
    expect(chef.fallback).toBe(true);
    const rocket = classifyGenre('A rocket lands on Mars', null, genreDoubles(['voyage.land']));
    expect(rocket.ranked[0]).toMatchObject({ genre: 'voyage', mode: 'race' });
    expect(rocket.fallback).toBe(false);
  });

  // B-R3: sada 9 vět necvičí každý řádek tabulky sloves – bez těchhle vět šlo řádek odebrat a nic nezčervenalo.
  it.each([
    ['A frog jumps over logs', 'platformer.default', 'jump'],
    ['A goat climbs a mountain', 'platformer.default', 'climb'],
    ['Two robots fight in an arena', 'arena.fight', 'fight'],
    ['boxing a kangaroo in the australian outback', 'arena.fight', 'box'],
    ['A mouse collects cheese in a kitchen', 'arena.collect', 'collect'],
    ['A bird flies over the city', 'voyage.race', 'fly'],
    ['A girl drives a car through the desert', 'voyage.race', 'drive'],
    ['A boy rides a bike to school', 'voyage.race', 'ride'],
    ['A bear skis down a mountain', 'runner.default', 'ski'],
    ['A robot repairs a broken engine', 'quest.station', 'repair'],
    ['A knight frees the prisoners in a tower', 'quest.spatial', 'free'],
    ['A chef flips burgers', 'quest.station', 'cook'],
  ])('plays "%s" as %s with the verb %s', (sentence, mode, verb) => {
    const result = classifyGenre(sentence, null, GENRE_MODULES);
    expect(`${result.ranked[0].genre}.${result.ranked[0].mode}`).toBe(mode);
    expect(result.verb).toBe(verb);
  });

  it('ranks every mode of every genre once and gives a sentence with no cue the runner', () => {
    const result = classifyGenre('A key inside a glass box on a pedestal behind a locked gate.', null, genreDoubles());
    expect(result.ranked).toHaveLength(9);
    expect(new Set(result.ranked.map((choice) => `${choice.genre}.${choice.mode}`)).size).toBe(9);
    expect(result.ranked[0]).toMatchObject({ genre: 'runner', mode: 'default', score: 0 });
    expect(result.verb).toBeNull();
  });

  it('lets the reading add its main verb and chaser', () => {
    const reading: Reading = {
      control: 'move_free',
      verbs: [{ word: 'wander', class: 'move_free' }],
      hero: 'fox',
      roles: [{ noun: 'wolf', kind: 'chaser', count: 1 }],
      setting: 'forest',
      mood: null,
      numbers: { seconds: null, counts: [] },
    };
    const result = classifyGenre('A fox in a forest', reading, genreDoubles());
    expect(result.ranked[0]).toMatchObject({ genre: 'arena', mode: 'escape' });
    expect(result.ranked[0].why).toContain('reading');
  });

  it('explains the pick in words the reading panel can show', () => {
    expect(top('Two knights duel in a castle').why).toMatch(/duel/);
  });

  // P32B T5b: karta nápadu „The floor is lava“ je hra na přežití, ne běžec přes lávu (narážka `lava`).
  it('reads "the floor is lava" as a survival escape', () => {
    expect(top('The floor is lava, for 60 seconds', GENRE_MODULES)).toMatchObject({ genre: 'arena', mode: 'escape' });
  });

  it('never throws on the draft corpora and never lands a new game on a legacy control', () => {
    const sentences = [...goldenPrompts().map((entry) => entry.prompt), ...demand.map((entry) => entry.text), '', '   '];
    for (const sentence of sentences) {
      for (const modules of [genreDoubles(), GENRE_MODULES]) {
        const first = classifyGenre(sentence, null, modules).ranked[0];
        const spec = { genre: first.genre, mode: first.mode, hero: 'fox', setting: 'forest' } as GenreSpec;
        const game = (modules[first.genre] as GenreModule).compile(spec as never);
        expect(readGameSpec(game).ok, sentence).toBe(true);
        expect(LEGACY_CONTROLS, sentence).not.toContain(game.control);
      }
    }
  });
});
