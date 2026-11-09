/**
 * P81 T2: jeden profil vzhledu celého obrazu (`LookStyle`). Profil „dnes“ musí dát přesně ty hodnoty,
 * které byly v kódu jako konstanty před P81 – jinak by se tiše posunul vzhled všech her. A každé místo,
 * které vzhled kreslí, musí číst aktivní profil, ne vlastní kopii čísla.
 */

import { describe, expect, it } from 'vitest';

import { LOOK_STYLE, TODAY_STYLE } from '@/play/arcade/look/style';

import { INK_PX, INK_SURFACE } from '../rig/InkOutline';
import { BACK_LIGHT, BACK_SKY, FOG_SATURATION, FOG_START, GOLDEN_SUN, GOLDEN_UP, GOLDEN_WARMTH, HEMI_LIFT, SHADOW_INTENSITY, SHADOW_RADIUS, SUN_LIFT } from '../rig/fog-light';
import { GRADES, LOW_CONTRAST } from '../rig/grade';

describe('profil „dnes“ = konstanty před P81', () => {
  it('světlo, stín a protisvětlo', () => {
    expect(TODAY_STYLE.light).toEqual({
      goldenUp: 0.62,
      goldenSun: '#ffc68c',
      goldenWarmth: { green: 0.42, warm: 0.35, cold: 0.2, water: 0, indoor: 0, dark: 0 },
      goldenGainMost: 1.2,
      hemiLift: 1.2,
      sunLift: 1.1,
      shadowRadius: 2,
      shadowIntensity: 0.95,
      backLight: 0.45,
      backSky: 0.5,
    });
  });

  it('obloha, mlha, podlaha, obrysy a následné zpracování', () => {
    expect(TODAY_STYLE.sky).toEqual({ painted: true, paintHaze: 0.3 });
    expect(TODAY_STYLE.fog).toEqual({ start: 0.6, saturation: 0.18 });
    expect(TODAY_STYLE.floor).toEqual({ roughness: 0.9, ice: 0.45, wall: 0.85, seam: 1, laneLine: '#e2e8f0' });
    expect(TODAY_STYLE.ink).toEqual({ px: 1.5, surface: { hero: 0.7, foe: 0, obstacle: 0.7 } });
    expect(TODAY_STYLE.post).toEqual({ bloom: 0.8, tilt: 1 });
  });

  it('ladění rodin, kontrast telefonu a expozice', () => {
    expect(TODAY_STYLE.grade).toEqual({
      exposure: 1,
      lowContrast: 0.08,
      families: {
        green: { lift: [0.01, 0.01, 0.015], gain: [1.05, 1.01, 0.94], gamma: 1.04, saturation: 1.06, contrast: 1.06, vignette: 0.22 },
        warm: { lift: [0.02, 0.01, 0], gain: [1.05, 1, 0.92], gamma: 1.04, saturation: 1.04, contrast: 1.08, vignette: 0.22 },
        cold: { lift: [0, 0.01, 0.03], gain: [0.99, 1, 1.01], gamma: 1.22, saturation: 1.2, contrast: 1.1, vignette: 0.2 },
        water: { lift: [0, 0.02, 0.03], gain: [0.98, 1.02, 1.03], gamma: 1.04, saturation: 1.12, contrast: 1.06, vignette: 0.26 },
        indoor: { lift: [0.01, 0.01, 0], gain: [1.04, 1, 0.95], gamma: 1.03, saturation: 1.04, contrast: 1.06, vignette: 0.2 },
        dark: { lift: [0.03, 0.045, 0.07], gain: [1, 1.02, 1.04], gamma: 0.8, saturation: 1.1, contrast: 1, vignette: 0.3 },
      },
    });
  });
});

describe('rig čte aktivní profil', () => {
  it('světlo a mlha (`fog-light.ts`)', () => {
    const { light, fog } = LOOK_STYLE;
    expect([FOG_START, FOG_SATURATION]).toEqual([fog.start, fog.saturation]);
    expect([GOLDEN_UP, GOLDEN_SUN, GOLDEN_WARMTH]).toEqual([light.goldenUp, light.goldenSun, light.goldenWarmth]);
    expect([HEMI_LIFT, SUN_LIFT, SHADOW_RADIUS, SHADOW_INTENSITY, BACK_LIGHT, BACK_SKY]).toEqual([light.hemiLift, light.sunLift, light.shadowRadius, light.shadowIntensity, light.backLight, light.backSky]);
  });

  it('ladění (`grade.ts`) a obrysy (`InkOutline.tsx`)', () => {
    expect(GRADES).toBe(LOOK_STYLE.grade.families);
    expect(LOW_CONTRAST).toBe(LOOK_STYLE.grade.lowContrast);
    expect(INK_PX).toBe(LOOK_STYLE.ink.px);
    expect(INK_SURFACE).toBe(LOOK_STYLE.ink.surface);
  });
});
