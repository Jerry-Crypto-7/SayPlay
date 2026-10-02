/**
 * Žánr Úkol (P32G T4): hasič hasí hořící stromy, čaroděj zapaluje pět svíček,
 * než ho chytí duchové, kuchař obrací palačinky. Co by vypadalo dobře a přitom
 * bylo špatně: věta dojde ke hře, která se hraje (sběr v aréně), ale sloveso
 * nemá druh vizuálu, předmět má jiný počet stavů, než kolik jich scéna umí
 * nakreslit, nebo robot vyhraje hru, ve které se sloveso vůbec nedokázalo.
 */

import { describe, expect, it } from 'vitest';

import { arcadeWorldOf, generatorOf } from '@/play/arcade/compile';
import { BODY, FLAG, HEADER, ROLE, bodyBase } from '@/play/arcade/contract';
import { instantiate } from '@/play/arcade/kernel';
import { verifyArcade } from '@/play/arcade/verify';
import { type GameSpecV1, readGameSpec } from '@/play/spec';

import type { GenreSpecOf } from '../contract';
import { GENRE_MODULES, compileGenre, readGenreSpec } from '../index';
import { KIND_STATES, VERB_KIND, verbKindOf } from '../quest';

const HEROES = {
  hasič: 'A firefighter puts out burning trees in a forest',
  čaroděj: 'A tiny wizard lights five candles before the ghosts catch him',
  kuchař: 'A chef flips pancakes in a restaurant kitchen',
} as const;

/** Věta → úplný `GenreSpec`: co věta neřekne (hrdina, prostředí), doplní test. */
function draft(sentence: string): GenreSpecOf<'quest'> {
  const read = readGenreSpec({ hero: 'hero', setting: 'somewhere', ...GENRE_MODULES.quest.draftFill(sentence, null) });
  if (!read.ok) throw new Error(read.issues.join('; '));
  return read.value as GenreSpecOf<'quest'>;
}

function gameOf(spec: GenreSpecOf<'quest'>): GameSpecV1 {
  const read = readGameSpec(compileGenre(spec));
  if (!read.ok) throw new Error(`${read.reason}: ${read.issues.join('; ')}`);
  return read.value;
}

/** Počty těl podle role jádra na semínku 1. */
function rolesOf(game: GameSpecV1): Map<number, number> {
  const made = arcadeWorldOf(game, 1);
  if (!made.ok) throw new Error(made.issues.join('; '));
  const state = instantiate(made.world);
  const counts = new Map<number, number>();
  for (let body = 0; body < (state[HEADER.bodyCount] as number); body += 1) {
    // Mrtvé předlohy dalších kol (P36A T4) na startu nehrají.
    if (((state[bodyBase(body) + BODY.flags] as number) & FLAG.alive) === 0) continue;
    const role = state[bodyBase(body) + BODY.role] as number;
    counts.set(role, (counts.get(role) ?? 0) + 1);
  }
  return counts;
}

/** Jako dveře publikace: první z osmi semínek, na kterém robot vyhraje a sloveso dokáže. */
function firstProvenSeed(game: GameSpecV1): { readonly seed: number; readonly failures: readonly string[]; readonly evidence: string | null } {
  let last = { seed: 0, failures: ['no seed tried'] as readonly string[], evidence: null as string | null };
  for (let seed = 1; seed <= 8; seed += 1) {
    const made = arcadeWorldOf(game, seed);
    if (!made.ok) return { seed, failures: made.issues, evidence: null };
    const verdict = verifyArcade(made.world);
    last = { seed, failures: verdict.failures, evidence: verdict.verbs[0]?.evidence ?? null };
    if (verdict.failures.length === 0) return last;
  }
  return last;
}

