/**
 * P77 T3: kontaktní stín existuje i na `low` (telefon bez N8AO) a tón stínu místa není černý ani fialový.
 */
import { describe, expect, it } from 'vitest';
import { Color } from 'three';

import { ROLE } from '@/play/arcade/contract';
import { LOOKS } from '@/play/arcade/look';

import { type Cast, hasContact } from '../../World';
import { blobAlpha, SHADE_L, shadeSky, shadowTone, shadowToneLab } from '../contact-shadow';
import { TIER_SETTINGS } from '../rig/quality';
import { oklab, type Rgb } from '../rig/toon';

const cast: Cast = { player: 'p', enemy: 'e', chaser: 'c', props: {} };
const body = (kind: string, role: number = ROLE.obstacle) => ({ index: 1, kind, role, w: 1, h: 1, d: 1 });
const hsl = (hex: string) => new Color(hex).getHSL({ h: 0, s: 0, l: 0 });
const lightness = (hex: string): number => oklab(new Color(hex).toArray() as unknown as Rgb)[0];

describe('contact shadows stand in for N8AO on the phone tier', () => {
  it('low has no N8AO, and a grounded model body gets a contact shadow regardless of tier', () => {
    expect(TIER_SETTINGS.low.ao).toBe(false);
    expect(hasContact(body('player', ROLE.player), cast, 0)).toBe(true);
    expect(hasContact(body('crate'), cast, 0)).toBe(true);
  });

  it('things in the air, primitives and structures get none', () => {
    expect(hasContact(body('coin', ROLE.collectible), cast, 1.2)).toBe(false);
    expect(hasContact(body('platform'), cast, 0)).toBe(false);
    expect(hasContact(body('pipe'), cast, 0)).toBe(false);
  });

  it('a body as wide as the track is a surface, not a thing – its ellipse would grey the whole track', () => {
    expect(hasContact({ ...body('finish'), w: 8, d: 0.5 }, cast, 0)).toBe(false);
    expect(hasContact({ ...body('crate'), w: 2, d: 2 }, cast, 0)).toBe(true);
  });

  it('the baked ellipse fades to nothing at its rim', () => {
    expect(blobAlpha(0)).toBe(1);
    expect(blobAlpha(0.5)).toBeGreaterThan(0.4);
    expect(blobAlpha(1)).toBe(0);
  });
});

describe('the shadow tone of every place comes from its palette, never black or purple', () => {
  for (const [id, look] of Object.entries(LOOKS)) {
    it(id, () => {
      const tone = shadowTone(look.palette);
      expect(lightness(tone)).toBeGreaterThan(SHADE_L - 0.03);
      const { h, s } = hsl(tone);
      if (s > 0.1) expect(h * 360 < 250 || h * 360 > 320, `${tone} leans purple`).toBe(true);
      // Odstín je z palety: směr (a, b) tónu stínu míří stejně jako některý tón palety.
      const [, a, b] = shadowToneLab(look.palette);
      if (Math.hypot(a, b) > 1e-3) {
        const angles = look.palette.map((hex) => {
          const [, pa, pb] = oklab(new Color(hex).toArray() as unknown as Rgb);
          return Math.atan2(pb, pa);
        });
        expect(angles.some((angle) => Math.abs(Math.atan2(Math.sin(angle - Math.atan2(b, a)), Math.cos(angle - Math.atan2(b, a)))) < 1e-6)).toBe(true);
      }
      // Obloha polokulového světla nese odstín stínu, ale světlost si drží.
      const sky = shadeSky(look.light[0], look.palette);
      expect(Math.abs(lightness(sky) - lightness(look.light[0]))).toBeLessThan(0.02);
      const { h: skyH, s: skyS } = hsl(sky);
      if (skyS > 0.1) expect(skyH * 360 < 250 || skyH * 360 > 320, `${sky} leans purple`).toBe(true);
    });
  }
});
