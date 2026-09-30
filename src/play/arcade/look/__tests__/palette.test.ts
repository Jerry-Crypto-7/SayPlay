/**
 * Paleta rigu (P32A T1). Chybějící pole nebo fialová obloha nevypadá rozbitě,
 * jen „jinak“ – oko to nepozná, tenhle pin ano.
 */

import { describe, expect, it } from 'vitest';

import { LOOK_IDS, LOOKS } from '../index';

/** Odstín barvy `#rrggbb` v HSL (0–360°); šedá má 0. */
function hueOf(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16) / 255) as [number, number, number];
  const max = Math.max(r, g, b);
  const span = max - Math.min(r, g, b);
  if (span === 0) return 0;
  const hue = max === r ? ((g - b) / span) % 6 : max === g ? (b - r) / span + 2 : (r - g) / span + 4;
  return (hue * 60 + 360) % 360;
}

/** Každá barva sady, i ve vnořených polích (světlo, odstín rekvizit, hmota bloků). */
function colorsOf(value: unknown): string[] {
  if (typeof value === 'string') return /^#[0-9a-f]{6}$/i.test(value) ? [value] : [];
  if (Array.isArray(value)) return value.flatMap(colorsOf);
  if (typeof value === 'object' && value !== null) return Object.values(value).flatMap(colorsOf);
  return [];
}

describe('style rig palette', () => {
  it.each(LOOK_IDS)('%s carries every field the rig reads', (id) => {
    const look = LOOKS[id];
    for (const field of ['skyTop', 'horizon', 'sunColor'] as const) expect(look[field], field).toMatch(/^#[0-9a-f]{6}$/i);
    expect(look.sunDir).toHaveLength(3);
    // Slunce svítí shora: pod obzorem by stín padal vzhůru.
    expect(look.sunDir[1]).toBeGreaterThan(0);
    expect(look.exposure).toBeGreaterThan(0.5);
    expect(look.exposure).toBeLessThan(1.5);
    expect(look.glow).toBeGreaterThanOrEqual(0);
  });

  it.each(LOOK_IDS)('%s has no purple', (id) => {
    const purple = colorsOf(LOOKS[id]).filter((hex) => {
      const hue = hueOf(hex);
      return hue >= 250 && hue <= 320;
    });
    expect(purple).toEqual([]);
  });

  it('measures hue the way the rule means it', () => {
    expect(hueOf('#7c3aed')).toBeGreaterThanOrEqual(250);
    expect(hueOf('#7c3aed')).toBeLessThanOrEqual(320);
    expect(hueOf('#3d7bd9')).toBeLessThan(250);
    expect(hueOf('#fb7185')).toBeGreaterThan(320);
  });
});
