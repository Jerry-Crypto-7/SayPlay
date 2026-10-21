/**
 * Vrstva událostí pruhových žánrů (P55 T5): plán je čistá funkce semínka z vlastního streamu, první událost
 * přijde do 10 s, spěch je jen jeden a v poslední třetině. Tahle čísla hra „vypadá“ i rozbitá – replay ne.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { START_LIVES } from '../contract';
import { catchDrops, catchParams } from '../pieces/catch-fall';
import { EVENT_MARK, LANE_EVENTS, eventOfMark, laneEventCursor, planLaneEvents, stepLane } from '../pieces/lane-events';

const LENGTH = 2400;

describe('lane events plan', () => {
  afterEach(() => vi.restoreAllMocks());

  it('is a pure function of the seed: same seed, same plan; another seed, another plan', () => {
    expect(planLaneEvents(1, LENGTH)).toEqual(planLaneEvents(1, LENGTH));
    expect(planLaneEvents(1, LENGTH)).not.toEqual(planLaneEvents(2, LENGTH));
  });

  it('never reads the clock or Math.random, for the plan or for the catch level built on it', () => {
    const random = vi.spyOn(Math, 'random');
    const now = vi.spyOn(Date, 'now');
    const perf = vi.spyOn(performance, 'now');
    planLaneEvents(7, LENGTH);
    catchDrops(7, catchParams.parse({}), START_LIVES);
    expect(random).not.toHaveBeenCalled();
    expect(now).not.toHaveBeenCalled();
    expect(perf).not.toHaveBeenCalled();
  });

  it('starts the first event within 10 s and runs exactly one rush, in the last third', () => {
    for (let seed = 1; seed <= 20; seed += 1) {
      const plan = planLaneEvents(seed, LENGTH);
      expect((plan[0]?.at ?? Infinity) <= 600, `seed ${seed}`).toBe(true);
      const rushes = plan.filter((event) => event.kind === 'rush');
      expect(rushes, `seed ${seed}`).toHaveLength(1);
      expect(rushes[0]!.at).toBeGreaterThanOrEqual(Math.round((2 * LENGTH) / 3));
      expect(rushes[0]!.until - rushes[0]!.at).toBe(LANE_EVENTS.rushTicks);
      plan.slice(1).forEach((event, index) => expect(event.at).toBeGreaterThan(plan[index]!.at));
    }
  });

  it('hands each series or golden event out once and knows when a tick is in the rush', () => {
    const plan = planLaneEvents(3, LENGTH);
    const cursor = laneEventCursor(plan);
    const taken = [];
    for (let tick = 0; tick < LENGTH; tick += 10) {
      const event = cursor.take(tick);
      if (event !== null) taken.push(event);
    }
    expect(taken).toEqual(plan.filter((event) => event.kind !== 'rush'));
    const rush = plan.find((event) => event.kind === 'rush')!;
    expect(cursor.inRush(rush.at)).toBe(true);
    expect(cursor.inRush(rush.until)).toBe(false);
  });

  it('marks round-trip and series steps stay in the five lanes, always moving', () => {
    for (const kind of ['series', 'golden', 'rush'] as const) expect(eventOfMark(EVENT_MARK[kind])).toBe(kind);
    expect(eventOfMark(0)).toBeNull();
    const rng = { int: (from: number) => from };
    for (let lane = 0; lane < 5; lane += 1) {
      for (const toward of [0, 4]) {
        const next = stepLane(lane, toward, 5, rng);
        expect(next).not.toBe(lane);
        expect(next >= 0 && next < 5).toBe(true);
      }
    }
  });
});
