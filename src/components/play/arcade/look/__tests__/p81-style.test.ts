/**
 * P81: jeden profil vzhledu celého obrazu (`LookStyle`).
 *
 * T2 – profil „dnes“ musí dát přesně ty hodnoty, které byly v kódu jako konstanty před P81, jinak by se tiše
 * posunul vzhled všech her; každé místo, které vzhled kreslí, čte aktivní profil, ne vlastní kopii čísla.
 * T3 – směr mix (majitel 9. 11.): žádná barva palety, světla, oblohy ani mlhy ve fialové (250–320°), noc, hala
 * a místa bez slunce si tón nechají a podlaha pod teplým sluncem nezhnědne (odstín osvětlené země drží).
 */

import { Color, SRGBColorSpace } from 'three';
import { describe, expect, it } from 'vitest';

import { LOOK_IDS, LOOKS, type Look, sceneLook } from '@/play/arcade/look';
import { LOOK_STYLE, MIX_STYLE, restyleLook, TODAY_STYLE } from '@/play/arcade/look/style';

import { isPurple } from '../../../../../../scripts/assets/cc0/palette.mjs';
import { INK_PX, INK_SURFACE } from '../rig/InkOutline';
import { airOf, BACK_LIGHT, BACK_SKY, FOG_PORTRAIT_START, FOG_SATURATION, FOG_START, FOG_STORM_START, GOLDEN_SUN, GOLDEN_UP, GOLDEN_WARMTH, HEMI_LIFT, SHADOW_INTENSITY, SHADOW_RADIUS, SNOW_SHADOW, SUN_LIFT } from '../rig/fog-light';
import { GRADES, LOW_CONTRAST } from '../rig/grade';
import { arenaPalette, buildArenaFloor } from '../rig/terrain/arenaFloor';

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
      snowShadow: 0.95,
      backLight: 0.45,
      backSky: 0.5,
    });
  });

  it('paleta, obloha, mlha, podlaha, obrysy a následné zpracování', () => {
    expect(TODAY_STYLE.palette).toBeNull();
    expect(TODAY_STYLE.sky).toEqual({ painted: true, paintHaze: 0.3, hazeBand: 0.18, gradient: 0 });
    expect(TODAY_STYLE.fog).toEqual({ start: 0.6, storm: 0.6, portrait: 0.6, saturation: 0.18 });
    expect(TODAY_STYLE.floor).toEqual({ roughness: 0.9, ice: 0.45, wall: 0.85, seam: 1, laneLine: '#e2e8f0' });
    expect(TODAY_STYLE.ink).toEqual({ px: 1.5, scenery: false, surface: { hero: 0.7, foe: 0, obstacle: 0.7, scenery: 0.7 } });
    expect(TODAY_STYLE.post).toEqual({ bloom: 0.8, tilt: 1 });
  });

  it('ladění rodin, kontrast telefonu a expozice (split 0 = zisk na všechny tóny jako dřív)', () => {
    expect(TODAY_STYLE.grade).toEqual({
      exposure: 1,
      lowContrast: 0.08,
      families: {
        green: { lift: [0.01, 0.01, 0.015], gain: [1.05, 1.01, 0.94], split: 0, gamma: 1.04, saturation: 1.06, contrast: 1.06, vignette: 0.22 },
        warm: { lift: [0.02, 0.01, 0], gain: [1.05, 1, 0.92], split: 0, gamma: 1.04, saturation: 1.04, contrast: 1.08, vignette: 0.22 },
        cold: { lift: [0, 0.01, 0.03], gain: [0.99, 1, 1.01], split: 0, gamma: 1.22, saturation: 1.2, contrast: 1.1, vignette: 0.2 },
        water: { lift: [0, 0.02, 0.03], gain: [0.98, 1.02, 1.03], split: 0, gamma: 1.04, saturation: 1.12, contrast: 1.06, vignette: 0.26 },
        indoor: { lift: [0.01, 0.01, 0], gain: [1.04, 1, 0.95], split: 0, gamma: 1.03, saturation: 1.04, contrast: 1.06, vignette: 0.2 },
        dark: { lift: [0.03, 0.045, 0.07], gain: [1, 1.02, 1.04], split: 0, gamma: 0.8, saturation: 1.1, contrast: 1, vignette: 0.3 },
      },
    });
  });

  it('paletu místa nemění', () => {
    for (const id of LOOK_IDS) expect(restyleLook(LOOKS[id], id, { night: false, overcast: false }, TODAY_STYLE)).toBe(LOOKS[id]);
  });
});

