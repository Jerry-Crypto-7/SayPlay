import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_PLAY_DIRECTOR_SLOTS,
  DOOR_CEILING,
  MAX_CONCURRENT_GENERATIONS,
  MAX_PLAY_DIRECTOR_SLOTS,
  acquireSlot,
  playDirectorSlots,
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

/** Invariant rezervy nad libovolnými stropy dveří. */
function reserveHolds(ceilings: Readonly<Record<PaidDoor, number>>): boolean {
  return DOORS.every((door) => DOORS.filter((d) => d !== door).reduce((sum, d) => sum + ceilings[d], 0) < MAX_CONCURRENT_GENERATIONS);
}

describe('PLAY_DIRECTOR_SLOTS (P53 T1)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('defaults to 2 when the variable is missing or empty', () => {
    expect(DEFAULT_PLAY_DIRECTOR_SLOTS).toBe(2);
    expect(playDirectorSlots({})).toBe(2);
    expect(playDirectorSlots({ PLAY_DIRECTOR_SLOTS: '' })).toBe(2);
    expect(playDirectorSlots({ PLAY_DIRECTOR_SLOTS: '  ' })).toBe(2);
  });

  it('takes a whole number inside the allowed range', () => {
    expect(playDirectorSlots({ PLAY_DIRECTOR_SLOTS: '1' })).toBe(1);
    expect(playDirectorSlots({ PLAY_DIRECTOR_SLOTS: ` ${String(MAX_PLAY_DIRECTOR_SLOTS)} ` })).toBe(MAX_PLAY_DIRECTOR_SLOTS);
  });

  it.each(['0', '-1', String(MAX_PLAY_DIRECTOR_SLOTS + 1), String(MAX_CONCURRENT_GENERATIONS), '9'])('refuses %s as out of range, logs it and keeps 2', (raw) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(playDirectorSlots({ PLAY_DIRECTOR_SLOTS: raw })).toBe(2);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(`PLAY_DIRECTOR_SLOTS=${JSON.stringify(raw)} ignored`));
  });

  it.each(['two', '1x', '1.5', '1e0', '0x1', 'NaN'])('refuses the non-number %s, logs it and keeps 2', (raw) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(playDirectorSlots({ PLAY_DIRECTOR_SLOTS: raw })).toBe(2);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('ignored'));
  });

  it('keeps the reserve invariant for every allowed value, and the bound is the largest one that does', () => {
    for (let play = 1; play <= MAX_PLAY_DIRECTOR_SLOTS; play += 1) expect(reserveHolds({ ...DOOR_CEILING, play }), `play ${String(play)}`).toBe(true);
    expect(reserveHolds({ ...DOOR_CEILING, play: MAX_PLAY_DIRECTOR_SLOTS + 1 })).toBe(false);
  });

  it('sets the play door ceiling from the environment at startup', async () => {
    vi.stubEnv('PLAY_DIRECTOR_SLOTS', '1');
    vi.resetModules();
    const fresh = await import('../paid-slots');
    expect(fresh.DOOR_CEILING.play).toBe(1);
    expect(fresh.acquireSlot('play')).toBe(true);
    expect(fresh.acquireSlot('play')).toBe(false);
    fresh.resetConcurrency();
  });

  it('starts with 2 and a log line when the environment value is refused', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubEnv('PLAY_DIRECTOR_SLOTS', '8');
    vi.resetModules();
    const fresh = await import('../paid-slots');
    expect(fresh.DOOR_CEILING.play).toBe(2);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('PLAY_DIRECTOR_SLOTS="8" ignored'));
  });
});
