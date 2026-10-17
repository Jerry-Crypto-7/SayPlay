import { describe, expect, it } from 'vitest';

import { type ArcadeWorld, BODY, type BodyInit, HEADER, UNIT, bodyBase } from '../../../contract';
import { instantiate, replay } from '../../../kernel';
import { ARCADE_LIBRARY } from '../../../library';
import { runBot } from '../../../verify';
import { ARENA } from '../../arena';
import { PACING } from '../../pacing';
import { type BehaviourSpace, behaviourBodies, stepBehaviours } from '../index';
import { SWARM } from '../swarm';
import { HEALTH, behaviourHarness, healthAfter, play, refsOf, telegraphCheck } from './harness';

const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8];
const SPACES: readonly BehaviourSpace[] = ['plane', 'track'];

/** Hejno `SWARM.size` těl: v aréně v rohu vedle sebe, na trati za hráčem u kraje za sebou. */
function flock(space: BehaviourSpace, seed: number, count: number = SWARM.size):(bodies: readonly BodyInit[]) => { x: number; z: number }[] {
  const side = seed % 2 === 0 ? 1 : -1;
  return (bodies) => Array.from({ length: count }, (_, k) =>
    space === 'plane'
      ? { x: side * 12 * UNIT + ((k % 4) - 1) * SWARM.spacing, z: (seed % 4 < 2 ? 1 : -1) * 12 * UNIT + Math.floor(k / 4) * SWARM.spacing }
      : { x: side * SWARM.track.edge, z: (bodies[0] as BodyInit).z - 5 * UNIT - k * SWARM.spacing });
}

const swarm = (space: BehaviourSpace, seed: number): { world: ArcadeWorld; body: number } => behaviourHarness(space, 'swarm', seed, { place: flock(space, seed) });

const liveSwarm = (world: ArcadeWorld, state: Int32Array): number => behaviourBodies(state, state[HEADER.player] as number, refsOf(world)).length;

describe('swarm', () => {
  it.each(SPACES)('(a) the threat probe walks into it, gets hit, and the body that hit is gone – %s', (space) => {
    for (const seed of [1, 2]) {
      const { world, body } = swarm(space, seed);
      const inputs = runBot(world, ARCADE_LIBRARY, { probeBody: body }).inputs;
      expect(healthAfter(world, inputs)).toBeLessThan(HEALTH);
      expect(liveSwarm(world, play(world, inputs, () => undefined))).toBeLessThan(SWARM.size);
    }
  });

  it.each(SPACES)('(b) the intermediate bot wins at least 7 of 8 seeds, idle wins none – %s', (space) => {
    const outcomes = SEEDS.map((seed) => {
      const { world } = swarm(space, seed);
      return { bot: runBot(world, ARCADE_LIBRARY, { profile: 'intermediate' }).outcome, idle: replay(world, [], ARCADE_LIBRARY).outcome };
    });
    expect(outcomes.filter((run) => run.bot === 'won').length).toBeGreaterThanOrEqual(7);
    expect(outcomes.filter((run) => run.idle === 'won')).toEqual([]);
  });

  it.each(SPACES)('(c) no body of the swarm strikes without a full cluster warning first – %s', (space) => {
    let hits = 0;
    for (const seed of SEEDS) {
      const { world, body } = swarm(space, seed);
      for (const inputs of [[], runBot(world, ARCADE_LIBRARY, { profile: 'intermediate' }).inputs, runBot(world, ARCADE_LIBRARY, { probeBody: body }).inputs]) {
        const check = telegraphCheck(world, inputs);
        expect(check.violations).toEqual([]);
        hits += check.hits;
      }
    }
    expect(hits).toBeGreaterThan(SEEDS.length);
  });

  it.each(SPACES)('(d) replays the bot record to the same hash – %s', (space) => {
    const { world } = swarm(space, 3);
    const bot = runBot(world, ARCADE_LIBRARY, { profile: 'intermediate' });
    expect(replay(world, bot.inputs, ARCADE_LIBRARY).hash).toBe(bot.hash);
    expect(replay(world, bot.inputs, ARCADE_LIBRARY).hash).toBe(bot.hash);
  });

  it('(e) scheduled swarms arrive whole, but never more live bodies than maxActors', () => {
    const corners = [-15 * UNIT, -15 * UNIT, 15 * UNIT, -15 * UNIT, 15 * UNIT, 15 * UNIT, -15 * UNIT, 15 * UNIT];
    let peak = 0;
    for (const seed of [1, 2, 3, 4]) {
      const { world } = behaviourHarness('plane', 'swarm', seed, { place: () => [], budget: 8, spots: corners, ticks: 900 });
      for (const inputs of [[], runBot(world, ARCADE_LIBRARY, { profile: 'intermediate' }).inputs]) {
        play(world, inputs, (state) => {
          const live = liveSwarm(world, state);
          expect(live).toBeLessThanOrEqual(PACING.maxActors);
          peak = Math.max(peak, live);
        });
      }
    }
    expect(peak).toBe(PACING.maxActors);
  });

  it('(f) the behaviour step costs at most 0.05 ms per tick with 12 bodies (mean over 5400 ticks)', () => {
    const { world } = behaviourHarness('plane', 'swarm', 1, { place: flock('plane', 1, PACING.maxActors) });
    const state = instantiate(world);
    const player = state[HEADER.player] as number;
    const refs = refsOf(world);
    const bodies = behaviourBodies(state, player, refs);
    expect(bodies.length).toBe(PACING.maxActors);
    const tick = (): void => {
      state[HEADER.tick] = (state[HEADER.tick] as number) + 1;
      stepBehaviours(state, player, refs, 'plane', 1000, ARENA.half);
      for (const body of bodies) {
        const base = bodyBase(body);
        state[base + BODY.x] = (state[base + BODY.x] as number) + (state[base + BODY.vx] as number);
        state[base + BODY.z] = (state[base + BODY.z] as number) + (state[base + BODY.vz] as number);
      }
    };
    for (let k = 0; k < 600; k += 1) tick();
    const start = performance.now();
    for (let k = 0; k < 5400; k += 1) tick();
    expect((performance.now() - start) / 5400).toBeLessThanOrEqual(0.05);
  });
});
