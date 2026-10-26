/**
 * Cíl věty s počtem v HUD (P61 T5). „A knight must collect three keys“ hrálo `arena.collect` po vlnách:
 * 3 klíče v každé z pěti vln, výhru řídilo skóre (`grow_to`) a pilulka postupu nic neukázala. Teď věta
 * s počtem hraje právě tolik věcí, sebraná poslední vyhraje a HUD ukáže `keys 0/3`.
 *
 * Počítadlo 0/3, které vypadá správně, zatímco výhru dál řídí skóre, hraje špatně – proto test hraje
 * robotem do výhry a čte čítač sebraných, a zvlášť ověří, že samo skóre nevyhraje.
 */

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { collectGoal } from '@/components/play/arcade/ArcadePlay';
import { GameHud } from '@/components/play/ui';
import { draftGameSpecWithMeta } from '@/play/draft/draft';
import { goalNoun } from '@/play/draft/lexicon';
import type { GameSpecV1 } from '@/play/spec';

import { arcadeWorldOf } from '../compile';
import { type ArcadeWorld, COUNTER, HEADER, type InputEvent, NO_INPUT, ROLE, BODY, bodyBase, nativeRule } from '../contract';
import { instantiate, loadProgram, outcomeOf, step } from '../kernel';
import { ARCADE_LIBRARY } from '../library';
import { countedWaves } from '../pieces/arena';
import { verifyArcade } from '../verify';

const KEYS = 'A knight must collect three keys in a haunted castle';
const KEYS_PLAIN = 'A knight collects keys in a haunted castle';
const CANDLES = 'A wizard lights five candles in a dark forest';
const CANDLES_PLAIN = 'A wizard lights candles in a dark forest';
const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8];

const draft = (sentence: string): GameSpecV1 => draftGameSpecWithMeta(sentence, 1).spec;

function worldOf(spec: GameSpecV1, seed: number): ArcadeWorld {
  const made = arcadeWorldOf(spec, seed);
  if (!made.ok) throw new Error(made.issues.join('; '));
  return made.world;
}

const tuning = (spec: GameSpecV1): Readonly<Record<string, unknown>> => (spec.controlParams as { readonly tuning: Readonly<Record<string, unknown>> }).tuning;
const ruleIds = (world: ArcadeWorld): string[] => world.rules.map((rule) => rule.id);
const items = (state: Int32Array): number => state[HEADER.counters + COUNTER.items] as number;

/** Stav po přehrání záznamu (táž smyčka jako `replay` v jádře) – čítače na konci běhu. */
function finalState(world: ArcadeWorld, inputs: readonly InputEvent[]): Int32Array {
  const program = loadProgram(world, ARCADE_LIBRARY);
  const state = instantiate(world);
  let next = 0;
  for (let tick = 0; tick < 5400 && outcomeOf(state) === 'running'; tick += 1) {
    while (next < inputs.length && (inputs[next] as InputEvent).tick < tick) next += 1;
    const event = inputs[next];
    step(state, event !== undefined && event.tick === tick ? event : NO_INPUT, program);
  }
  return state;
}

/** Věcí role `collectible` v úrovni a ve vlnách dalších kol (`arena_waves`, x a z po dvojicích). */
function plannedItems(world: ArcadeWorld): number {
  const state = world.initial;
  let placed = 0;
  for (let i = 0; i < (state[HEADER.bodyCount] as number); i += 1) {
    if (state[bodyBase(i) + BODY.role] === ROLE.collectible && world.kinds[state[bodyBase(i) + BODY.kind] as number] === 'item') placed += 1;
  }
  const waves = (nativeRule(world.rules, 'arena_waves')?.params.waves ?? []) as readonly { readonly items?: readonly number[] }[];
  return placed + waves.reduce((sum, wave) => sum + (wave.items?.length ?? 0) / 2, 0);
}

const html = (world: ArcadeWorld, count: number): string =>
  renderToStaticMarkup(createElement(GameHud, { title: 'Knight Hunt', goalLine: 'Collect 3 keys.', goal: collectGoal(world, count), clock: { seconds: 0, countdown: false }, objective: false }));

describe('goalNoun', () => {
  it('takes the last word of the label in the plural, or nothing the HUD could not show', () => {
    expect(goalNoun('key')).toBe('keys');
    expect(goalNoun('glowing mushroom')).toBe('mushrooms');
    expect(goalNoun('golden apple')).toBe('apples');
    expect(goalNoun('t-shirt')).toBeNull();
  });
});

