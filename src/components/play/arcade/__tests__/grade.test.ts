/**
 * Ladění barev podle rodiny prostředí (P37B T3). Na snímku vypadá „hezky“
 * i ladění, které celou hru jemně zfialoví – to brand zakazuje (žádná
 * fialová, odstín 250–320°) a oko na jednom snímku nepozná, že jde o tón
 * ladění, ne o paletu sady. Pin hlídá odstín každého zdvihu a zisku a že
 * noční rodina opravdu zvedá černou (bez toho hrdina v noci zapadne).
 */

import { describe, expect, it } from 'vitest';

import { LOOK_IDS } from '@/play/arcade/look';

import { GRADE_FAMILIES, GRADES, type Grade, LOOK_FAMILY, gradeOf } from '../look/rig/grade';

/** Odstín (°) barevné odchylky od neutrální šedé; `null` = bez odstínu. */
function tintHue([r, g, b]: Grade['lift']): number | null {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max - min < 1e-6) return null;
  const d = max - min;
  const hue = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (hue * 60 + 360) % 360;
}

describe('colour grade per look family', () => {
  it('gives every look a family and every family a grade', () => {
    for (const id of LOOK_IDS) expect(GRADE_FAMILIES).toContain(LOOK_FAMILY[id]);
    for (const family of GRADE_FAMILIES) expect(GRADES[family]).toBeDefined();
  });

  it.each(GRADE_FAMILIES)('%s never tints toward purple (hue 250–320°)', (family) => {
    const { lift, gain } = GRADES[family];
    for (const tint of [lift, gain]) {
      const hue = tintHue(tint);
      if (hue !== null) expect(hue < 250 || hue > 320, `${family} ${tint.join(',')} → ${hue.toFixed(0)}°`).toBe(true);
    }
  });

  it('lifts black and brightens midtones in the night looks, so the hero stays visible', () => {
    for (const id of ['graveyard', 'cave', 'space'] as const) {
      const grade = gradeOf(id);
      expect(Math.min(...grade.lift), id).toBeGreaterThan(0.02);
      expect(grade.gamma, id).toBeLessThan(1);
    }
  });

  it('pulls washed-out snow midtones down instead of brightening them', () => {
    expect(gradeOf('snow').gamma).toBeGreaterThan(1.1);
  });
});
