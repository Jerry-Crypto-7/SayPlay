/**
 * Zvuk her (P28C T2): který efekt pravidla zní jakou předvolbou, co je skok
 * a že předvolby ZzFX dají krátký, neprázdný a netřískající zvuk.
 */

import { describe, expect, it } from 'vitest';

import { BODY, HEADER, bodyBase } from '@/play/arcade/contract';

import { SFX_PRESETS, type SfxPreset, jumped, presetsFor } from '..';
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