describe('rig čte aktivní profil', () => {
  it('světlo a mlha (`fog-light.ts`)', () => {
    const { light, fog } = LOOK_STYLE;
    expect([FOG_START, FOG_STORM_START, FOG_PORTRAIT_START, FOG_SATURATION]).toEqual([fog.start, fog.storm, fog.portrait, fog.saturation]);
    expect(SNOW_SHADOW).toBe(light.snowShadow);
    expect([GOLDEN_UP, GOLDEN_SUN, GOLDEN_WARMTH]).toEqual([light.goldenUp, light.goldenSun, light.goldenWarmth]);
    expect([HEMI_LIFT, SUN_LIFT, SHADOW_INTENSITY, SHADOW_RADIUS, BACK_LIGHT, BACK_SKY]).toEqual([light.hemiLift, light.sunLift, light.shadowIntensity, light.shadowRadius, light.backLight, light.backSky]);
  });

  it('ladění (`grade.ts`) a obrysy (`InkOutline.tsx`)', () => {
    expect(GRADES).toBe(LOOK_STYLE.grade.families);
    expect(LOW_CONTRAST).toBe(LOOK_STYLE.grade.lowContrast);
    expect(INK_PX).toBe(LOOK_STYLE.ink.px);
    expect(INK_SURFACE).toBe(LOOK_STYLE.ink.surface);
  });
});

/** Místo v náladách a denních dobách, jak je hra opravdu dostane (`sceneLook`). */
const MOODS = ['', 'bright sunny', 'stormy', 'foggy', 'spooky', 'gloomy', 'snowy', 'at dusk', 'at night'] as const;
const SETTING: Readonly<Record<(typeof LOOK_IDS)[number], string>> = {
  meadow: 'a meadow', city: 'a city', mall: 'a mall', supermarket: 'a supermarket', living_room: 'a living room', factory: 'a factory',
  forest: 'a forest', jungle: 'a jungle', desert: 'a desert', beach: 'a beach', ocean: 'the ocean', underwater: 'a coral reef',
  snow: 'a snowy slope', cave: 'a cave', volcano: 'a volcano', space: 'space', castle: 'a castle courtyard', graveyard: 'a graveyard',
};
const scenes = LOOK_IDS.flatMap((id) =>
  MOODS.map((mood) => ({ id, name: `${id} ${mood}`.trim(), theme: { setting: `${SETTING[id]}${mood.startsWith('at ') ? ` ${mood}` : ''}`, mood: mood.startsWith('at ') ? '' : mood, look: id } })),
);

/** Všechny barvy, které vzhled kreslí: obloha, mlha, světla, povrchy, paleta kulis. */
function colorsOf(look: Look): Record<string, string> {
  return {
    sky: look.sky,
    skyTop: look.skyTop,
    horizon: look.horizon,
    fog: airOf(look).color,
    sun: look.sunColor,
    hemiSky: look.light[0],
    hemiGround: look.light[1],
    ground: look.ground,
    track: look.track,
    water: look.water,
    tint0: look.tint[0],
    tint1: look.tint[1],
    ...(look.land === undefined ? {} : { land: look.land }),
    ...(look.block === undefined ? {} : { block0: look.block[0], block1: look.block[1] }),
    ...(look.terrain === undefined ? {} : { lane: look.terrain.lane, shade: look.terrain.shade, rock: look.terrain.rock }),
    ...Object.fromEntries(look.palette.map((color, i) => [`palette${i}`, color])),
  };
}
const purple = (hex: string): boolean => {
  const { r, g, b } = new Color(hex).getRGB({ r: 0, g: 0, b: 0 }, SRGBColorSpace);
  return isPurple([r, g, b]);
};

