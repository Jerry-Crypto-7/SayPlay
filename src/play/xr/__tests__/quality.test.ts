/**
 * Profil kvality XR pro Quest 2 (P65 T6): frekvence, rozlišení relace z adresy, měřák panelu FPS a pravidla,
 * co VR nekreslí. Rozpočet žánrů hlídá měření (`evals/vr/__tests__/budget.test.ts`). Profil Questu 3 (P67 T10)
 * je v `headset.ts`.
 */

import { describe, expect, it } from 'vitest';

import { QUEST3_QUALITY, profileFor } from '../headset';
import { XR_QUALITY, createFrameMeter, cutOf, framebufferScaleOf, nearestRate } from '../quality';

/** Prohlížeče Questu hlásí model v závorce UA (vzorky Quest 2 a 3 jsou z emulátoru IWER 2.6.0). */
const UA = {
  quest2:
    'Mozilla/5.0 (X11; Linux x86_64; Quest 2) AppleWebKit/537.36 (KHTML, like Gecko) OculusBrowser/33.0.0.x.x.x Chrome/126.0.6478.122 VR Safari/537.36',
  quest3:
    'Mozilla/5.0 (X11; Linux x86_64; Quest 3) AppleWebKit/537.36 (KHTML, like Gecko) OculusBrowser/33.0.0.x.x.x Chrome/126.0.6478.122 VR Safari/537.36',
  quest3s:
    'Mozilla/5.0 (X11; Linux x86_64; Quest 3S) AppleWebKit/537.36 (KHTML, like Gecko) OculusBrowser/37.0.0.x.x.x Chrome/130.0.6723.102 VR Safari/537.36',
  questPro:
    'Mozilla/5.0 (X11; Linux x86_64; Quest Pro) AppleWebKit/537.36 (KHTML, like Gecko) OculusBrowser/33.0.0.x.x.x Chrome/126.0.6478.122 VR Safari/537.36',
  desktop: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
} as const;

/** Frekvence relace Questu 2 i 3 (IWER `metaQuest2`, `metaQuest3`). */
const QUEST_RATES = new Float32Array([72, 80, 90, 120]);

describe('profileFor', () => {
  it('keeps Quest 2 and unknown headsets on the Quest 2 profile, bit for bit', () => {
    expect(XR_QUALITY).toStrictEqual({ hz: 72, foveation: 1, scale: 1, particles: 500 });
    for (const userAgent of [UA.quest2, UA.questPro, UA.desktop, '']) {
      for (const supportedFrameRates of [undefined, [], QUEST_RATES]) {
        expect(profileFor({ userAgent, supportedFrameRates })).toBe(XR_QUALITY);
      }
    }
  });

  it('gives Quest 3 and 3S 90 Hz and 1.2× resolution when the session offers 90 Hz', () => {
    expect(QUEST3_QUALITY).toStrictEqual({ hz: 90, foveation: 1, scale: 1.2, particles: 500 });
    for (const userAgent of [UA.quest3, UA.quest3s]) {
      expect(profileFor({ userAgent, supportedFrameRates: QUEST_RATES })).toBe(QUEST3_QUALITY);
      expect(profileFor({ userAgent, supportedFrameRates: [72, 90] })).toBe(QUEST3_QUALITY);
    }
  });

  it('keeps the Quest 2 rate on a Quest 3 without 90 Hz, but still the higher resolution', () => {
    for (const supportedFrameRates of [undefined, [], [72, 80, 120]]) {
      expect(profileFor({ userAgent: UA.quest3, supportedFrameRates })).toStrictEqual({ ...QUEST3_QUALITY, hz: XR_QUALITY.hz });
    }
  });
});

describe('nearestRate', () => {
  it('picks the supported rate closest to 72 Hz', () => {
    expect(nearestRate([60, 72, 80, 90, 120])).toBe(72);
    expect(nearestRate(new Float32Array([90, 120]))).toBe(90);
    expect(nearestRate([60, 80])).toBe(80);
  });

  it('picks the supported rate closest to the profile rate', () => {
    expect(nearestRate(QUEST_RATES, QUEST3_QUALITY.hz)).toBe(90);
    expect(nearestRate(QUEST_RATES, XR_QUALITY.hz)).toBe(72);
  });

  it('leaves the session default without a list', () => {
    expect(nearestRate([])).toBe(false);
  });
});

describe('framebufferScaleOf', () => {
  it('uses the profile without vrscale', () => {
    expect(framebufferScaleOf('http://localhost:3165/play?vr=1&vrhud=1')).toBe(XR_QUALITY.scale);
    expect(framebufferScaleOf('/play?vr=1', QUEST3_QUALITY.scale)).toBe(1.2);
    expect(framebufferScaleOf('/play?vrscale=low', QUEST3_QUALITY.scale)).toBe(1.2);
  });

  it('lets vrscale lower the Quest 3 resolution too, within the same 0.8–1 range', () => {
    expect(framebufferScaleOf('/play?vrscale=1', QUEST3_QUALITY.scale)).toBe(1);
    expect(framebufferScaleOf('/play?vrscale=0.8', QUEST3_QUALITY.scale)).toBe(0.8);
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
