/**
 * Klip průběhu (P45A T8): rozvrh snímků přes celý běh robota. Klip, který po
 * konci běhu fotí dál prázdnou scénu, vypadá jako dlouhá hra – rozvrh proto
 * končí stavem po konci. Klip soudce slovesa (`CLIP`, P43/P44E) se nemění.
 */

import { describe, expect, it } from 'vitest';

import { CLIP, PACE, paceTicks } from '../../../../scripts/play-fidelity.mjs';

describe('pacing clip schedule', () => {
  it('shoots after 90 ticks, then every 360 ticks, at most 8 frames', () => {
    expect(PACE).toEqual({ leadTicks: 90, gapTicks: 360, maxFrames: 8 });
    expect(paceTicks(null)).toEqual([90, 450, 810, 1170, 1530, 1890, 2250, 2610]);
  });

  it('caps a run that ends after the eighth frame at 8 frames', () => {
    expect(paceTicks(5400)).toEqual(paceTicks(null));
  });

  it('ends on the state after the end of a run that ends early', () => {
    expect(paceTicks(1000)).toEqual([90, 450, 810, 1000]);
    expect(paceTicks(810)).toEqual([90, 450, 810]);
    expect(paceTicks(40)).toEqual([40]);
  });

  it('leaves the verb clip unchanged', () => {
    expect(CLIP).toEqual({ frames: 3, gapTicks: 30, leadTicks: 90, hz: 60 });
  });
});
