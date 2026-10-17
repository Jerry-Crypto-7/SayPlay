import { describe, expect, it } from 'vitest';

import { BODY, bodyBase } from '../../../contract';
import { instantiate, replay } from '../../../kernel';
import { ARCADE_LIBRARY } from '../../../library';
import { runBot } from '../../../verify';
import { type BehaviourSpace, stepBehaviours } from '../index';
import { HEALTH, behaviourHarness, healthAfter, refsOf, telegraphCheck } from './harness';

const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8];
const SPACES: readonly BehaviourSpace[] = ['plane', 'track'];

describe('flanker', () => {
  it.each(SPACES)('(a) the threat probe walks into it and gets hit – %s', (space) => {
    for (const seed of [1, 2]) {
      const { world, body } = behaviourHarness(space, 'flanker', seed);
      const probe = runBot(world, ARCADE_LIBRARY, { probeBody: body });
      expect(healthAfter(world, probe.inputs)).toBeLessThan(HEALTH);
    }
  });

  it.each(SPACES)('(b) the intermediate bot dodges it and wins at least 7 of 8 seeds, idle wins none – %s', (space) => {
    const outcomes = SEEDS.map((seed) => {
      const { world } = behaviourHarness(space, 'flanker', seed);
      return { bot: runBot(world, ARCADE_LIBRARY, { profile: 'intermediate' }).outcome, idle: replay(world, [], ARCADE_LIBRARY).outcome };
    });
    expect(outcomes.filter((run) => run.bot === 'won').length).toBeGreaterThanOrEqual(7);
    expect(outcomes.filter((run) => run.idle === 'won')).toEqual([]);
  });

  it('(d) the bot step steps out of the dash line in the plane', () => {
    // Bez kroku robota ho flanker v těchže 8 hrách trefí 5×.
    const hits = SEEDS.reduce((sum, seed) => {
      const { world } = behaviourHarness('plane', 'flanker', seed);
      return sum + telegraphCheck(world, runBot(world, ARCADE_LIBRARY, { profile: 'intermediate' }).inputs).hits;
    }, 0);
    expect(hits).toBeLessThanOrEqual(1);
  });

  it('(c) in the plane it heads beside the running player, not at him', () => {
    const { world, body } = behaviourHarness('plane', 'flanker', 1);
    const state = instantiate(world);
    const p = bodyBase(0);
    const f = bodyBase(body);
    state[p + BODY.x] = 0;
    state[p + BODY.z] = 0;
    state[p + BODY.vz] = 150;
    state[f + BODY.x] = 8000;
    state[f + BODY.z] = 0;
    stepBehaviours(state, 0, refsOf(world), 'plane', 1000);
    // Cíl je bod 3 m vedle předpovězené dráhy na straně flankera, (3000, 4500), rychlostí 110 – na hráče by jel po (−110, 0).
    expect([state[f + BODY.vx], state[f + BODY.vz]]).toEqual([-81, 73]);
  });
});
