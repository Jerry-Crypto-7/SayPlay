/**
 * Profil kvality XR pro Quest 2 (P65 T6): frekvence, rozlišení relace z adresy, měřák panelu FPS a pravidla,
 * co VR nekreslí. Rozpočet žánrů hlídá měření (`evals/vr/__tests__/budget.test.ts`).
 */

import { describe, expect, it } from 'vitest';

import { XR_QUALITY, createFrameMeter, cutOf, framebufferScaleOf, nearestRate } from '../quality';

describe('nearestRate', () => {
  it('picks the supported rate closest to 72 Hz', () => {
    expect(nearestRate([60, 72, 80, 90, 120])).toBe(72);
    expect(nearestRate(new Float32Array([90, 120]))).toBe(90);
    expect(nearestRate([60, 80])).toBe(80);
  });

  it('leaves the session default without a list', () => {
    expect(nearestRate([])).toBe(false);
  });
});

describe('framebufferScaleOf', () => {
  it('uses the profile without vrscale', () => {
    expect(framebufferScaleOf('http://localhost:3165/play?vr=1&vrhud=1')).toBe(XR_QUALITY.scale);
  });

  it('takes vrscale for the headset check, clamped to 0.8–1', () => {
    expect(framebufferScaleOf('/play?vr=1&vrscale=0.8')).toBe(0.8);
    expect(framebufferScaleOf('/play?vrscale=0.9')).toBe(0.9);
    expect(framebufferScaleOf('/play?vrscale=0.5')).toBe(0.8);
    expect(framebufferScaleOf('/play?vrscale=2')).toBe(1);
  });

  it('ignores a vrscale that is not a number', () => {
    expect(framebufferScaleOf('/play?vrscale=')).toBe(XR_QUALITY.scale);
    expect(framebufferScaleOf('/play?vrscale=low')).toBe(XR_QUALITY.scale);
  });
});

describe('createFrameMeter', () => {
  const STEP = 1000 / 72;

  it('counts the frames of the last second, the longest gap and the median CPU time', () => {
    const meter = createFrameMeter();
    for (let frame = 0; frame < 200; frame += 1) meter.record(frame * STEP, frame % 2 === 0 ? 4 : 6);
    // Půl ms za posledním snímkem: hrana okna nepadne přesně na snímek.
    const reading = meter.read(199 * STEP + 0.5);
    expect(reading.fps).toBe(72);
    expect(reading.worstMs).toBeCloseTo(STEP, 6);
    expect(reading.cpuMs).toBe(6);
  });

  it('shows a dropped frame as the worst gap, measured from the frame before the window', () => {
    const meter = createFrameMeter();
    const starts = [0, 10, 20, 1015, 1025];
    for (const start of starts) meter.record(start, 3);
    const reading = meter.read(1025);
    // Okno (25, 1025]: snímky 1015 a 1025; mezera 20 → 1015 se počítá.
    expect(reading.fps).toBe(2);
    expect(reading.worstMs).toBe(995);
  });

  it('reads zeros when the session drew nothing for a second', () => {
    const meter = createFrameMeter();
    meter.record(0, 5);
    expect(meter.read(5000)).toEqual({ fps: 0, worstMs: 0, cpuMs: 0 });
    expect(createFrameMeter().read(0)).toEqual({ fps: 0, worstMs: 0, cpuMs: 0 });
  });
});

describe('cutOf', () => {
  const node = (name: string, userData: Record<string, unknown> = {}) => ({ name, userData });

  it('drops the vegetation everywhere in VR', () => {
    expect(cutOf(node('vegetation'))).toBe('vegetation');
  });

  it('drops the outline of foes but keeps the hero outline', () => {
    expect(cutOf(node('', { ink: 'foe' }))).toBe('ink');
    expect(cutOf(node('', { ink: 'hero' }))).toBeNull();
  });

  it('drops the arena ring: hidden by the cut planes on the desk, over the budget around the player (P67 T6)', () => {
    expect(cutOf(node('', { terrain: 'arena-ring' }))).toBe('ring');
  });

  it('keeps everything else', () => {
    expect(cutOf(node('', { terrain: 'arena' }))).toBeNull();
    expect(cutOf(node('backdrop'))).toBeNull();
    expect(cutOf(node('', { frame: 'hero' }))).toBeNull();
  });
});
