import { describe, expect, it } from 'vitest';

import { replay } from '../../../kernel';
import { ARCADE_LIBRARY } from '../../../library';
import { runBot } from '../../../verify';
import type { BehaviourSpace } from '../index';
import { HEALTH, behaviourHarness, healthAfter, telegraphCheck } from './harness';

const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8];
const SPACES: readonly BehaviourSpace[] = ['plane', 'track'];

describe('ambusher', () => {
  it.each(SPACES)('(a) the threat probe walks into it and gets hit – %s', (space) => {
    for (const seed of [1, 2]) {
      const { world, body } = behaviourHarness(space, 'ambusher', seed);
      expect(healthAfter(world, runBot(world, ARCADE_LIBRARY, { probeBody: body }).inputs)).toBeLessThan(HEALTH);
    }
  });

  it.each(SPACES)('(b) the intermediate bot wins at least 7 of 8 seeds, idle wins none – %s', (space) => {
    const outcomes = SEEDS.map((seed) => {
      const { world } = behaviourHarness(space, 'ambusher', seed);
      return { bot: runBot(world, ARCADE_LIBRARY, { profile: 'intermediate' }).outcome, idle: replay(world, [], ARCADE_LIBRARY).outcome };
    });
    expect(outcomes.filter((run) => run.bot === 'won').length).toBeGreaterThanOrEqual(7);
    expect(outcomes.filter((run) => run.idle === 'won')).toEqual([]);
  });

  it.each(SPACES)('(c) the dash faster than the player never lands without a full shake first – %s', (space) => {
    let hits = 0;
    for (const seed of SEEDS) {
      const { world, body } = behaviourHarness(space, 'ambusher', seed);
      for (const inputs of [[], runBot(world, ARCADE_LIBRARY, { profile: 'intermediate' }).inputs, runBot(world, ARCADE_LIBRARY, { probeBody: body }).inputs]) {
        const check = telegraphCheck(world, inputs);
        expect(check.violations).toEqual([]);
        hits += check.hits;
      }
    }
    // Ne prázdně: sondu (a na trati i nečinného hráče) zasáhne.
    expect(hits).toBeGreaterThan(SEEDS.length);
  });

  it.each(SPACES)('(d) replays the bot record to the same hash – %s', (space) => {
    const { world } = behaviourHarness(space, 'ambusher', 3);
    const bot = runBot(world, ARCADE_LIBRARY, { profile: 'intermediate' });
    expect(replay(world, bot.inputs, ARCADE_LIBRARY).hash).toBe(bot.hash);
    expect(replay(world, bot.inputs, ARCADE_LIBRARY).hash).toBe(bot.hash);
  });
});
