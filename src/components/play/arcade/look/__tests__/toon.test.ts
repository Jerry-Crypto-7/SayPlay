/**
 * P56B T6: toon a paleta sady jedním shaderovým patchem. Patch, jehož kotva v shaderu po aktualizaci
 * three chybí, chybu nevyhodí a scéna vypadá „skoro stejně“ – proto test kotev a klíčů programů.
 */
import { BoxGeometry, Color, Group, Mesh, MeshStandardMaterial, ShaderChunk, ShaderLib } from 'three';
import { describe, expect, it } from 'vitest';

import { LOOK_IDS, LOOKS } from '@/play/arcade/look';

import { glowingCopy, mergeBody, patchedClone, plantMaterial, rimMaterial, toonLit } from '../load';
import { colorHex } from '@/brand/tokens';

import { CLAY_RIM, CLAY_ROUGHNESS, COLOR, COMMON, DIFFUSE, darkness, EMISSIVE, LIGHTS, PALETTE_MIX, PHYSICAL, paletteMix, type Rgb, scenePaletteOf, setScenePalette, toon, toonPatch } from '../rig/toon';

function compiled(material: { onBeforeCompile(shader: never, renderer: never): void }) {
  const shader = { vertexShader: ShaderLib.standard.vertexShader, fragmentShader: ShaderLib.standard.fragmentShader, uniforms: {} as Record<string, unknown> };
  material.onBeforeCompile(shader as never, undefined as never);
  return shader;
}

const count = (text: string, needle: string): number => text.split(needle).length - 1;
const linear = (hex: string): Rgb => {
  const { r, g, b } = new Color(hex);
  return [r, g, b];
};

function oklab([r, g, b]: Rgb): Rgb {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}
const gap = (a: Rgb, b: Rgb): number => Math.hypot(...oklab(a).map((value, i) => value - oklab(b)[i]!));
const nearestGap = (color: Rgb, palette: readonly Rgb[]): number => Math.min(...palette.map((entry) => gap(color, entry)));

/** Odstín v sRGB 250–320° se sytostí – fialová, kterou brand zakazuje. */
function purple(color: Rgb): boolean {
  const [r, g, b] = new Color().setRGB(...color).getStyle().match(/\d+/g)!.map(Number) as [number, number, number];
  const max = Math.max(r, g, b);
  const span = max - Math.min(r, g, b);
  if (max < 50 || span / max < 0.25) return false;
  const hue = max === r ? (60 * ((g - b) / span) + 360) % 360 : max === g ? 60 * ((b - r) / span) + 120 : 60 * ((r - g) / span) + 240;
  return hue >= 250 && hue <= 320;
}

/** Kulisy, jaké knihovna kreslí: kámen, dřevo, tráva, cihla, voda, písek, sníh, břidlice. */
const SCENERY = ['#808080', '#8b5a2b', '#4caf50', '#b5452f', '#1e88e5', '#e0c068', '#f2f2f2', '#37474f'].map(linear);

