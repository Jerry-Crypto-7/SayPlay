/**
 * P61 T7: obchod pod střechou. Slepý soudce na dev větách četl „zombie shooter in a mall“ jako „hazy open outdoor
 * area with a city skyline … not the inside of a mall“ a supermarket jako „snowy outdoor slope“: hala měla otevřenou
 * oblohu, za mlhou panorama města a běžec svahy údolí. Test čte, co scéna z dev věty opravdu nakreslí – sadu
 * z návrhu (`sceneLook`, jak ji bere `ArcadePlay`), uniformy oblohy (`paintSky`), vrstvy kulisy (`backdropLayers`)
 * a výšky údolí běžce (`buildValley`).
 */

import { beforeAll, describe, expect, it } from 'vitest';

import { LOOK_IDS, LOOKS, sceneLook } from '@/play/arcade/look';
import { loadRapier } from '@/play/arcade/physics/world';
import { draftGameSpecWithMeta } from '@/play/draft/draft';

import { backdropLayers } from '../backdrop-shapes';
import { airOf } from '../rig/fog-light';
import { paintSky, skyMaterial } from '../rig/StyleRig';
import { buildValley } from '../rig/terrain/valley';

const HALLS = ['mall', 'supermarket'] as const;
const DEV = [
  { id: 's039', sentence: 'zombie shooter in a mall', look: 'mall' },
  { id: 's003', sentence: 'A hamster escaping a supermarket while a giant Roomba hunts me', look: 'supermarket' },
] as const;

const OPTIONS = { seed: 11, clear: 8 } as const;

/** Kolik úhlu obrysu (podíl obvodu) leží výš než `share` × poloměr. */
const coverAbove = (profile: readonly (readonly [number, number])[], radius: number, share: number): number => {
  let covered = 0;
  for (let i = 1; i < profile.length; i += 1) if (profile[i]![1] >= share * radius && profile[i - 1]![1] >= share * radius) covered += profile[i]![0] - profile[i - 1]![0];
  return covered / (2 * Math.PI);
};

describe('hala pod střechou (P61 T7)', () => {
  beforeAll(async () => {
    await loadRapier();
  });

  it.each(DEV)('$id „$sentence“: scéna kreslí strop se světly a stěny haly, ne oblohu s panoramatem města', ({ sentence, look }) => {
    const { spec } = draftGameSpecWithMeta(sentence, 1);
    const scene = sceneLook(spec.theme);
    expect(scene.ceiling, 'ceiling').toEqual(LOOKS[look].ceiling);

    const material = skyMaterial();
    paintSky(material, scene, spec.control ?? '');
    expect(material.uniforms.indoor!.value).toBe(1);
    expect(material.fragmentShader).toContain('indoor > 0.5');
    // Strop mizí do mlhy, jak ji rig kreslí (P70D T2: začátek mlhy odsunutý na dálku).
    expect(material.uniforms.haze!.value.toArray()).toEqual([airOf(scene).near, airOf(scene).far]);

    const layers = backdropLayers(scene, OPTIONS.seed, OPTIONS.clear);
    expect(layers.map((layer) => layer.kind)).toEqual(['walls', 'walls']);
    // Stěna drží výšku dokola: žádné mezery mezi domy a ani průsek nad cestou – jeho náběh kreslil svahy kopců.
    for (const layer of layers) expect(coverAbove(layer.profile, layer.radius, 0.17)).toBeCloseTo(1, 5);
  });

  it('běžec v hale běží po rovné podlaze až ke stěnám, venku dál údolím mezi svahy', () => {
    const highest = (look: (typeof LOOKS)[keyof typeof LOOKS]) => Math.max(...buildValley({ look, from: -20, to: 200 }).heights);
    for (const hall of HALLS) expect(highest(LOOKS[hall]), hall).toBe(0);
    expect(highest(LOOKS.snow)).toBeGreaterThan(5);
    expect(highest(LOOKS.city)).toBeGreaterThan(5);
  });

  it('strop a stěny mají jen haly – venkovní sady i město zůstávají pod oblohou', () => {
    for (const id of LOOK_IDS) {
      const material = skyMaterial();
      paintSky(material, LOOKS[id], 'runner');
      const hall = (HALLS as readonly string[]).includes(id);
      expect(material.uniforms.indoor!.value, id).toBe(hall ? 1 : 0);
      expect(LOOKS[id].skyline?.layers.includes('walls') ?? false, id).toBe(hall);
    }
  });

  it('noc a nálada strop nechají: hala v noci je pořád pod střechou', () => {
    for (const setting of ['a mall at night', 'a supermarket at night', 'a foggy mall']) {
      const material = skyMaterial();
      paintSky(material, sceneLook({ setting, mood: '' }), 'shooter');
      expect(material.uniforms.indoor!.value, setting).toBe(1);
    }
  });
});
