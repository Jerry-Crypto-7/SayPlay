import { describe, expect, it } from 'vitest';

import type { ArcadeParts } from '../../../addons';
import type { BodyInit } from '../../../contract';
import { replay } from '../../../kernel';
import { ARCADE_LIBRARY } from '../../../library';
import { runBot } from '../../../verify';
import { withPacing } from '../../pacing';
import { BEHAVIOURS, BEHAVIOUR_SPACE, TELEGRAPH_MIN, type BehaviourSpace, behaviourPhaseOf, telegraphOf } from '../index';
import { behaviourHarness, play, telegraphCheck } from './harness';

const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8];
const SPACES: readonly BehaviourSpace[] = ['plane', 'track'];

describe('behaviour framework', () => {
  it.each(SPACES)('(a) never lets a behaviour body strike without a full telegraph in the last 3 s – %s', (space) => {
    let hits = 0;
    for (const seed of SEEDS) {
      const { world } = behaviourHarness(space, 'flanker', seed);
      const bot = runBot(world, ARCADE_LIBRARY, { profile: 'intermediate' });
      for (const inputs of [[], bot.inputs]) {
        const check = telegraphCheck(world, inputs);
        expect(check.violations).toEqual([]);
        hits += check.hits;
      }
    }
    // Ne prázdně: nečinného hráče flanker zasáhne.
    expect(hits).toBeGreaterThan(SEEDS.length);
  });

  it('(b) shows the telegraph to the scene only while it runs, with the locked aim', () => {
    const { world, body } = behaviourHarness('track', 'flanker', 2);
    const seen: { phase: string; telegraph: ReturnType<typeof telegraphOf> }[] = [];
    play(world, [], (state) => seen.push({ phase: behaviourPhaseOf(state, body), telegraph: telegraphOf(state, body) }));
    const first = seen.findIndex((tick) => tick.phase === 'telegraph');
    expect(first).toBeGreaterThan(0);
    const run = seen.slice(first, first + TELEGRAPH_MIN);
    expect(run.map((tick) => tick.telegraph?.ticksLeft)).toEqual(Array.from({ length: TELEGRAPH_MIN }, (_, k) => TELEGRAPH_MIN - k));
    expect(new Set(run.map((tick) => `${tick.telegraph?.kind}:${tick.telegraph?.aim.x}`))).toEqual(new Set(['lane:0']));
    expect(seen[first + TELEGRAPH_MIN]?.phase).toBe('act');
    expect(seen.filter((tick) => tick.phase !== 'telegraph').every((tick) => tick.telegraph === null)).toBe(true);
  });

  it('(c) rejects two behaviours with the same signature and accepts a different model', () => {
    const base: ArcadeParts = { control: { id: 'runner', params: {} }, bot: { id: 'runner_bot', params: {} }, level: { bodies: [{ role: 'player', kind: 'player', x: 0, y: 0, z: 0, w: 600, h: 1600, d: 500, solid: false }], length: 0 }, rules: [] };
    const flanker = BEHAVIOURS.flanker.body;
    const again = (body: BodyInit) => withPacing(base, { seed: 1, goal: { by: 'time', need: 600, limit: 600 }, space: 'track', spots: [0, 0], behaviours: [{ body: flanker, behaviour: 'flanker' }, { body }], budget: 0 }).issues ?? [];
    expect(again(flanker)).toEqual([expect.stringContaining('share the signature')]);
    expect(again({ ...flanker, kind: 'other' })).toEqual([]);
  });

  it.each(SPACES)('(d) replays the bot record to the same hash – %s', (space) => {
    const { world } = behaviourHarness(space, 'flanker', 3);
    const bot = runBot(world, ARCADE_LIBRARY, { profile: 'intermediate' });
    expect(replay(world, bot.inputs, ARCADE_LIBRARY).hash).toBe(bot.hash);
    expect(replay(world, bot.inputs, ARCADE_LIBRARY).hash).toBe(bot.hash);
  });

  it('(e) picks the space from the base control table', () => {
    expect([BEHAVIOUR_SPACE.move_free, BEHAVIOUR_SPACE.walker, BEHAVIOUR_SPACE.fight, BEHAVIOUR_SPACE.runner, BEHAVIOUR_SPACE.glide]).toEqual(['plane', 'plane', 'plane', 'track', 'track']);
  });
});