describe('arena.collect: a sentence with a count', () => {
  const spec = draft(KEYS);

  it('three keys: need 3, the noun "keys", and the HUD pill reads "keys 0/3"', () => {
    expect(spec.genre).toMatchObject({ id: 'arena', mode: 'collect' });
    expect(tuning(spec)).toEqual({ items: 3, counted: true, noun: 'keys' });
    expect(spec.tutorial.goalLine).toBe('Collect 3 keys.');
    const world = worldOf(spec, 1);
    expect(nativeRule(world.rules, 'finish_collected')?.params).toEqual({ need: 3, noun: 'keys' });
    expect(plannedItems(world)).toBe(3);
    expect(collectGoal(world, 0)).toEqual({ label: 'keys', count: 0, need: 3, said: true });
    const pill = html(world, 0);
    expect(pill).toContain('data-testid="hud-counter-keys"');
    expect(pill).toContain('keys 0/3');
    expect(pill).not.toContain('collected');
  });

  it('the count decides the win, not the score: no grow_to, and 100 points without a key do not win', () => {
    const world = worldOf(spec, 1);
    expect(ruleIds(world)).not.toContain('grow_to');
    expect(ruleIds(world)).toContain('catch_goal');
    const program = loadProgram(world, ARCADE_LIBRARY);
    const state = instantiate(world);
    step(state, NO_INPUT, program);
    state[HEADER.counters + COUNTER.score] = 100;
    for (let tick = 0; tick < 5; tick += 1) step(state, NO_INPUT, program);
    expect(outcomeOf(state)).toBe('running');
    state[HEADER.counters + COUNTER.items] = 3;
    for (let tick = 0; tick < 3 && outcomeOf(state) === 'running'; tick += 1) step(state, NO_INPUT, program);
    expect(outcomeOf(state)).toBe('won');
  });

  it.each(SEEDS)('seed %i: the robot collects exactly three keys and wins, an idle player loses, the replay is identical', (seed) => {
    const world = worldOf(spec, seed);
    const verdict = verifyArcade(world);
    expect(verdict.failures).toEqual([]);
    expect(verdict.bot.outcome).toBe('won');
    expect(verdict.idle.outcome).toBe('lost');
    expect(verdict.replayEqual).toBe(true);
    expect(items(finalState(world, verdict.bot.inputs))).toBe(3);
  });

  it('splits the count into at most three waves, the biggest first', () => {
    expect(countedWaves(1)).toEqual([1]);
    expect(countedWaves(3)).toEqual([1, 1, 1]);
    expect(countedWaves(10)).toEqual([4, 3, 3]);
    expect(countedWaves(30)).toEqual([10, 10, 10]);
  });
});

describe('arena.collect: a sentence without a count is unchanged', () => {
  it('keeps the waves, the score win and the plain "collected" goal', () => {
    const spec = draft(KEYS_PLAIN);
    expect(spec.genre).toMatchObject({ id: 'arena', mode: 'collect' });
    expect(tuning(spec)).toEqual({ items: 10, waves: 3 });
    expect(spec.tutorial.goalLine).toBe('Collect 10 keys per wave, 3 waves.');
    const world = worldOf(spec, 1);
    expect(ruleIds(world)).toContain('grow_to');
    expect(ruleIds(world)).not.toContain('finish_collected');
    expect(collectGoal(world, 0)).toBeNull();
  });
});

describe('quest.spatial: a sentence with a count', () => {
  const spec = draft(CANDLES);

  it('five candles: one round of five, need 5 and "candles 0/5"', () => {
    expect(spec.genre).toMatchObject({ id: 'quest', mode: 'spatial' });
    expect(tuning(spec)).toMatchObject({ count: 5, counted: true, noun: 'candles' });
    expect(tuning(spec).rounds).toBeUndefined();
    const world = worldOf(spec, 1);
    expect(nativeRule(world.rules, 'finish_collected')?.params).toEqual({ need: 5, noun: 'candles' });
    expect(html(world, 0)).toContain('candles 0/5');
  });

  it.each(SEEDS)('seed %i: the robot lights all five and wins with the counter at 5, an idle player loses, the replay is identical', (seed) => {
    const world = worldOf(spec, seed);
    const verdict = verifyArcade(world);
    expect(verdict.failures).toEqual([]);
    expect(verdict.idle.outcome).toBe('lost');
    expect(items(finalState(world, verdict.bot.inputs))).toBe(5);
  });

  it('without a count it keeps its rounds and no HUD goal', () => {
    const plain = draft(CANDLES_PLAIN);
    expect(plain.genre).toMatchObject({ id: 'quest', mode: 'spatial' });
    expect(tuning(plain).counted).toBeUndefined();
    expect(tuning(plain).rounds).toBeGreaterThan(1);
    expect(collectGoal(worldOf(plain, 1), 0)).toBeNull();
  });
});
