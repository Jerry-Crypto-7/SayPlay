/**
 * Zvuk her (P28C T2): který efekt pravidla zní jakou předvolbou, co je skok
 * a že předvolby ZzFX dají krátký, neprázdný a netřískající zvuk.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { type ArcadeEffect, BODY, BUTTON, HEADER, type InputEvent, bodyBase } from '@/play/arcade/contract';

import { HAPTICS, SFX_PRESETS, type SfxPreset, actionPresets, jumped, presetsFor, setMuted, vibrateFor } from '..';
import { ZZFX_RATE, zzfxSamples } from '../zzfx';

describe('event → sound preset', () => {
  it('a pickup, a hit, a win and a loss each have their own sound', () => {
    expect(presetsFor([{ kind: 'score', amount: 1 }, { kind: 'despawn', body: 3 }])).toEqual(['pickup']);
    expect(presetsFor([{ kind: 'damage', amount: 1 }, { kind: 'respawn' }])).toEqual(['hit']);
    expect(presetsFor([{ kind: 'win' }])).toEqual(['win']);
    expect(presetsFor([{ kind: 'lose' }])).toEqual(['lose']);
  });

  it('the end of the game drowns the rest of its tick; a loss beats a win', () => {
    expect(presetsFor([{ kind: 'score', amount: 1 }, { kind: 'win' }])).toEqual(['win']);
    expect(presetsFor([{ kind: 'damage', amount: 1 }, { kind: 'lose' }, { kind: 'win' }])).toEqual(['lose']);
  });

  it('two pickups in a tick are one sound; bookkeeping effects are silent', () => {
    expect(presetsFor([{ kind: 'score', amount: 1 }, { kind: 'score', amount: 1 }, { kind: 'damage', amount: 1 }])).toEqual(['pickup', 'hit']);
    expect(presetsFor([{ kind: 'count', counter: 'ammo', amount: -1 }, { kind: 'checkpoint', body: 2 }])).toEqual([]);
  });

  it('a combo (P36A event, not yet in the contract) gets its own sound next to the pickup', () => {
    const combo = { kind: 'combo', multiplier: 3 } as unknown as ArcadeEffect;
    expect(presetsFor([{ kind: 'score', amount: 1 }, combo])).toEqual(['pickup', 'combo']);
  });
});

describe('player actions → sound', () => {
  const at = (tick: number, buttons: number): InputEvent => ({ tick, buttons, axis: 0 });

  it('the runner clicks on a lane change and whooshes on a slide', () => {
    expect(actionPresets('runner', [at(4, BUTTON.LEFT)], 0)).toEqual(['lane']);
    expect(actionPresets('runner', [at(4, BUTTON.RIGHT), at(9, BUTTON.DOWN)], 0)).toEqual(['lane', 'slide']);
  });

  it('a held button sounds once on its press, not on every tick it is held', () => {
    const held = [at(10, BUTTON.FIRE), at(11, BUTTON.FIRE), at(12, BUTTON.FIRE)];
    expect(actionPresets('platform', held, 0)).toEqual(['shoot']);
    expect(actionPresets('platform', held, 1)).toEqual([]);
    // Mezera v záznamu = tlačítko bylo puštěné; nový stisk zní znovu.
    expect(actionPresets('platform', [...held, at(20, BUTTON.FIRE)], 3)).toEqual(['shoot']);
  });

  it('a tap shoots in the range and strikes in the duel; attack swings everywhere', () => {
    expect(actionPresets('shooter', [at(3, BUTTON.TAP)], 0)).toEqual(['shoot']);
    expect(actionPresets('duel', [at(3, BUTTON.TAP)], 0)).toEqual(['swing']);
    expect(actionPresets('fight', [at(3, BUTTON.ATTACK)], 0)).toEqual(['swing']);
  });

  it('the same buttons in other games are silent: the jump has its own sound and a brake is no slide', () => {
    expect(actionPresets('runner', [at(3, BUTTON.TAP)], 0)).toEqual([]);
    expect(actionPresets('steer', [at(3, BUTTON.DOWN), at(5, BUTTON.LEFT)], 0)).toEqual([]);
    expect(actionPresets('platform', [at(3, BUTTON.TAP)], 0)).toEqual([]);
  });
});

describe('haptics', () => {
  afterEach(() => setMuted(false));

  const phone = () => {
    const calls: (number | number[])[] = [];
    return { calls, vibrate: (pattern: number | number[]) => (calls.push(pattern), true) };
  };
  const length = (pattern: number | readonly number[]): number => (typeof pattern === 'number' ? pattern : pattern.reduce((sum, ms) => sum + ms, 0));

  it('a hit buzzes 30 ms, a pickup 10 ms, a win a pattern and a loss longer than a hit', () => {
    expect(HAPTICS.hit).toBe(30);
    expect(HAPTICS.pickup).toBe(10);
    expect(Array.isArray(HAPTICS.win)).toBe(true);
    expect(length(HAPTICS.lose)).toBeGreaterThan(length(HAPTICS.hit) * 3);
    const device = phone();
    expect(vibrateFor(['pickup', 'hit'], device)).toBe(true);
    // Jedno zavibrování za tik: zásah přebije sebrání (vibrate stejně ruší předchozí vzor).
    expect(device.calls).toEqual([30]);
  });

  it('sounds without a feel do not vibrate', () => {
    const device = phone();
    expect(vibrateFor(['lane', 'jump'], device)).toBe(false);
    expect(device.calls).toEqual([]);
  });

  it('muted, nothing vibrates', () => {
    setMuted(true);
    const device = phone();
    expect(vibrateFor(['lose'], device)).toBe(false);
    expect(device.calls).toEqual([]);
  });

  it('without the Vibration API (iOS Safari) nothing happens and nothing throws', () => {
    expect(vibrateFor(['hit'], {})).toBe(false);
    expect(vibrateFor(['hit'], undefined)).toBe(false);
  });
});

describe('jump', () => {
  const at = (vy: number): Int32Array => {
    const state = new Int32Array(bodyBase(1) + 20);
    state[HEADER.player] = 0;
    state[bodyBase(0) + BODY.vy] = vy;
    return state;
  };

  it('upward speed from rest or a fall is a jump; still rising or falling is not', () => {
    expect(jumped(at(0), at(40))).toBe(true);
    expect(jumped(at(-12), at(40))).toBe(true);
    expect(jumped(at(40), at(35))).toBe(false);
    expect(jumped(at(0), at(0))).toBe(false);
    expect(jumped(at(-5), at(-10))).toBe(false);
  });
});

describe('ZzFX presets', () => {
  it.each(Object.keys(SFX_PRESETS) as SfxPreset[])('%s is audible, under a second and never clips', (preset) => {
    const samples = zzfxSamples(SFX_PRESETS[preset]);
    expect(samples.length).toBeGreaterThan(ZZFX_RATE * 0.05);
    expect(samples.length).toBeLessThan(ZZFX_RATE);
    const peak = Math.max(...samples.map(Math.abs));
    expect(peak).toBeGreaterThan(0.05);
    expect(peak).toBeLessThanOrEqual(1);
  });
});