describe('clay shading and the scene palette in one shader patch (P56B T6, P75 T2)', () => {
  it('finds every anchor it replaces exactly once in three', () => {
    expect(count(ShaderChunk.lights_physical_pars_fragment, DIFFUSE)).toBe(1);
    for (const anchor of [LIGHTS, COLOR, COMMON, EMISSIVE, PHYSICAL]) expect(count(ShaderLib.standard.fragmentShader, anchor), anchor).toBe(1);
  });

  // P75 T2: modelína místo tří stupňů. Odlesk dál z nezabaleného úhlu, jinak by se leskla odvrácená strana.
  it('wraps the diffuse light, keeps the specular on the true angle and clamps roughness to plastic', () => {
    const shader = compiled({ onBeforeCompile: (s: never) => toonPatch(s, true) });
    expect(shader.fragmentShader).toContain('directDiffuse += clayWrap( dot( geometryNormal, directLight.direction ) )');
    expect(shader.fragmentShader).not.toContain(DIFFUSE);
    expect(shader.fragmentShader).toContain('float dotNL = saturate( dot( geometryNormal, directLight.direction ) );');
    expect(shader.fragmentShader).toMatch(/directSpecular \+= irradiance \* BRDF_GGX/);
    expect(shader.fragmentShader).toMatch(new RegExp(`roughnessFactor = clamp\\( roughnessFactor, ${CLAY_ROUGHNESS[0]}, ${CLAY_ROUGHNESS[1]} \\);\\s*#include <lights_physical_fragment>`));
    expect(CLAY_ROUGHNESS[0]).toBeGreaterThan(0.3);
    expect(CLAY_ROUGHNESS[1]).toBeLessThan(0.9);
  });

  it('switches the palette and the scenery rim on and off together', () => {
    const shader = compiled({ onBeforeCompile: (s: never) => toonPatch(s, true) });
    expect(shader.fragmentShader).not.toContain(LIGHTS);
    expect(shader.fragmentShader).toMatch(/#include <color_fragment>\s*diffuseColor\.rgb = toonPaletteMix/);
    expect(shader.fragmentShader).toMatch(/#include <emissivemap_fragment>\s*totalEmissiveRadiance \+= diffuseColor\.rgb \* toonRim/);
    expect(shader.uniforms.toonPalette).toBe(toon.palette);
    expect(shader.uniforms.toonRim).toBe(toon.rim);
    const once = shader.fragmentShader;
    toonPatch(shader as never, true);
    expect(shader.fragmentShader).toBe(once);
    toonPatch(shader as never, false);
    expect(shader.fragmentShader).not.toContain('toonPaletteMix( diffuseColor');
    expect(shader.fragmentShader).not.toContain('toonRim *');
    expect(count(shader.fragmentShader, 'uniform float toonMix;')).toBe(1);
  });

  // Slepý soud T13 dvakrát: okraj barvou oblohy či bílé zešedil koruny a kmeny ve dne (T13-R2) a výplň hřbitova
  // v noci (T13-R1). Okraj modelíny je jen násobek barvy povrchu (zjasní, šedou nepřimíchá) a v noci zhasne.
  it('lights scenery edges only in their own colour, and not at night', () => {
    const plain = ShaderLib.standard.fragmentShader;
    const shader = compiled({ onBeforeCompile: (s: never) => toonPatch(s, true) });
    expect(count(shader.fragmentShader, 'totalEmissiveRadiance')).toBe(count(plain, 'totalEmissiveRadiance') + 1);
    const rim = shader.fragmentShader.split('\n').find((line) => line.includes('toonRim *'))!;
    expect(rim).toMatch(/^\s*totalEmissiveRadiance \+= diffuseColor\.rgb \* toonRim \* pow\(/);
    expect(rim).not.toMatch(/vec3\(\s*1\.0\s*\)|rimColor|mix\(/);
    const day = LOOK_IDS.map((id) => LOOKS[id]).find((look) => darkness(look) === 0)!;
    const night = LOOK_IDS.map((id) => LOOKS[id]).find((look) => darkness(look) === 1)!;
    setScenePalette(day);
    expect(toon.rim.value.r).toBeCloseTo(new Color(colorHex['sun-soft']).r * CLAY_RIM, 5);
    expect(toon.rim.value.r).toBeGreaterThanOrEqual(toon.rim.value.b);
    setScenePalette(night);
    expect(toon.rim.value.toArray()).toEqual([0, 0, 0]);
    // P81 T5: bouřka za dne (s9) okraj nemá – emisivní okraj v tmavém dešti přebil osvětlení kulis.
    setScenePalette({ ...day, storm: true });
    expect(toon.rim.value.toArray()).toEqual([0, 0, 0]);
  });

  it('pulls scenery towards the set palette at the same brightness, never purple, and leaves characters alone', () => {
    for (const id of LOOK_IDS) {
      const palette = scenePaletteOf(LOOKS[id]).map(linear);
      expect(palette).toHaveLength(6);
      for (const color of SCENERY) {
        const mixed = paletteMix(color, palette, PALETTE_MIX, 'scenery');
        expect(Math.abs(oklab(mixed)[0] - oklab(color)[0]), `${id} ${color.join(',')}: lightness`).toBeLessThan(0.01);
        if (nearestGap(color, palette) > 0.02) expect(nearestGap(mixed, palette), `${id} ${color.join(',')}`).toBeLessThan(nearestGap(color, palette));
        expect(purple(mixed), `${id} ${color.join(',')} -> ${mixed.join(',')}`).toBe(false);
        expect(paletteMix(color, palette, PALETTE_MIX, 'character')).toEqual(color);
      }
    }
  });

  it('fills the shared uniforms from the set, the palette in Oklab of the linear colour', () => {
    const look = LOOKS[LOOK_IDS[0]];
    setScenePalette(look);
    expect(toon.mix.value).toBe(PALETTE_MIX);
    toon.palette.value[0]!.toArray().forEach((value, i) => expect(value).toBeCloseTo(oklab(linear(look.ground))[i]!, 5));
  });

  it('puts toon into the body, plant, clone, glow and rim programs, the palette only into scenery', () => {
    const body = (mergeBody(new Mesh(new BoxGeometry(), new MeshStandardMaterial())) as Mesh).material as MeshStandardMaterial;
    for (const material of [body, plantMaterial(false), plantMaterial(true), patchedClone(body)]) {
      expect(material.customProgramCacheKey()).toContain('toon');
      expect(compiled(material).fragmentShader).toContain('toonPaletteMix( diffuseColor');
    }
    for (const material of [rimMaterial(body), glowingCopy(body, 1), glowingCopy(new MeshStandardMaterial(), 1)]) {
      const { fragmentShader } = compiled(material);
      expect(fragmentShader).toContain('directDiffuse += clayWrap(');
      expect(fragmentShader).not.toContain('toonRim *');
      expect(fragmentShader).not.toContain('toonPaletteMix( diffuseColor');
    }
  });

  it('gives an unmerged textured model a toon copy once, keeping the source material', () => {
    const source = new MeshStandardMaterial();
    const root = new Group().add(new Mesh(new BoxGeometry(), source), new Mesh(new BoxGeometry(), source));
    toonLit(root);
    const [a, b] = root.children.map((child) => (child as Mesh).material as MeshStandardMaterial);
    expect(a).toBe(b);
    expect(a).not.toBe(source);
    expect(a!.customProgramCacheKey()).toContain('toon');
    expect(compiled(a!).fragmentShader).toContain('toonPaletteMix( diffuseColor');
    expect(toonLit(root).children.map((child) => (child as Mesh).material)).toEqual([a, a]);
  });
});
