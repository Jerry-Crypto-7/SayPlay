/**
 * Dojezd kamery za necelý tik.
 *
 * Tohle je ta část, kterou oko neuhlídá. Kamera, která se hýbe jen na tikových
 * snímcích, vypadá na statickém snímku úplně stejně jako kamera, která se hýbe
 * na každém — pozná se to až za pohybu, a i tam se to snadno přičte pomalému
 * stroji. Zároveň je to změna, která umí nepozorovaně posunout ustálené
 * zpoždění za postavou, na kterém stojí meze v `e2e/camera.spec.ts`.
 *
 * Pojmenovaná vlastnost: **rozdělení tiku na kousky nesmí změnit, kam kamera
 * dojede.** Bez ní by rychlejší stroj dojížděl jinak než pomalý a odstup kamery
 * by se stal vlastností hardwaru.
 */

import { describe, expect, it } from 'vitest';

import { FOLLOW_ALPHA, easeOver, easeToward } from '../FollowCamera';
import type { Vec3 } from '../projection';

const FROM: Vec3 = { x: 0, y: 6, z: 7.5 };
const TO: Vec3 = { x: 12, y: 6.45, z: -3.25 };

function repeat(from: Vec3, to: Vec3, times: number): Vec3 {
  let at = from;
  for (let i = 0; i < times; i += 1) at = easeToward(at, to);
  return at;
}

function expectSame(actual: Vec3, expected: Vec3, digits = 10): void {
  expect(actual.x).toBeCloseTo(expected.x, digits);
  expect(actual.y).toBeCloseTo(expected.y, digits);
  expect(actual.z).toBeCloseTo(expected.z, digits);
}

describe('spojitý dojezd se shoduje s dojezdem po celých tikách', () => {
  it('jeden tik ujede totéž co jedno zavolání po tikách', () => {
    expectSame(easeOver(FROM, TO, 1), easeToward(FROM, TO));
  });

  it.each([2, 7, 25])('%i tiků ujede totéž co tolikrát opakovaný dojezd', (ticks) => {
    expectSame(easeOver(FROM, TO, ticks), repeat(FROM, TO, ticks));
  });
});

describe('rozdělení tiku na snímky nemění, kam kamera dojede', () => {
  it('tři třetiny tiku ujedou tolik co jeden celý', () => {
    let at = FROM;
    for (let i = 0; i < 3; i += 1) at = easeOver(at, TO, 1 / 3);

    expectSame(at, easeOver(FROM, TO, 1));
  });

  it('šedesát snímků na dvacet tiků ujede tolik co dvacet tiků', () => {
    let at = FROM;
    for (let i = 0; i < 60; i += 1) at = easeOver(at, TO, 20 / 60);

    expectSame(at, easeOver(FROM, TO, 20), 9);
  });

  it('nerovnoměrné snímky dojedou tam co rovnoměrné — na tom stojí nezávislost na stroji', () => {
    // Skutečné snímky nejsou stejně dlouhé; jeden dlouhý a pár krátkých musí
    // dát tentýž výsledek, jinak by odstup kamery byl vlastností hardwaru.
    let uneven = FROM;
    for (const slice of [0.9, 0.05, 0.3, 1.75, 0.5]) uneven = easeOver(uneven, TO, slice);

    expectSame(uneven, easeOver(FROM, TO, 3.5));
  });
});

describe('krajní hodnoty', () => {
  it('nulový zlomek nechá kameru na místě', () => {
    expect(easeOver(FROM, TO, 0)).toBe(FROM);
  });

  it('záporný zlomek taky — couvání v čase není definované', () => {
    expect(easeOver(FROM, TO, -2)).toBe(FROM);
  });

  it('dojezd cíl nikdy nepřestřelí, ani při dlouhém výpadku snímků', () => {
    const far = easeOver(FROM, TO, 600);

    expect(far.x).toBeLessThanOrEqual(TO.x);
    expect(far.z).toBeGreaterThanOrEqual(TO.z);
    expectSame(far, TO, 6);
  });

  it('podíl ujetý za tik zůstal ten, na kterém stojí meze odstupu', () => {
    // `FOLLOW_ALPHA` drží ustálené zpoždění na (1 − α) / α ≈ 1,86 pole. Kdyby
    // se spojitý dojezd trefil jinam, meze v `e2e/camera.spec.ts` by se posunuly
    // a vypadalo by to jako vada kamery, ne jako změněná konstanta.
    const step = easeOver(FROM, TO, 1);

    expect((step.x - FROM.x) / (TO.x - FROM.x)).toBeCloseTo(FOLLOW_ALPHA, 12);
  });
});
