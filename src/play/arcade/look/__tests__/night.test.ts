/**
 * Noc (P56B T7, T13-R1): audit 21. 10. viděl noc skoro černou. Měsíc je slunce sady – studené, shora a zezadu –
 * a expozice se tmě přizpůsobí. Tmavá sada bez noci a nálady nesmí být tmavší než noc (stejná mez jako `withMood`).
 * Slepý soud pokusu 1 (T13) pak označil světlou výplň v noci za „broken white materials“: okraj toonu 0,5,
 * expozice 2,4× a měsíc 0,9 (přes mez nálad i polokoule strašidelných sad) ji přepálily. Jas plátna a výplně
 * měří `play-look-shots.mjs luma` a ořezy kulis (README T13-R1); tady jen čísla, která na jednom snímku
 * vypadají jako záměr.
 */
import { Color } from 'three';
import { describe, expect, it } from 'vitest';

import { exposureOf, lightFloor, NIGHT_EXPOSURE } from '@/components/play/arcade/look/rig/StyleRig';

import { type Look, LOOKS, sceneLook } from '../index';

const night = sceneLook({ setting: 'farm', mood: '', timeOfDay: 'night' });
const lit = (look: Look) => ({ ...look, ...lightFloor(look) });

/** Světlo na matné ploše jako `brightness` v katalogu: polokoule shora a slunce, lineární jas. */
const lum = (hex: string) => {
  const { r, g, b } = new Color(hex);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const brightness = (look: Pick<Look, 'light' | 'sun' | 'sunColor'>) => look.light[2] * lum(look.light[0]) + look.sun * lum(look.sunColor);

/** `ACESFilmicToneMapping` three 0.185 pro šedou (vstupní i výstupní matice šedou zachovají): křivka RRT + ODT. */
const aces = (radiance: number, exposure: number) => {
  const v = (radiance * exposure) / 0.6;
  return Math.min(Math.max((v * (v + 0.0245786) - 0.000090537) / (v * (0.983729 * v + 0.432951) + 0.238081), 0), 1);
};
const srgb = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

describe('night (P56B T7, T13-R1)', () => {
  it('moon is the scene sun: cold, from above and behind', () => {
    const moon = new Color(night.sunColor);
    expect(moon.b).toBeGreaterThan(moon.r);
    const [, up, forward] = night.sunDir;
    expect(up).toBeGreaterThan(Math.abs(forward));
    expect(forward).toBeGreaterThan(0);
  });

  it('a light prop at night stays within 1.3× of its 72665fdc brightness', () => {
    // Světlý kámen (albedo 0,6): matné světlo sady (Lambert, /π). Okraj toonu kulisy nemají (T13-R2, `toon.test`).
    const albedo = 0.6;
    const now = srgb(aces((albedo * brightness(lit(night))) / Math.PI, exposureOf(lit(night))));
    // 72665fdc: stejná polokoule, měsíc 0,35, expozice sady, bez toonu.
    const then = srgb(aces((albedo * brightness({ ...night, sun: 0.35 })) / Math.PI, night.exposure));
    expect(now / then).toBeGreaterThan(1);
    expect(now / then).toBeLessThanOrEqual(1.3);
  });

  // S měsícem 0,35 jsou hřbitov i jeskyně jasnější než noc; mez hlídá sadu tmavší než ony.
  const dimCave: Look = { ...LOOKS.cave, light: [LOOKS.cave.light[0], LOOKS.cave.light[1], LOOKS.cave.light[2] * 0.3], sun: LOOKS.cave.sun * 0.3 };

  it('dark sets without night or mood are never darker than the night', () => {
    for (const look of [LOOKS.graveyard, LOOKS.cave, dimCave]) expect(brightness(lit(look))).toBeGreaterThanOrEqual(brightness(night) - 1e-9);
    expect(brightness(dimCave)).toBeLessThan(brightness(night));
    expect(brightness(lit(dimCave))).toBeCloseTo(brightness(night), 6);
  });

  it('night and dark sets at the night floor get the eye adapted to the dark; lit or bright-sky scenes do not', () => {
    expect(NIGHT_EXPOSURE).toBeGreaterThan(1);
    expect(exposureOf(lit(night))).toBeCloseTo(night.exposure * NIGHT_EXPOSURE, 6);
    expect(exposureOf(lit(dimCave))).toBeCloseTo(dimCave.exposure * NIGHT_EXPOSURE, 6);
    const haunted = sceneLook({ setting: 'haunted mansion', mood: 'spooky' });
    expect(exposureOf(lit(haunted))).toBeGreaterThan(haunted.exposure * (1 + (NIGHT_EXPOSURE - 1) * 0.9));
    // Vesmír má tmavou oblohu, ale slunce 1,6; bouřka tmavé světlo, ale světlou oblohu.
    const storm = sceneLook({ setting: 'meadow', mood: '', weather: 'rain' });
    for (const look of [LOOKS.space, LOOKS.meadow, storm]) expect(exposureOf(lit(look))).toBe(look.exposure);
  });

  it('bright sets and the night itself keep their own light', () => {
    for (const look of [LOOKS.meadow, LOOKS.space, night]) {
      const floor = lightFloor(look);
      expect(floor.light).toEqual(look.light);
      expect(floor.sun).toBe(look.sun);
    }
  });
});
