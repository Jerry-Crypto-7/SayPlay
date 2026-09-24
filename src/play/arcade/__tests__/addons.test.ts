/**
 * Doplňky arkády (P26D): druhá mechanika nad základním ovládáním. Pin je
 * hash světa se doplňkem a bez něj a výhra robota přes 20 semínek – doplněk,
 * který se zapíše do specu, ale do úrovně se nepromítne, by test tvaru prošel.
 */

import { describe, expect, it } from 'vitest';

import { canonicalHash } from '@/ir/worlddoc';
import { type AddonId, type GameSpecV1, readGameSpec } from '@/play/spec';

import arena from '../__fixtures__/arena.json';
import flap from '../__fixtures__/flap.json';
import platform from '../__fixtures__/platform.json';
import runner from '../__fixtures__/runner.json';
import shooter from '../__fixtures__/shooter.json';
import steer from '../__fixtures__/steer.json';
import { arcadeWorldOf } from '../compile';
import { type ArcadeWorld, COUNTER, HEADER, NO_INPUT } from '../contract';
import { instantiate, loadProgram, step } from '../kernel';
import { ARCADE_LIBRARY } from '../library';
import { runBot, verifyArcade } from '../verify';

const SEEDS = Array.from({ length: 20 }, (_, index) => (index + 1) * 7919);

export function specOf(fixture: unknown, addons: readonly AddonId[] = []): GameSpecV1 {
  const read = readGameSpec({ ...(fixture as object), ...(addons.length === 0 ? {} : { addons }) });
  if (!read.ok) throw new Error(read.issues.join('; '));
  return read.value;
}

export function worldOf(spec: GameSpecV1, seed: number) {
  const made = arcadeWorldOf(spec, seed);
  if (!made.ok) throw new Error(made.issues.join('; '));
  return made.world;
}

/** Semínka, na kterých hra neprošla, s prvním důvodem. */
export function failing(spec: GameSpecV1): string[] {
  return SEEDS.flatMap((seed) => {
    const verdict = verifyArcade(worldOf(spec, seed));
    return verdict.failures.length === 0 ? [] : [`${seed}: ${verdict.failures[0]}`];
  });
}

describe('addon hook and +lives (P26D T3)', () => {
  it('a game without addons keeps the world it had before the hook', () => {
    // Naměřeno před háčkem (c631214) nad `runner.json`, semínko 7.
    expect(canonicalHash(worldOf(specOf(runner), 7))).toBe('61e583cc');
  });

  it.each([
    ['runner', runner],
    ['platform', platform],
    ['flap', flap],
  ])('%s +lives starts with three lives and a hit only takes one', (_control, fixture) => {
    const plain = worldOf(specOf(fixture), 7);
    const lives = worldOf(specOf(fixture, ['lives']), 7);
    expect(canonicalHash(lives)).not.toBe(canonicalHash(plain));
    expect(lives.initial[HEADER.counters + COUNTER.health]).toBe(3);
    expect(lives.rules.some((rule) => rule.id === 'out_of_health')).toBe(true);
    expect(lives.rules.some((rule) => rule.params.effect === 'lose' && rule.id === 'hit')).toBe(false);
  });

  it.each([
    ['runner', runner],
    ['platform', platform],
    ['flap', flap],
  ])('%s +lives passes the arcade gate on 20 seeds', (_control, fixture) => {
    expect(failing(specOf(fixture, ['lives']))).toEqual([]);
  });

  // Obal `addon_bot` má pevných 8 tiků; robot s jinou reakcí by pod ním viděl jinak staré stavy.
  it('every base bot reacts in the 8 ticks the addon wrapper assumes', () => {
    for (const [id, bot] of Object.entries(ARCADE_LIBRARY.bots)) expect(bot.reactionTicks, id).toBe(8);
  });

  it('an explicit health mechanic wins over the default three lives', () => {
    const spec = specOf(runner, ['lives']);
    const five = { ...spec, mechanics: [{ id: 'health', params: { max: 5 } }] } as GameSpecV1;
    expect(worldOf(five, 7).initial[HEADER.counters + COUNTER.health]).toBe(5);
  });
});

/** Stav po robotově hře – kolik mincí sebral. */
function afterBot(world: ArcadeWorld): Int32Array {
  const run = runBot(world);
  const state = instantiate(world);
  const program = loadProgram(world, ARCADE_LIBRARY);
  const byTick = new Map(run.inputs.map((input) => [input.tick, input]));
  for (let tick = 0; tick < run.tick; tick += 1) step(state, byTick.get(tick) ?? NO_INPUT, program);
  return state;
}

const needOf = (world: ArcadeWorld): number => world.rules.find((rule) => rule.id === 'finish_collected')?.params.need as number;

describe('+shoot (P26D T5)', () => {
  it.each([
    ['runner', runner],
    ['platform', platform],
    ['flap', flap],
    ['move_free', arena],
  ])('%s +shoot passes the gate on 20 seeds and the bot hits something', (_control, fixture) => {
    const spec = specOf(fixture, ['shoot']);
    expect(failing(spec)).toEqual([]);
    const world = worldOf(spec, 7);
    expect(world.control.id).toBe('addon_control');
    const state = afterBot(world);
    // Každý zásah stál náboj a přidal bod; minutí by náboj stálo bez bodu.
    expect(state[HEADER.counters + COUNTER.ammo]).toBeLessThan(world.initial[HEADER.counters + COUNTER.ammo] as number);
    expect(state[HEADER.counters + COUNTER.score]).toBeGreaterThan(0);
  });
});

describe('+collect (P26D T4)', () => {
  it.each([
    ['runner', runner],
    ['platform', platform],
    ['flap', flap],
  ])('%s +collect gates the finish on coins and the wrapped bot still wins on 20 seeds', (_control, fixture) => {
    const spec = specOf(fixture, ['collect']);
    const world = worldOf(spec, 7);
    expect(world.rules.some((rule) => rule.id === 'finish')).toBe(false);
    expect(needOf(world)).toBeGreaterThan(0);
    expect(failing(spec)).toEqual([]);
    for (const seed of SEEDS.slice(0, 5)) {
      const played = worldOf(spec, seed);
      expect(afterBot(played)[HEADER.counters + COUNTER.items], `seed ${seed}`).toBeGreaterThanOrEqual(needOf(played));
    }
  });

  it('a runner that reaches the finish without enough coins loses', () => {
    const world = worldOf(specOf(runner, ['collect']), 7);
    // Základní robot bez obalu mince nehoní: trať proběhne, ale na pásce mu chybí.
    const plain = { ...world, bot: (world.bot.params as { base: ArcadeWorld['bot'] }).base };
    expect(runBot(plain).outcome).toBe('lost');
  });

  it('the level keeps coins even when the spec switched them off', () => {
    const spec = specOf({ ...(platform as object), controlParams: { ...platform.controlParams, coins: false } }, ['collect']);
    expect(worldOf(spec, 7).kinds).toContain('coin');
  });

  it('move_free, steer and shooter do not take +collect', () => {
    for (const fixture of [arena, steer, shooter]) expect(readGameSpec({ ...(fixture as object), addons: ['collect'] }).ok).toBe(false);
  });
});
