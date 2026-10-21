/**
 * Noc (P56B T7): audit 21. 10. viděl noc skoro černou. Měsíc je dnešní slunce sady – silný a studený,
 * kontury nese okraj toonu, který v noci sílí, a expozice se tmě přizpůsobí. Tmavá sada bez noci a nálady
 * nesmí být tmavší než noc (stejná mez jako `withMood`). Jas plátna měří `play-look-shots.mjs luma`
 * (README T7); tady jen čísla, která na jednom snímku vypadají jako záměr.
 */
import { Color } from 'three';
import { describe, expect, it } from 'vitest';

import { exposureOf, lightFloor, NIGHT_EXPOSURE } from '@/components/play/arcade/look/rig/StyleRig';
import { setScenePalette, TOON_RIM_DAY, toon } from '@/components/play/arcade/look/rig/toon';

import { type Look, LOOKS, sceneLook } from '../index';

const night = sceneLook({ setting: 'farm', mood: '', timeOfDay: 'night' });
const day = sceneLook({ setting: 'farm', mood: '' });

/** Světlo na matné ploše jako `brightness` v katalogu: polokoule shora a slunce, lineární jas. */
const lum = (hex: string) => {
  const { r, g, b } = new Color(hex);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const brightness = (look: Pick<Look, 'light' | 'sun' | 'sunColor'>) => look.light[2] * lum(look.light[0]) + look.sun * lum(look.sunColor);

describe('night (P56B T7)', () => {
  it('moon is the scene sun: strong, cold, from above and behind', () => {
    expect(night.sun).toBeGreaterThanOrEqual(0.8);
    const moon = new Color(night.sunColor);
    expect(moon.b).toBeGreaterThan(moon.r);
    const [, up, forward] = night.sunDir;
    expect(up).toBeGreaterThan(Math.abs(forward));
    expect(forward).toBeGreaterThan(0);
  });

  it('toon rim is stronger at night than by day', () => {
    setScenePalette(day);
    expect(toon.rim.value).toBe(TOON_RIM_DAY);
    setScenePalette(night);
    expect(toon.rim.value).toBeGreaterThan(TOON_RIM_DAY);
  });

  it('dark sets without night or mood are never darker than the night', () => {
    for (const look of [LOOKS.graveyard, LOOKS.cave]) {
      expect(brightness(look)).toBeLessThan(brightness(night));
      expect(brightness({ ...look, ...lightFloor(look) })).toBeCloseTo(brightness(night), 6);
    }
  });

  it('night and dark sets at the night floor get the eye adapted to the dark; lit or bright-sky scenes do not', () => {
    const lit = (look: Look) => ({ ...look, ...lightFloor(look) });
    expect(exposureOf(lit(night))).toBeCloseTo(night.exposure * NIGHT_EXPOSURE, 6);
    expect(exposureOf(lit(LOOKS.graveyard))).toBeCloseTo(LOOKS.graveyard.exposure * NIGHT_EXPOSURE, 6);
    const haunted = sceneLook({ setting: 'haunted mansion', mood: 'spooky' });
    expect(exposureOf(lit(haunted))).toBeGreaterThan(haunted.exposure * 1.9);
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
