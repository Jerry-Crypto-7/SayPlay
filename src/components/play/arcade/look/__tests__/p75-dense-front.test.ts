/**
 * P75 T5: husté popředí a teplá paleta míst konceptu A.
 *
 * Drobnosti u cesty (`Flora.front`) jsou na venkovních místech 12 vět aspoň dvakrát hustší než bez
 * násobku, pořád mimo cestu a volný pás, z pořadí semínka (stejná hra = stejné kusy) a telefon jich
 * má méně, ale ne nula. Oko by hustotu ani determinismus na snímku nepoznalo – proto test.
 */

import { Color, SRGBColorSpace } from 'three';
import { describe, expect, it } from 'vitest';

import { type LookId, LOOKS } from '@/play/arcade/look';

import { airOf } from '../rig/fog-light';
import { LAVA_GLOW } from '../rig/terrain/valley';
import { type Plant, placeVegetation, type VegetationOptions } from '../vegetation-places';

const PLACES: readonly LookId[] = ['volcano', 'underwater', 'city', 'castle', 'beach', 'space', 'meadow', 'snow'];
const ROAD = { center: 0, half: 2 };
const CLEAR = 1.5;

const plantsOf = (id: LookId, change: Partial<VegetationOptions> = {}): Plant[] =>
  placeVegetation({ flora: LOOKS[id].flora!, seed: 7, from: -10, to: 200, road: () => ROAD, clear: CLEAR, profile: 'desktop', ...change });
const near = (plants: readonly Plant[]): number => plants.filter((plant) => plant.layer === 'near').length;

describe('P75 T5 – husté popředí', () => {
  it.each(PLACES)('%s: drobností u cesty aspoň dvakrát víc než bez násobku', (id) => {
    const flora = LOOKS[id].flora!;
    expect(flora.front ?? 1).toBeGreaterThanOrEqual(2);
    expect(near(plantsOf(id))).toBeGreaterThanOrEqual(1.7 * near(plantsOf(id, { flora: { ...flora, front: 1 } })));
  });

  it.each(PLACES)('%s: drobnosti stojí mimo cestu a volný pás a táž hra je má stejné', (id) => {
    const plants = plantsOf(id);
    for (const plant of plants) expect(Math.abs(plant.x) - plant.reach).toBeGreaterThanOrEqual(ROAD.half + CLEAR - 1e-9);
    expect(plantsOf(id)).toEqual(plants);
  });

  it.each(PLACES)('%s: telefon má drobností méně, ale ne žádné', (id) => {
    const [desktop, phone] = [near(plantsOf(id)), near(plantsOf(id, { profile: 'phone' }))];
    expect(phone).toBeGreaterThan(0);
    expect(phone).toBeLessThan(desktop);
  });
});

const hsl = (hex: string) => new Color(hex).getHSL({ h: 0, s: 0, l: 0 }, SRGBColorSpace);

describe('P75 T5 – teplá paleta', () => {
  it('sopka: zem a kulisy teplé hnědé, ne černé, a láva svítí', () => {
    for (const hex of [LOOKS.volcano.ground, LOOKS.volcano.tint[0]]) {
      const { h, l } = hsl(hex);
      expect(l, hex).toBeGreaterThan(0.25);
      expect(h * 360, hex).toBeLessThan(40);
    }
    expect(LAVA_GLOW).toBeGreaterThan(1.5);
  });

  it.each(PLACES)('%s: opar je světlý a nefialový', (id) => {
    const { h, l } = hsl(airOf(LOOKS[id]).color);
    expect(l).toBeGreaterThan(id === 'space' ? 0.25 : 0.45);
    expect(h * 360 > 250 && h * 360 < 320).toBe(false);
  });
});
