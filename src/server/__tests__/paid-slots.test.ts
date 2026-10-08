import { afterEach, describe, expect, it } from 'vitest';

import {
  DOOR_CEILING,
  MAX_CONCURRENT_GENERATIONS,
  acquireSlot,
  releaseSlot,
  resetConcurrency,
  slotsDetail,
  type PaidDoor,
} from '../paid-slots';

const DOORS = Object.keys(DOOR_CEILING) as PaidDoor[];

/** Vzít `n` slotů dveří a vrátit, kolikrát to prošlo. */
function take(door: PaidDoor, n: number): number {
  let got = 0;
  for (let i = 0; i < n; i += 1) if (acquireSlot(door)) got += 1;
  return got;
}

afterEach(() => resetConcurrency());

describe('paid slots (P44D T16)', () => {
  it('keeps the numbers the money decision names: 8 in flight, 3/2/2/2 per door', () => {
    expect(MAX_CONCURRENT_GENERATIONS).toBe(8);
    expect(DOOR_CEILING).toEqual({ world: 3, generate: 2, refine: 2, play: 2 });
  });

  it('invariant rezervy: the other doors together stay below the global ceiling', () => {
    for (const door of DOORS) {
      const others = DOORS.filter((d) => d !== door).reduce((sum, d) => sum + DOOR_CEILING[d], 0);
      expect(others, `others than ${door}`).toBeLessThan(MAX_CONCURRENT_GENERATIONS);
    }
  });

  it('stops each door at its own ceiling', () => {
    for (const door of DOORS) {
      expect(take(door, DOOR_CEILING[door] + 1), door).toBe(DOOR_CEILING[door]);
      resetConcurrency();
    }
  });

  it('lets an idle door in when every other door is full', () => {
    for (const door of DOORS) {
      for (const other of DOORS) if (other !== door) take(other, DOOR_CEILING[other]);
      expect(acquireSlot(door), door).toBe(true);
      resetConcurrency();
    }
  });

  it('refuses at the global ceiling before the door ceiling bites', () => {
    take('world', 3);
    take('generate', 2);
    take('refine', 2);
    expect(acquireSlot('play')).toBe(true);
    expect(slotsDetail('play')).toContain('3 world + 2 generate + 2 refine + 1 play of 8');
    expect(acquireSlot('play')).toBe(false);
  });

  it('gives a released slot back to the door and to the global count', () => {
    take('play', 2);
    expect(acquireSlot('play')).toBe(false);
    releaseSlot('play');
    expect(acquireSlot('play')).toBe(true);

    take('world', 3);
    take('generate', 2);
    take('refine', 1);
    expect(acquireSlot('refine')).toBe(false);
    releaseSlot('world');
    expect(acquireSlot('refine')).toBe(true);
  });

  it('refuses a door outside PaidDoor without poisoning the counters', () => {
    expect(acquireSlot('studio' as PaidDoor)).toBe(false);
    releaseSlot('studio' as PaidDoor);
    expect(take('play', 3)).toBe(2);
  });
});
