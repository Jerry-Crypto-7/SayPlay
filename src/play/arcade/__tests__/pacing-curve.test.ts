import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { createCompileRng } from '@/play/compile/rng';
import { SUBSYSTEMS, createStreams, nextInt } from '@/sim/rng';

import { COUNTER, HEADER, bodyBase, BODY, stateSize, ROLE, FLAG } from '../contract';
import { PACING, TENSION_CURVE, intensityAt, progressOf, scheduleOf } from '../pieces/pacing';

/** Očekávaná intenzita počítaná v BigInt – nezávisle na tom, jak dělí `intensityAt`. */
function expected(progress: number): number {
  const points = TENSION_CURVE;
  let at = 0;
  while (at + 1 < points.length && (points[at + 1] as readonly [number, number])[0] <= progress) at += 1;
  const [x0, y0] = points[at] as readonly [number, number];
  const next = points[at + 1];
  if (next === undefined || next[0] === x0) return y0;
  const [x1, y1] = next;
  return y0 + Number((BigInt(y1 - y0) * BigInt(progress - x0)) / BigInt(x1 - x0));
}

const PERMILLE = Array.from({ length: 1001 }, (_, p) => p);

describe('tension curve', () => {
  it('is an exact integer table over every progress 0–1000', () => {
    for (const p of PERMILLE) expect(intensityAt(p, TENSION_CURVE)).toBe(expected(p));
    expect(intensityAt(0, TENSION_CURVE)).toBe(PACING.intensity.intro);
    expect(intensityAt(PACING.segments.buildUp, TENSION_CURVE)).toBe(PACING.intensity.peak);
    expect(intensityAt(PACING.segments.peak, TENSION_CURVE)).toBe(PACING.intensity.finale);
    expect(intensityAt(1000, TENSION_CURVE)).toBe(PACING.intensity.finale);
  });

  it('never falls from the intro to the finale', () => {
    for (const p of PERMILLE.slice(1)) expect(intensityAt(p, TENSION_CURVE)).toBeGreaterThanOrEqual(intensityAt(p - 1, TENSION_CURVE));
  });

  it('keeps the area under the curve within 95–105 % of today', () => {
    const area = PERMILLE.slice(0, 1000).reduce((sum, p) => sum + intensityAt(p, TENSION_CURVE), 0) / 1000;
    expect(area).toBeGreaterThanOrEqual(950);
    expect(area).toBeLessThanOrEqual(1050);
  });
});

describe('spawn schedule', () => {
  const thirdOf = (permille: number): number => (permille < 334 ? 0 : permille < 667 ? 1 : 2);

  it('spawns more in the last third than in the first for every budget from 3 up', () => {
    for (let seed = 1; seed <= 20; seed += 1) for (let budget = 3; budget <= 12; budget += 1) {
      const schedule = scheduleOf(createCompileRng(seed, 'pacing'), TENSION_CURVE, budget, 3);
      expect(schedule).toHaveLength(budget);
      const spawned = [0, 0, 0];
      for (const entry of schedule) spawned[thirdOf(entry.atPermille)] = (spawned[thirdOf(entry.atPermille)] as number) + entry.count;
      expect(spawned[2]).toBeGreaterThan(spawned[0] as number);
      for (const entry of schedule) {
        expect(entry.behaviour).toBeGreaterThanOrEqual(0);
        expect(entry.behaviour).toBeLessThan(3);
      }
      expect(schedule.map((entry) => entry.atPermille)).toEqual([...schedule.map((entry) => entry.atPermille)].sort((a, b) => a - b));
    }
  });

  it('gives the same schedule for the same seed', () => {
    for (let seed = 1; seed <= 20; seed += 1) {
      expect(scheduleOf(createCompileRng(seed, 'pacing'), TENSION_CURVE, 7, 2)).toEqual(scheduleOf(createCompileRng(seed, 'pacing'), TENSION_CURVE, 7, 2));
    }
  });
});

describe('progress toward the goal', () => {
  const state = (tick: number, z: number, counters: Partial<Record<keyof typeof COUNTER, number>> = {}): Int32Array => {
    const s = new Int32Array(stateSize(4));
    s[HEADER.tick] = tick;
    s[HEADER.bodyCount] = 4;
    s[bodyBase(0) + BODY.z] = z;
    for (const [name, value] of Object.entries(counters)) s[HEADER.counters + COUNTER[name as keyof typeof COUNTER]] = value;
    return s;
  };

  it('takes the larger of the goal share and the time share', () => {
    expect(progressOf(state(0, 50_000), { by: 'distance', need: 100_000, limit: 5400 })).toBe(500);
    expect(progressOf(state(4050, 0), { by: 'distance', need: 100_000, limit: 5400 })).toBe(750);
    expect(progressOf(state(60, 0, { items: 3 }), { by: 'items', need: 4, limit: 5400 })).toBe(750);
    expect(progressOf(state(60, 0, { score: 50 }), { by: 'score', need: 40, limit: 5400 })).toBe(1000);
    expect(progressOf(state(2700, 0), { by: 'time', need: 5400, limit: 5400 })).toBe(500);
  });

  it('counts fallen foes as the foes no longer alive', () => {
    const s = state(0, 0);
    for (const body of [1, 2, 3]) s[bodyBase(body) + BODY.role] = ROLE.enemy;
    s[bodyBase(1) + BODY.flags] = FLAG.alive;
    expect(progressOf(s, { by: 'fallen', need: 3, role: ROLE.enemy, limit: 5400 })).toBe(666);
  });
});

describe('rng streams', () => {
  it('adds pacing at the end, so the four old streams draw what they drew before', () => {
    // Za `pacing` přibyl jen stream fronty slučování (P54C T11); pacing zůstal pátý.
    expect(SUBSYSTEMS.slice(0, 5)).toEqual(['spawn', 'ai', 'effect', 'layout', 'pacing']);
    const rows: Record<string, number[][]> = {};
    for (const s of ['spawn', 'ai', 'effect', 'layout'] as const) rows[s] = Array.from({ length: 20 }, (_, i) => { const stream = createStreams(i + 1)[s]; return [0, 1, 2, 3].map(() => nextInt(stream, 0, 999_999)); });
    // Otisk prvních 4 hodnot semínek 1–20 změřený na `origin/main` 0714a352 před přidáním streamu.
    expect(createHash('sha256').update(JSON.stringify(rows)).digest('hex')).toBe('2be94f14d8a9983fe3e997c45f826cf7f56c9d4b3e38edf68fdf21aab886c638');
  });

  it('adds the merge queue stream after pacing, so pacing draws what it drew before (P54C T11)', () => {
    // Za `merge` přibyl už jen stream řetězu (P56C T5), takže `merge` zůstal šestý.
    expect(SUBSYSTEMS.indexOf('merge')).toBe(5);
    const rows = Array.from({ length: 20 }, (_, i) => { const stream = createStreams(i + 1).pacing; return [0, 1, 2, 3].map(() => nextInt(stream, 0, 999_999)); });
    // Otisk změřený na HEAD 6d5bfce9 před přidáním streamu `merge`.
    expect(createHash('sha256').update(JSON.stringify(rows)).digest('hex')).toBe('6a3094b06729daeb255c0e77151541ce2bd7b7079a73c646ffc9428a91e18666');
  });
});