describe('P81 T3: směr mix', () => {
  it('je aktivní profil a mlha nezačíná blíž než ve čtvrtině dohledu', () => {
    expect(LOOK_STYLE).toBe(MIX_STYLE);
    expect(MIX_STYLE.fog.start).toBeGreaterThanOrEqual(0.25);
  });

  it.each(scenes)('$name: žádná barva nesklouzne do fialové', ({ id, theme }) => {
    const before = colorsOf(sceneLook(theme, TODAY_STYLE));
    const after = colorsOf(sceneLook(theme));
    expect(id in LOOKS).toBe(true);
    for (const [key, color] of Object.entries(after)) {
      // Fialová, kterou si hráč řekl větou (barva sady už fialová), smí zůstat; nová vzniknout nesmí.
      if (before[key] !== undefined && purple(before[key])) continue;
      expect(purple(color), `${key} ${color}`).toBe(false);
    }
  });

  it('ladění profilu nemá fialový zdvih ani zisk', () => {
    for (const grade of Object.values(MIX_STYLE.grade.families)) {
      for (const tone of [grade.lift, grade.gain]) expect(Math.min(tone[0], tone[2]) > tone[1] + 0.02 && tone[2] > tone[0], `${tone}`).toBe(false);
    }
  });

  // s9 (déšť ve městě): opar od čtvrtiny a chladný zdvih posunuly zem pod hrdinou o 46° do modré.
  it('bouřka si nechá zem a mlhu P76, hala a město ladění', () => {
    const rain = sceneLook({ setting: 'a city', mood: '', look: 'city', weather: 'rain' });
    expect(rain.storm).toBe(true);
    expect(rain).toEqual(sceneLook({ setting: 'a city', mood: '', look: 'city', weather: 'rain' }, TODAY_STYLE));
    expect(airOf(rain).near).toBeGreaterThanOrEqual(TODAY_STYLE.fog.start * rain.fog[1]);
    expect(airOf({ ...rain, storm: undefined }).near).toBeLessThan(TODAY_STYLE.fog.start * rain.fog[1]);
    expect(GRADES.indoor).toEqual(TODAY_STYLE.grade.families.indoor);
  });

  it('noc, hala, místa bez slunce a noční rodina si tón nechají', () => {
    for (const id of LOOK_IDS) {
      const look = LOOKS[id];
      const kept = restyleLook(look, id, { night: true, overcast: false });
      expect(kept, `${id} v noci`).toBe(look);
      if (look.ceiling !== undefined || look.glow === 0 || ['cave', 'graveyard', 'space'].includes(id)) expect(restyleLook(look, id, { night: false, overcast: false }), id).toBe(look);
    }
  });

  it('nízké teplé slunce jen pod jasnou oblohou; pod zataženou jen sytost', () => {
    const meadow = LOOKS.meadow;
    const sunny = restyleLook(meadow, 'meadow', { night: false, overcast: false });
    const [left, up, forward] = sunny.sunDir;
    expect(up / Math.hypot(left, up, forward)).toBeCloseTo(MIX_STYLE.palette!.sunUp, 6);
    const warm = new Color(sunny.sunColor);
    expect(warm.r - warm.b).toBeGreaterThan(0);
    const storm = restyleLook(meadow, 'meadow', { night: false, overcast: true });
    expect([storm.sunDir, storm.sunColor, storm.sun]).toEqual([meadow.sunDir, meadow.sunColor, meadow.sun]);
  });

  it.each(LOOK_IDS.filter((id) => LOOKS[id].ceiling === undefined && LOOKS[id].glow > 0 && !['cave', 'graveyard', 'space'].includes(id)))(
    '%s: osvětlená podlaha a dráha drží odstín (uber oranžové, nejvýš 15°)',
    (id) => {
      const before = LOOKS[id];
      const after = restyleLook(before, id, { night: false, overcast: false });
      const lit = (floor: string, sun: string) => {
        const [f, s] = [new Color(floor), new Color(sun)];
        return new Color(f.r * s.r, f.g * s.g, f.b * s.b);
      };
      const floors: [string, string][] = [[before.ground, after.ground], [before.track, after.track], ...(before.block === undefined ? [] : [[before.block[1], after.block![1]] as [string, string]])];
      for (const [was, now] of floors) {
        const [a, b] = [lit(was, before.sunColor).getHSL({ h: 0, s: 0, l: 0 }), lit(now, after.sunColor).getHSL({ h: 0, s: 0, l: 0 })];
        if (a.s < 0.08 || b.s < 0.08) continue;
        // Skoro bílý sníh `#f8fafc` dnešní teplé slunce barví do oranžova (odstín 33°, sytost 0,74); P81 ho vrací
        // k neutrální (50°, 0,27) a odstín málo syté barvy už nic neříká. Oranžovější být nesmí: buď drží odstín,
        // nebo aspoň o polovinu zneutrální.
        if (b.s <= a.s / 2) continue;
        const shift = Math.abs(((b.h - a.h) * 360 + 540) % 360 - 180);
        expect(shift, `${was} → ${now}`).toBeLessThanOrEqual(15);
      }
    },
  );
});

