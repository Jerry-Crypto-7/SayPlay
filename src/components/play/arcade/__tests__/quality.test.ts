/**
 * Úrovně kvality rigu (P32A T2): pomalá hra sestoupí a po zotavení se vrátí,
 * ale nekmitá – úroveň, která po návratu znovu nestačí, se už nezkouší.
 * Kmitání i trvalé „low“ by na obrazovce vypadaly jen jako horší obraz.
 */

import { describe, expect, it } from 'vitest';

import { LOOKS } from '@/play/arcade/look';

import { DOWN_MS, type QualityState, type QualityTier, UP_MS, bloomThreshold, sampleQuality, startQuality } from '../look/rig/quality';

const STEP_MS = 500;

/** Desktop, který už v čase 0 měří (první vzorek po startu jen začne měřit). */
const measuring = (): QualityState => sampleQuality(startQuality(1), 50, 0);

it('starts touch devices cheaply even when their pixel ratio is below two', () => {
  expect(startQuality(1.75, true).tier).toBe('low');
  expect(startQuality(3, true).ceiling).toBe('high');
  expect(startQuality(1.75, false).tier).toBe('high');
});

/** Vzorky po půl sekundě s daným FPS po dobu `ms`; vrací stav a úroveň po každém vzorku. */
function run(state: QualityState, fps: number, ms: number, from: number): { readonly state: QualityState; readonly tiers: readonly QualityTier[]; readonly at: number } {
  const tiers: QualityTier[] = [];
  let now = from;
  let current = state;
  for (let t = 0; t < ms; t += STEP_MS) {
    now += STEP_MS;
    current = sampleQuality(current, fps, now);
    tiers.push(current.tier);
  }
  return { state: current, tiers, at: now };
}

describe('quality tiers', () => {
  it('starts a dense phone display one tier lower than a desktop', () => {
    expect(startQuality(1).tier).toBe('high');
    expect(startQuality(2).tier).toBe('high');
    expect(startQuality(2.625).tier).toBe('medium');
  });

  it('steps down only after 3 s under 45 FPS, one tier at a time', () => {
    const almost = run(measuring(), 30, DOWN_MS - STEP_MS, 0);
    expect(almost.state.tier).toBe('high');
    const down = run(almost.state, 30, STEP_MS, almost.at);
    expect(down.state.tier).toBe('medium');
    const lower = run(down.state, 30, DOWN_MS, down.at);
    expect(lower.state.tier).toBe('low');
    expect(run(lower.state, 5, 10_000, lower.at).state.tier).toBe('low');
  });

  // P37B T7: telefon na `medium` se držel 40–45 FPS a cíl 40 míjel o šum.
  it('a phone holding just above the 40 FPS goal steps down for headroom', () => {
    const phone = sampleQuality(startQuality(2.625), 42, 0);
    expect(run(phone, 42, DOWN_MS, 0).state.tier).toBe('low');
  });

  it('a short dip or FPS inside the band changes nothing', () => {
    let state = measuring();
    let at = 0;
    for (let i = 0; i < 20; i += 1) {
      ({ state, at } = run(state, 30, DOWN_MS - STEP_MS, at));
      ({ state, at } = run(state, 50, STEP_MS, at));
    }
    expect(state.tier).toBe('high');
    expect(run(state, 45, 60_000, at).tiers.every((tier) => tier === 'high')).toBe(true);
  });

  it('returns after a sustained recovery', () => {
    const down = run(measuring(), 30, DOWN_MS, 0);
    expect(down.state.tier).toBe('medium');
    const almost = run(down.state, 60, UP_MS - STEP_MS, down.at);
    expect(almost.state.tier).toBe('medium');
    expect(run(almost.state, 60, STEP_MS, almost.at).state.tier).toBe('high');
  });

  it('does not oscillate when the higher tier keeps failing', () => {
    // Na high 30 FPS, na medium 60: bez stropu by se střídaly donekonečna.
    let state = measuring();
    let at = 0;
    const tiers: QualityTier[] = [];
    for (let i = 0; i < 240; i += 1) {
      at += STEP_MS;
      state = sampleQuality(state, state.tier === 'high' ? 30 : 60, at);
      tiers.push(state.tier);
    }
    const changes = tiers.filter((tier, i) => i > 0 && tier !== tiers[i - 1]).length;
    // Sestup, jeden pokus o návrat, druhý sestup – a dál už medium.
    expect(changes).toBe(3);
    expect(tiers.slice(-60).every((tier) => tier === 'medium')).toBe(true);
  });

  it('a pause does not count as slow frames', () => {
    const slow = run(measuring(), 30, DOWN_MS - STEP_MS, 0);
    // Skrytá záložka: 10 s bez vzorku, pak jeden pomalý snímek po návratu.
    expect(sampleQuality(slow.state, 30, slow.at + 10_000).tier).toBe('high');
  });

  it('blooms only above the brightest sunlit matte white of every set', () => {
    for (const [id, look] of Object.entries(LOOKS)) {
      const sunlitWhite = (look.sun + look.light[2]) / Math.PI;
      expect(bloomThreshold(look), id).toBeGreaterThan(Math.max(1, sunlitWhite));
    }
  });
});
