/**
 * P83C T7: tvar věci podle druhu (budova kvádr se střechou i přes model knihovny) a jmenovky od startu bez překryvu –
 * hladové rozmístění musí u osmi věcí najít volné místo a místo z minulého snímku držet, dokud je volné.
 */
import { describe, expect, it } from 'vitest';

import { type TagRect, placeTags, shapeOf } from '../orrery-look';

/** Překryv o víc než 1 px (dotek rohu čtverce kolem kulaté věci překryvem není). */
const overlapping = (a: TagRect, b: TagRect): boolean => Math.abs(a.x - b.x) < (a.w + b.w) / 2 - 1 && Math.abs(a.y - b.y) < (a.h + b.h) / 2 - 1;

describe('orrery look', () => {
  it('a building gets the house shape even with a library model, green only without one, the rest a ball', () => {
    expect(shapeOf('Hospital', true)).toBe('building');
    expect(shapeOf('fire station', false)).toBe('building');
    expect(shapeOf('Park', false)).toBe('tree');
    expect(shapeOf('Palm tree', true)).toBe('model');
    expect(shapeOf('Left atrium', false)).toBe('ball');
    expect(shapeOf(undefined, false)).toBe('ball');
  });

  it('eight tags in a tight ring on a phone never overlap each other or another thing', () => {
    const band = { width: 390, top: 80, bottom: 700 };
    const things = Array.from({ length: 8 }, (_, i) => ({ x: 195 + 110 * Math.cos((i * Math.PI) / 4), y: 390 + 110 * Math.sin((i * Math.PI) / 4), r: 22 }));
    const sizes = things.map((_, i) => ({ w: 70 + 6 * i, h: 28 }));
    const { rects } = placeTags(things, sizes, band);
    rects.forEach((a, i) => {
      rects.slice(i + 1).forEach((b, k) => expect(overlapping(a, b), `tags ${i} and ${i + 1 + k}`).toBe(false));
      things.forEach((thing, j) => {
        if (j !== i) expect(overlapping(a, { x: thing.x, y: thing.y, w: 2 * thing.r, h: 2 * thing.r }), `tag ${i} on thing ${j}`).toBe(false);
      });
      expect(a.y - a.h / 2 >= band.top && a.y + a.h / 2 <= band.bottom && a.x - a.w / 2 >= 0 && a.x + a.w / 2 <= band.width, `tag ${i} inside the band`).toBe(true);
    });
  });

  it('a free spot above counts as free although the band edge leaves a float remainder', () => {
    // Živá data srdce (1280 × 720, pás 78–556): plocha mimo pás vyšla −1e-12 místo nuly a jmenovky utekly šikmo a pod věci.
    const things = '0.4287,0.3778,36.1;0.4245,0.6963,45.5;0.5622,0.3610,35.6;0.5692,0.6719,44.8'.split(';').map((spot) => {
      const [x, y, r] = spot.split(',').map(Number) as [number, number, number];
      return { x: x * 1280, y: y * 720, r };
    });
    const sizes = [97.4, 107.0, 113.2, 122.8].map((w) => ({ w, h: 28 }));
    expect(placeTags(things, sizes, { width: 1280, top: 78, bottom: 556 }).choice).toEqual([0, 0, 0, 0]);
  });

  it('a tag keeps last frame’s spot while it is free and moves below a thing at the top edge', () => {
    const band = { width: 400, top: 100, bottom: 700 };
    const top = { x: 200, y: 120, r: 20 };
    expect(placeTags([top], [{ w: 80, h: 28 }], band).choice).toEqual([1]);
    const middle = { x: 200, y: 400, r: 20 };
    expect(placeTags([middle], [{ w: 80, h: 28 }], band).choice).toEqual([0]);
    // Nad věcí volno → zpátky nad ni; jinak minulé místo, dokud je volné.
    expect(placeTags([middle], [{ w: 80, h: 28 }], band, [1]).choice).toEqual([0]);
    const blocker = { x: 200, y: 340, r: 20 };
    expect(placeTags([middle, blocker], [{ w: 80, h: 28 }, { w: 10, h: 10 }], band, [3]).choice[0]).toBe(3);
    expect(placeTags([middle, blocker], [{ w: 80, h: 28 }, { w: 10, h: 10 }], band).choice[0]).toBe(1);
  });
});
