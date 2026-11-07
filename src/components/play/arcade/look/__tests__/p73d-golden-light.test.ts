/**
 * P73D T4 – světlo zlaté hodiny a tilt-shift jen na `high`.
 *
 * Na snímku z desktopu (`high`) oko neuvidí, že telefon na `low`/`medium` rozostření nemá,
 * ani že noc a podmořská sada nezteplaly. Tohle pinuje obojí a meze slunce každé sady.
 */

import { Color, SRGBColorSpace } from 'three';
import { describe, expect, it } from 'vitest';

import { LOOK_IDS, LOOKS } from '@/play/arcade/look';

import { isPurple } from '../../../../../../scripts/assets/cc0/palette.mjs';
import { DIORAMA_FRAMING, FRAMING_KEEP, tiltFocus } from '../framing';
import { GOLDEN_SUN, GOLDEN_UP, GOLDEN_WARMTH, goldenHour } from '../rig/fog-light';
import { GRADES, LOOK_FAMILY } from '../rig/grade';
import { QUALITY_TIERS, TIER_SETTINGS } from '../rig/quality';

describe('P73D T4: tilt-shift', () => {
  it('runs only on high quality', () => {
    for (const tier of QUALITY_TIERS) expect(TIER_SETTINGS[tier].tilt, tier).toBe(tier === 'high');
  });

  it('keeps the hero sharp in every diorama framing, and leaves side views and the cockpit alone', () => {
    for (const [control, framing] of Object.entries(DIORAMA_FRAMING)) {
      const focus = tiltFocus(control)!;
      expect(focus, control).toBeGreaterThan((framing.hero + 1) / 2);
      expect(focus, control).toBeLessThan(0.65);
    }
    for (const control of Object.keys(FRAMING_KEEP)) expect(tiltFocus(control), control).toBeNull();
  });
});

describe('P73D T4: zlatá hodina', () => {
  it('drops every daytime sun to golden height, from the same side, without dimming it', () => {
    for (const id of LOOK_IDS) {
      const look = LOOKS[id];
      const family = LOOK_FAMILY[id];
      const golden = goldenHour(look, family);
      if (GOLDEN_WARMTH[family] === 0) {
        expect(golden, `${id}: ${family} keeps its own light`).toBe(look);
        continue;
      }
      const [left, up, forward] = golden.sunDir;
      const length = Math.hypot(left, up, forward);
      expect(up / length, `${id}: sun height`).toBeLessThanOrEqual(GOLDEN_UP + 1e-9);
      expect(up / length, `${id}: still above the horizon`).toBeGreaterThan(0.3);
      expect(Math.sign(left), `${id}: same side`).toBe(Math.sign(look.sunDir[0]));
      expect(Math.sign(forward), `${id}: same side`).toBe(Math.sign(look.sunDir[2]));
      // Stín hrdiny zůstane čitelný: slunce neslábne, nanejvýš o pětinu zesílí.
      expect(golden.sun, `${id}: sun`).toBeGreaterThanOrEqual(look.sun);
      expect(golden.sun, `${id}: sun`).toBeLessThanOrEqual(look.sun * 1.2 + 1e-9);
    }
  });

  it('warms the sun of daytime families and never turns it purple', () => {
    const rgb = { r: 0, g: 0, b: 0 };
    for (const id of LOOK_IDS) {
      const family = LOOK_FAMILY[id];
      if (GOLDEN_WARMTH[family] === 0) continue;
      const [before, after, gold] = [LOOKS[id].sunColor, goldenHour(LOOKS[id], family).sunColor, GOLDEN_SUN].map((hex) => new Color(hex));
      // Slunce chladnější než zlatá zteplá; teplejší (sopka) zůstane, jak je.
      if (before.r - before.b < gold.r - gold.b) expect(after.r - after.b, `${id}: warmer`).toBeGreaterThan(before.r - before.b);
      else expect(after.getHex(), `${id}: already warm`).toBe(before.getHex());
      after.getRGB(rgb, SRGBColorSpace);
      expect(isPurple([rgb.r, rgb.g, rgb.b]), id).toBe(false);
    }
  });

  it('grades daytime warmer and softer, while night, water and snow keep their tone', () => {
    for (const family of ['green', 'warm', 'indoor'] as const) {
      expect(GRADES[family].saturation, family).toBeLessThanOrEqual(1.06);
      expect(GRADES[family].gain[0], family).toBeGreaterThan(GRADES[family].gain[2] + 0.05);
    }
    expect(GRADES.cold).toEqual({ lift: [0, 0.01, 0.03], gain: [0.99, 1, 1.01], gamma: 1.22, saturation: 1.2, contrast: 1.1, vignette: 0.2 });
    expect(GRADES.water).toEqual({ lift: [0, 0.02, 0.03], gain: [0.98, 1.02, 1.03], gamma: 1.04, saturation: 1.12, contrast: 1.06, vignette: 0.26 });
    expect(GRADES.dark).toEqual({ lift: [0.03, 0.045, 0.07], gain: [1, 1.02, 1.04], gamma: 0.8, saturation: 1.1, contrast: 1, vignette: 0.3 });
  });
});
