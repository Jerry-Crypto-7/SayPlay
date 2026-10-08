import { describe, expect, it } from 'vitest';

import { type ArcadeWorld, type BodyInit, FLAG, type InputEvent, UNIT } from '../../../contract';
import { replay } from '../../../kernel';
import { ARCADE_LIBRARY } from '../../../library';
import { runBot } from '../../../verify';
import { ARENA } from '../../arena';
import { GUARDIAN } from '../guardian';
import { behaviourMemoOf } from '../index';
import { HEALTH, behaviourHarness, healthAfter, play, read, telegraphCheck } from './harness';

const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8];

/** Strážce na kruhu za věcí nejbližší startu hráče, z jeho pohledu za ní. */
function behindNearest(bodies: readonly BodyInit[]): { x: number; z: number } {
  const player = bodies[0] as BodyInit;
  const gap = (body: BodyInit): number => Math.hypot(body.x - player.x, body.z - player.z);
  const item = bodies.filter((body) => body.role === 'collectible').sort((a, b) => gap(a) - gap(b))[0] as BodyInit;
  const limit = ARENA.half - UNIT;
  const clamp = (value: number): number => Math.max(-limit, Math.min(limit, value));
  return { x: clamp(item.x + Math.trunc(((item.x - player.x) * GUARDIAN.radius) / gap(item))), z: clamp(item.z + Math.trunc(((item.z - player.z) * GUARDIAN.radius) / gap(item))) };
}

const guard = (seed: number): { world: ArcadeWorld; body: number } => behaviourHarness('plane', 'guardian', seed, behindNearest);

/** Hlídaná věc po prvním tiku a jestli žije na konci záznamu; největší odstup strážce od ní, dokud žije. */
function watch(world: ArcadeWorld, body: number, inputs: readonly InputEvent[]): { item: number; taken: boolean; farthest: number } {
  let item = -1;
  let farthest = 0;
  const end = play(world, inputs, (state, tick) => {
    if (tick === 0) item = behaviourMemoOf(state, body) - 1;
    if (item < 0 || (read(state, item, 'flags') & FLAG.alive) === 0) return;
    farthest = Math.max(farthest, Math.hypot(read(state, body, 'x') - read(state, item, 'x'), read(state, body, 'z') - read(state, item, 'z')));
  });
  return { item, taken: item >= 0 && (read(end, item, 'flags') & FLAG.alive) === 0, farthest };
}

describe('guardian', () => {
  it('(a) the threat probe walks into it and gets hit', () => {
    for (const seed of [1, 2]) {
      const { world, body } = guard(seed);
      expect(healthAfter(world, runBot(world, ARCADE_LIBRARY, { probeBody: body }).inputs)).toBeLessThan(HEALTH);
    }
  });

  it('(b) the intermediate bot takes the guarded item and wins at least 7 of 8 seeds, idle wins none', () => {
    const outcomes = SEEDS.map((seed) => {
      const { world, body } = guard(seed);
      const bot = runBot(world, ARCADE_LIBRARY, { profile: 'intermediate' });
      return { won: bot.outcome === 'won', taken: watch(world, body, bot.inputs).taken, idle: replay(world, [], ARCADE_LIBRARY).outcome };
    });
    expect(outcomes.filter((run) => run.won && run.taken).length).toBeGreaterThanOrEqual(7);
    expect(outcomes.filter((run) => run.idle === 'won')).toEqual([]);
  });

  it('(c) the lunge never lands without a full warning first', () => {
    let hits = 0;
    for (const seed of SEEDS) {
      const { world, body } = guard(seed);
      for (const inputs of [[], runBot(world, ARCADE_LIBRARY, { profile: 'intermediate' }).inputs, runBot(world, ARCADE_LIBRARY, { probeBody: body }).inputs]) {
        const check = telegraphCheck(world, inputs);
        expect(check.violations).toEqual([]);
        hits += check.hits;
      }
    }
    // Ne prázdně: sondu zasáhne v každém semínku.
    expect(hits).toBeGreaterThanOrEqual(SEEDS.length);
  });

  it('(d) never strays more than 6 m from the item it guards', () => {
    for (const seed of SEEDS) {
      const { world, body } = guard(seed);
      for (const inputs of [[], runBot(world, ARCADE_LIBRARY, { profile: 'intermediate' }).inputs, runBot(world, ARCADE_LIBRARY, { probeBody: body }).inputs]) {
        const seen = watch(world, body, inputs);
        expect(seen.item).toBeGreaterThan(0);
        expect(seen.farthest).toBeLessThanOrEqual(6 * UNIT);
      }
    }
  });

  it('(e) replays the bot record to the same hash', () => {
    const { world } = guard(3);
    const bot = runBot(world, ARCADE_LIBRARY, { profile: 'intermediate' });
    expect(replay(world, bot.inputs, ARCADE_LIBRARY).hash).toBe(bot.hash);
    expect(replay(world, bot.inputs, ARCADE_LIBRARY).hash).toBe(bot.hash);
  });
});
