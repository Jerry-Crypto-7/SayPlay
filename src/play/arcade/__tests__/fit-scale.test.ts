/**
 * Měřítko čitelnosti (P58A T3): hrdina a nejbližší cíl dorostou na plátně do výšky, nad kterou je soudce
 * nenazve „malými“, jen vizuálně a nejvýš 2×. Špatné měřítko vypadá „rozumně“ i pod prahem – proto čísla.
 */

import { describe, expect, it } from 'vitest';

import { LEGIBLE_CAP, LEGIBLE_SHARE, legibleScale, legibleWrite } from '../models';

describe('legibleScale', () => {
  it('grows a body under the minimum share to exactly the minimum', () => {
    // Hrdina na 10 % výšky plátna potřebuje dvojnásobek, na 16 % 1,25×.
    expect(legibleScale(1, 0.1, LEGIBLE_SHARE.hero)).toBeCloseTo(2);
    expect(legibleScale(1, 0.16, LEGIBLE_SHARE.hero)).toBeCloseTo(1.25);
    // Měřený podíl už nese dnešní měřítko: 1,5× a 15 % → 2×.
    expect(legibleScale(1.5, 0.15, LEGIBLE_SHARE.hero)).toBeCloseTo(2);
    expect(legibleScale(1, 0.08, LEGIBLE_SHARE.target)).toBeCloseTo(1.25);
  });

  it('never goes under 1 or past the cap', () => {
    expect(legibleScale(1, 0.35, LEGIBLE_SHARE.hero)).toBe(1);
    // Poletování (6 %) by chtělo 3,3× – kolizní tělo by pak hráč neviděl.
    expect(legibleScale(1, 0.06, LEGIBLE_SHARE.hero)).toBe(LEGIBLE_CAP);
    expect(legibleScale(LEGIBLE_CAP, 0.1, LEGIBLE_SHARE.hero)).toBe(LEGIBLE_CAP);
  });

  it('shrinks back only well above the minimum, so a body does not pulse', () => {
    // Najetí kamery: hrdina na startu malý dorostl 2×, kamera dojela a teď zabírá 47 % – zpět na 1×.
    expect(legibleScale(2, 0.47, LEGIBLE_SHARE.hero)).toBe(1);
    // 1,6× a 40 %: přesné měřítko 0,8 → 1.
    expect(legibleScale(1.6, 0.4, LEGIBLE_SHARE.hero)).toBe(1);
    // 2× a 32 %: přesně 1,25×, zmenší se na 1,25 × 1,15 – tělo pak leží na 23 %.
    expect(legibleScale(2, 0.32, LEGIBLE_SHARE.hero)).toBeCloseTo(1.4375);
    // Klidové pásmo 20–26 %: měřítko stojí, ať se tělo s hloubkou nenafukuje a nesplaskává.
    expect(legibleScale(1.5, 0.21, LEGIBLE_SHARE.hero)).toBe(1.5);
    expect(legibleScale(1.5, 0.25, LEGIBLE_SHARE.hero)).toBe(1.5);
    expect(legibleScale(1.4375, 0.23, LEGIBLE_SHARE.hero)).toBe(1.4375);
  });

  it('keeps the scale when nothing was measured', () => {
    expect(legibleScale(1.3, 0, LEGIBLE_SHARE.hero)).toBe(1.3);
    expect(legibleScale(1, Number.NaN, LEGIBLE_SHARE.target)).toBe(1);
  });

  it('writes the legible scale once per frame, axis by axis, over whatever the scene wrote', () => {
    const scale = { x: 1, y: 1, z: 1 };
    const body = { scale: 1.5, base: { ...scale }, written: { ...scale } };
    // Scéna každý snímek přepíše jen výšku (skluz hrdiny v `World`): šířka nesmí růst snímek po snímku.
    for (let frame = 0; frame < 60; frame += 1) {
      scale.y = frame < 30 ? 1 : 0.5;
      legibleWrite(scale, body);
    }
    expect(scale).toEqual({ x: 1.5, y: 0.75, z: 1.5 });
    // Scéna nic nepíše: zůstává základ krát měřítko, i když měřítko mezitím doroste.
    body.scale = 2;
    legibleWrite(scale, body);
    legibleWrite(scale, body);
    expect(scale).toEqual({ x: 2, y: 1, z: 2 });
    // Scéna přepíše celé měřítko (zablikání sebrané mince): to je nový základ.
    Object.assign(scale, { x: 0.3, y: 0.3, z: 0.3 });
    legibleWrite(scale, body);
    expect(scale).toEqual({ x: 0.6, y: 0.6, z: 0.6 });
  });

  it('holds the P58A T2 targets: hero 20 %, foe or item 10 % of the canvas height', () => {
    expect(LEGIBLE_SHARE).toEqual({ hero: 0.2, target: 0.1 });
    expect(LEGIBLE_CAP).toBe(2);
  });
});