describe('quest genre – the sentence picks the mode, the verb kind and the target', () => {
  it('hasič: spatial, fire with three states, burning trees, one default chaser (P36A T3)', () => {
    const spec = draft(HEROES.hasič);
    expect(spec.mode).toBe('spatial');
    expect(spec.target?.label).toMatch(/trees$/);
    expect(verbKindOf(spec.target?.verb ?? '')).toBe('fire');
    expect(spec.target?.states).toBe(3);
    // Věta honičku neříká: jeden výchozí pronásledovatel, ne dva jako u „before the ghosts catch“.
    expect(spec.params?.chasers).toBe(1);
  });

  it('čaroděj: spatial, flame with two states, five candles, ghosts chasing', () => {
    const spec = draft(HEROES.čaroděj);
    expect(spec.mode).toBe('spatial');
    expect(spec.target).toEqual({ label: 'candles', verb: 'light', states: 2 });
    expect(verbKindOf('light')).toBe('flame');
    expect(spec.params?.count).toBe(5);
    expect(spec.enemy).toBe('ghosts');
    expect(spec.params?.chasers).toBeGreaterThan(0);
    const roles = rolesOf(gameOf(spec));
    expect(roles.get(ROLE.target)).toBe(5);
    expect(roles.get(ROLE.chaser)).toBe(spec.params?.chasers);
  });

  it('kuchař: station, cook with three states, pancakes', () => {
    const spec = draft(HEROES.kuchař);
    expect(spec.mode).toBe('station');
    expect(spec.target).toEqual({ label: 'pancakes', verb: 'flip', states: 3 });
    expect(verbKindOf('flip')).toBe('cook');
  });

  it.each(Object.entries(HEROES))('%s compiles to its quest generator, the bot wins and proves the verb', (_hero, sentence) => {
    const spec = draft(sentence);
    const game = gameOf(spec);
    expect(generatorOf(game)).toBe(spec.mode === 'station' ? 'quest_station' : 'quest_spatial');
    const proof = firstProvenSeed(game);
    expect(proof.failures).toEqual([]);
    expect(proof.evidence).toMatch(/now in state/);
  });

  it('the rule carries the verb as one word, so "put out" still reads as fire', () => {
    const made = arcadeWorldOf(gameOf(draft(HEROES.hasič)), 1);
    if (!made.ok) throw new Error(made.issues.join('; '));
    const verb = made.world.rules.find((rule) => rule.id === 'interact')?.params.verb;
    expect(verb).toBe('put-out');
    expect(verbKindOf(verb as string)).toBe('fire');
  });

  it('the clock follows the work: eight burning trees with three chasers stay one long round, five candles get three rounds', () => {
    const timerOf = (game: GameSpecV1) => (game.mechanics.find((mechanic) => mechanic.id === 'timer')?.params as { seconds: number }).seconds;
    const roundsOf = (game: GameSpecV1) => (game.controlParams as { tuning?: { rounds?: number } }).tuning?.rounds;
    const hard = { ...draft(HEROES.hasič), enemy: 'ghosts', params: { count: 8, chasers: 3 } };
    // Hodiny = odhad robota × 1,5 + 15 s, nejvýš 88 s (P36A T4); dlouhá práce zůstane v jednom kole.
    expect(roundsOf(gameOf(hard))).toBeUndefined();
    expect(timerOf(gameOf(hard))).toBe(87);
    expect(roundsOf(gameOf(draft(HEROES.čaroděj)))).toBe(3);
    expect(timerOf(gameOf(draft(HEROES.čaroděj)))).toBe(88);
    expect(timerOf(gameOf({ ...hard, params: { ...hard.params, seconds: 30 } }))).toBe(30);
  });

  it('a spec whose target states disagree with the verb kind plays the states the scene can draw', () => {
    const spec = { ...draft(HEROES.čaroděj), target: { label: 'candles', verb: 'light', states: 3 as const } };
    const made = arcadeWorldOf(gameOf(spec), 1);
    if (!made.ok) throw new Error(made.issues.join('; '));
    const interact = made.world.rules.find((rule) => rule.id === 'interact')?.params as { when: { interact: { states: number } } };
    expect(interact.when.interact.states).toBe(KIND_STATES.flame);
  });
});

describe('quest genre – module shape', () => {
  it('has every quest verb as a cue and both modes ready', () => {
    expect([...GENRE_MODULES.quest.cues].sort()).toEqual(
      ['light', 'ignite', 'extinguish', 'spray', 'put out', 'cook', 'bake', 'flip', 'fry', 'repair', 'fix', 'free', 'rescue', 'unlock', 'water', 'plant', 'paint'].sort(),
    );
    expect(GENRE_MODULES.quest.availability('spatial')).toBe('ready');
    expect(GENRE_MODULES.quest.availability('station')).toBe('ready');
  });

  it('maps every verb to its kind and every kind to its visible states', () => {
    expect(VERB_KIND).toEqual({
      extinguish: 'fire',
      spray: 'fire',
      'put out': 'fire',
      light: 'flame',
      ignite: 'flame',
      cook: 'cook',
      bake: 'cook',
      fry: 'cook',
      flip: 'cook',
      repair: 'repair',
      fix: 'repair',
      free: 'free',
      rescue: 'free',
      unlock: 'free',
      water: 'grow',
      plant: 'grow',
    });
    expect(KIND_STATES).toEqual({ fire: 3, flame: 2, cook: 3, repair: 2, free: 2, grow: 3 });
    expect(verbKindOf('constructor')).toBeNull();
    expect(verbKindOf('paint')).toBeNull();
  });

  it('paramBounds refuse a value outside the generator bounds', () => {
    const base = draft(HEROES.čaroděj);
    for (const [key, value] of [['count', 9], ['count', 0], ['chasers', 4], ['seconds', 90]] as const) {
      expect(readGenreSpec({ ...base, params: { [key]: value } }).ok, `${key} ${value}`).toBe(false);
    }
  });

  it('draftFill keeps a station within the three places of the counter', () => {
    const spec = draft('A chef fries eight eggs in a kitchen');
    expect(spec.mode).toBe('station');
    expect(spec.params?.count).toBe(3);
  });

  it('draftFill caps the chasers a sentence names at three instead of refusing the quest', () => {
    const spec = draft('A tiny wizard lights five candles before six ghosts catch him');
    expect(spec.enemy).toBe('ghosts');
    expect(spec.params?.chasers).toBe(3);
  });
});