/**
 * T4 – podlaha arény blíž předloze, hratelnost beze změny: hrdina nesmí levitovat ani se bořit, takže hrací plocha
 * leží celá v y = 0 a val ani stěna nad ni nesahá; podlaha je velká jako na `main` (±(půl + 50 m)).
 */
describe('P81 T4: podlaha arény a terén', () => {
  const HALF = 20;
  const outdoor = LOOK_IDS.filter((id) => LOOKS[id].interior === undefined);

  it.each(outdoor)('%s: hrací plocha v y = 0, val ani stěna do ní nesahá, rozměr jako dřív', (id) => {
    const arena = buildArenaFloor({ look: sceneLook({ setting: SETTING[id], mood: '', look: id }), half: HALF });
    const floor = arena.floor.getAttribute('position');
    let [low, high] = [Infinity, -Infinity];
    for (let i = 0; i < floor.count; i += 1) {
      expect(floor.getY(i), id).toBe(0);
      [low, high] = [Math.min(low, floor.getX(i), floor.getZ(i)), Math.max(high, floor.getX(i), floor.getZ(i))];
    }
    expect([low, high], id).toEqual([-(HALF + 50), HALF + 50]);
    const walls = arena.walls.getAttribute('position');
    for (let i = 0; i < walls.count; i += 1) {
      if (walls.getY(i) > 1e-6) expect(Math.max(Math.abs(walls.getX(i)), Math.abs(walls.getZ(i))), id).toBeGreaterThan(HALF);
    }
    expect(arena.heightAt(3, -7)).toBe(0);
  });

  it('hradní nádvoří venku nemá spáry dlažby; tráva má místo kvádrů nízký val', () => {
    const castle = sceneLook({ setting: SETTING.castle, mood: '', look: 'castle' });
    const seam = new Color(arenaPalette(castle).seam);
    const colors = buildArenaFloor({ look: castle, half: HALF }).floor.getAttribute('color');
    let seams = 0;
    for (let i = 0; i < colors.count; i += 1) if (Math.abs(colors.getX(i) - seam.r) + Math.abs(colors.getY(i) - seam.g) + Math.abs(colors.getZ(i) - seam.b) < 1e-3) seams += 1;
    expect(seams).toBe(0);
    const ring = buildArenaFloor({ look: sceneLook({ setting: SETTING.meadow, mood: '', look: 'meadow' }), half: HALF }).walls.getAttribute('position');
    let top = 0;
    for (let i = 0; i < ring.count; i += 1) top = Math.max(top, ring.getY(i));
    expect(top).toBeGreaterThan(0.5);
    expect(top).toBeLessThanOrEqual(1.6);
  });
});
