/**
 * Domy plošinovky ve městě (P46G doplněk 14. 10.). Na snímku by šly přehlédnout
 * tiché chyby: dům s okny jen na odvrácené straně, ulice s dírou nebo domy přes
 * sebe, jiné domy při každém načtení. Pinuje se: střechy domů jen v městských
 * sadách, okna na straně ke kameře, stejný vstup = stejná síť, ulice souvislá.
 */

import { describe, expect, it } from 'vitest';

import { LOOK_IDS, LOOKS } from '@/play/arcade/look';

import { buildBlocks, streetBlocks, urbanLook } from '../rig/terrain/city-blocks';

const HOUSE = { x0: -1.5, x1: 1.5, z0: 0, z1: 8, base: 0, top: 6 };

/** Trojúhelníky s normálou k −x, které jsou před fasádou (okna jsou předsazená). */
function windowsFacingCamera(positions: ArrayLike<number>): number {
  let count = 0;
  for (let o = 0; o < positions.length; o += 9) if ([0, 3, 6].every((k) => positions[o + k]! < HOUSE.x0 - 0.01)) count += 1;
  return count;
}

describe('city blocks', () => {
  it('turns slabs into rooftops only in city and factory', () => {
    expect(LOOK_IDS.filter((id) => urbanLook(LOOKS[id]))).toEqual(['city', 'factory']);
  });

  it('puts windows on the camera side and none on a side it was not asked for', () => {
    const toward = buildBlocks([HOUSE], 1, ['-x'], false).getAttribute('position').array;
    const away = buildBlocks([HOUSE], 1, ['+x'], false).getAttribute('position').array;
    // 8 m / 1,4 m = 5 os × 3 patra × 2 trojúhelníky.
    expect(windowsFacingCamera(toward)).toBe(30);
    expect(windowsFacingCamera(away)).toBe(0);
  });

  it('builds the same houses for the same level', () => {
    const a = buildBlocks([HOUSE], 7, ['-x', '-z', '+z'], true);
    const b = buildBlocks([HOUSE], 7, ['-x', '-z', '+z'], true);
    expect(Array.from(b.getAttribute('color').array)).toEqual(Array.from(a.getAttribute('color').array));
    expect(Array.from(b.getAttribute('position').array)).toEqual(Array.from(a.getAttribute('position').array));
  });

  it('lines the street without overlaps or gaps wider than an alley', () => {
    const street = streetBlocks({ from: -30, to: 200, x0: 18, base: 1, seed: 42 });
    expect(street[0]!.z0).toBe(-30);
    expect(street.at(-1)!.z1).toBeGreaterThanOrEqual(200);
    for (let i = 1; i < street.length; i += 1) {
      const gap = street[i]!.z0 - street[i - 1]!.z1;
      expect(gap).toBeGreaterThanOrEqual(0);
      expect(gap).toBeLessThanOrEqual(1.5);
    }
    for (const house of street) {
      expect(house.x0).toBeGreaterThanOrEqual(18);
      expect(house.top - house.base).toBeGreaterThanOrEqual(4);
    }
  });
});
