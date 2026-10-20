/**
 * Vítr ve vegetaci (P54B T13). Pinuje se, co by na snímku vypadalo stejně a přesto bylo špatně:
 * vítr zapnutý na telefonní úrovni `low` nebo při omezeném pohybu (stojí výkon nebo klid), vítr
 * v obýváku a obchodě (pokojová rostlina se nekývá), bouřka stejně klidná jako jasno, a stínová
 * kopie rostliny bez větru (koruna by se kývala ve vlastním nehybném stínu).
 */

import { MeshDepthMaterial, ShaderLib } from 'three';
import { afterEach, describe, expect, it } from 'vitest';

import { LOOK_IDS, LOOKS, sceneLook } from '@/play/arcade/look';

import { blowPlantWind, plantDepthMaterial, plantMaterial, plantWind, plantWindFor, setPlantWind } from '../load';
import { QUALITY_TIERS } from '../rig/quality';

const shaderOf = (source: { vertexShader: string; fragmentShader: string }) => ({ vertexShader: source.vertexShader, fragmentShader: source.fragmentShader, uniforms: {} as Record<string, unknown> });

/** Shader rostliny, jak by ho three přeložil při současném stavu větru. */
function compiled(material: { onBeforeCompile(shader: never, renderer: never): void }, source = ShaderLib.standard) {
  const shader = shaderOf(source);
  material.onBeforeCompile(shader as never, undefined as never);
  return shader;
}

const INDOOR = ['mall', 'supermarket', 'living_room', 'factory', 'cave', 'space'] as const;

afterEach(() => setPlantWind(false));

describe('wind in the vegetation (P54B T13)', () => {
  it('blows only on the high and medium tiers, and not under reduced motion', () => {
    const meadow = LOOKS.meadow;
    for (const tier of QUALITY_TIERS) {
      const strength = plantWindFor(meadow, 'meadow', tier, true);
      setPlantWind(strength > 0);
      const shader = compiled(plantMaterial(false));
      if (tier === 'low') {
        expect(strength).toBe(0);
        expect(shader.vertexShader).not.toContain('plantWindTime');
        expect(shader.uniforms.plantWindTime).toBeUndefined();
      } else {
        expect(strength).toBeGreaterThan(0);
        expect(shader.vertexShader).toContain('uniform float plantWindTime;');
        expect(shader.vertexShader).toContain('uniform float plantWindStrength;');
        expect(shader.uniforms.plantWindTime).toBeDefined();
      }
      expect(plantWindFor(meadow, 'meadow', tier, false)).toBe(0);
    }
  });

  it('moves the crown and keeps the root: the sway grows with the vertex height', () => {
    setPlantWind(true);
    const { vertexShader } = compiled(plantMaterial(true));
    // Výchylka až po `begin_vertex` (poloha rostliny výšky 1) a úměrná čtverci výšky vrcholu.
    expect(vertexShader).toMatch(/#include <begin_vertex>[\s\S]*transformed \+= [^;]*transformed\.y \* transformed\.y\);/);
    // Fáze z polohy instance ve světě, ne z indexu: každá rostlina jinak, tatáž rostlina pořád stejně.
    expect(vertexShader).toContain('modelMatrix * instanceMatrix');
  });

  it('switches the program when the wind turns on or off', () => {
    const material = plantMaterial(false);
    const calm = material.customProgramCacheKey();
    const before = material.version;
    setPlantWind(true);
    expect(material.customProgramCacheKey()).not.toBe(calm);
    expect(material.version).toBeGreaterThan(before);
  });

  it('silences the wind on a drop to low without recompiling the plants', () => {
    const material = plantMaterial(false);
    blowPlantWind(0);
    expect(compiled(material).vertexShader).not.toContain('plantWindTime');
    blowPlantWind(0.04);
    const on = material.version;
    expect(plantWind.strength.value).toBe(0.04);
    blowPlantWind(0);
    expect(plantWind.strength.value).toBe(0);
    expect(material.version).toBe(on);
    expect(compiled(material).vertexShader).toContain('uniform float plantWindStrength;');
  });

  it('sways the shadow copy with the plant', () => {
    const depth = plantDepthMaterial();
    expect(depth).toBeInstanceOf(MeshDepthMaterial);
    expect(compiled(depth, ShaderLib.depth).vertexShader).not.toContain('plantWindTime');
    setPlantWind(true);
    expect(compiled(depth, ShaderLib.depth).vertexShader).toContain('uniform float plantWindTime;');
  });

  it('keeps indoor and airless sets still and blows harder in a storm', () => {
    for (const id of INDOOR) expect(plantWindFor(LOOKS[id], id, 'high', true)).toBe(0);
    for (const id of LOOK_IDS.filter((entry) => !(INDOOR as readonly string[]).includes(entry))) expect(plantWindFor(LOOKS[id], id, 'high', true)).toBeGreaterThan(0);
    const calm = plantWindFor(sceneLook({ setting: 'meadow', mood: 'calm' }), 'meadow', 'high', true);
    const storm = plantWindFor(sceneLook({ setting: 'meadow', mood: 'calm', weather: 'rain' }), 'meadow', 'high', true);
    const stormyNight = plantWindFor(sceneLook({ setting: 'meadow', mood: 'storm', timeOfDay: 'night' }), 'meadow', 'high', true);
    expect(storm).toBeGreaterThan(calm * 1.5);
    expect(stormyNight).toBe(storm);
  });
});
