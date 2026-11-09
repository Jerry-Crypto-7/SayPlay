/**
 * P70D T2: mlha jen na dálku. Audit 4. 11. viděl šedou mlhu přes les i pláž – začínala ve třetině dohledu.
 * Pin: na každém místě, v každé náladě a denní době začíná mlha, kterou rig kreslí, nejdřív v 60 % dohledu,
 * dohled (konec mlhy = vzdálená rovina kamery) zůstává, a barva mlhy je obzor místa sytější, se stejným odstínem.
 */

import { Color, SRGBColorSpace } from 'three';
import { describe, expect, it } from 'vitest';

import { LOOK_IDS, LOOKS, type Look, sceneLook } from '@/play/arcade/look';

import { airOf, FOG_START } from '../rig/fog-light';

/** Místo z věty v náladě a denní době: mlha, bouřka, strašidelno, šero, sníh, jasno, soumrak, noc. */
const VARIANTS = ['', 'foggy', 'stormy', 'spooky', 'gloomy', 'snowy', 'bright sunny', 'at dusk', 'at night'] as const;
const SETTING: Readonly<Record<(typeof LOOK_IDS)[number], string>> = {
  meadow: 'a meadow', city: 'a city', mall: 'a mall', supermarket: 'a supermarket', living_room: 'a living room', factory: 'a factory',
  forest: 'a forest', jungle: 'a jungle', desert: 'a desert', beach: 'a beach', ocean: 'the ocean', underwater: 'a coral reef',
  snow: 'a snowy slope', cave: 'a cave', volcano: 'a volcano', space: 'space', castle: 'a castle', graveyard: 'a graveyard',
};

const scenes: { readonly name: string; readonly look: Look }[] = LOOK_IDS.flatMap((id) => [
  { name: `${id} (paleta)`, look: LOOKS[id] },
  ...VARIANTS.map((variant) => {
    const setting = `${SETTING[id]}${variant.startsWith('at ') ? ` ${variant}` : ''}`;
    return { name: `${id} ${variant}`.trim(), look: sceneLook({ setting, mood: variant.startsWith('at ') ? '' : variant }) };
  }),
]);

const hslOf = (hex: string) => new Color(hex).getHSL({ h: 0, s: 0, l: 0 }, SRGBColorSpace);

describe('mlha jen na dálku (P70D T2)', () => {
  it.each(scenes)('$name: mlha začíná nejdřív v 60 % dohledu a dohled se nemění', ({ look }) => {
    const air = airOf(look);
    expect(air.near).toBeGreaterThanOrEqual(FOG_START * air.far);
    expect(air.far).toBe(look.fog[1]);
    expect(air.near).toBeLessThan(air.far);
  });

  it.each(scenes)('$name: barva mlhy je obzor místa, sytější a se stejným odstínem', ({ look }) => {
    const [from, to] = [hslOf(look.horizon), hslOf(airOf(look).color)];
    expect(to.l).toBeCloseTo(from.l, 2);
    expect(to.s).toBeGreaterThan(Math.min(from.s, 0.99));
    expect(Math.abs(to.h - from.h)).toBeLessThan(0.01);
  });

  // P81 (směr mix): lehký opar od čtvrtiny dohledu – P70D posunul les na 42 m, P81 ho vrací na 20 m sady.
  it('les z auditu: P70D mlha od 42 m z 70 m, P81 opar od čtvrtiny dohledu (20 m sady)', () => {
    expect(LOOKS.forest.fog).toEqual([20, 70]);
    expect(FOG_START).toBe(0.25);
    expect(airOf(LOOKS.forest)).toMatchObject({ near: 20, far: 70 });
  });
});
