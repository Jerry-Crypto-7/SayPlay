/**
 * Údolí běžce (P32A T3). Uvnitř hrací plochy musí nakreslený terén sedět přesně na
 * zemi jádra (`playableGround`), jinak hráč pluje nebo se boří – terén posunutý
 * o 20 cm vypadá dobře a přesto je špatně. Měří se síť, kterou scéna kreslí
 * (paprsek shora), ne funkce, ze které vznikla.
 */

import { uniformFloat64 } from 'pure-rand/distribution/uniformFloat64';
import { xoroshiro128plus } from 'pure-rand/generator/xoroshiro128plus';
import { Color, DoubleSide, Mesh, MeshBasicMaterial, Raycaster, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';

import { LOOK_IDS, LOOKS } from '@/play/arcade/look';
import { RUNNER } from '@/play/arcade/pieces/runner';
import { UNIT } from '@/play/arcade/contract';

import { playableGround } from '../look/rig/terrain';
import { PLAYABLE_HALF, buildValley, valleyPalette } from '../look/rig/terrain/valley';

const LENGTH = 220;
const valley = buildValley({ look: LOOKS.snow, from: -20, to: LENGTH + 80 });
const mesh = new Mesh(valley.geometry, new MeshBasicMaterial({ side: DoubleSide }));
mesh.updateMatrixWorld(true);
const ray = new Raycaster();
const down = new Vector3(0, -1, 0);

/** Výška nakreslené sítě pod bodem scény (m). */
function drawnAt(x: number, z: number): number {
  ray.set(new Vector3(x, 500, z), down);
  const hit = ray.intersectObject(mesh, false)[0];
  if (hit === undefined) throw new Error(`no terrain under ${x}, ${z}`);
  return hit.point.y;
}

const rng = xoroshiro128plus(3207);
const between = (from: number, to: number): number => from + uniformFloat64(rng) * (to - from);

describe('runner valley', () => {
  it('covers the whole track and its edges', () => {
    // Pruhy jádra a půl šířky nejširšího těla, s rezervou na zubatý kraj dráhy.
    expect(PLAYABLE_HALF).toBeGreaterThanOrEqual((RUNNER.lanes * RUNNER.laneWidth) / UNIT / 2 + 0.5);
  });

  it('sits on the kernel ground within 1 cm at 200 random points of the playable area', () => {
    for (let i = 0; i < 200; i += 1) {
      const x = between(-PLAYABLE_HALF, PLAYABLE_HALF);
      const z = between(0, LENGTH);
      // Scéna zrcadlí x jádra (`World.tsx`): bod scény x je v jádře −x.
      expect(Math.abs(drawnAt(x, z) - playableGround('runner', -x, z)), `x ${x.toFixed(2)} z ${z.toFixed(2)}`).toBeLessThan(0.01);
    }
  });

  it('rises into slopes and mountains outside the playable area', () => {
    const banks = Array.from({ length: 40 }, () => drawnAt(between(PLAYABLE_HALF + 3, PLAYABLE_HALF + 6) * (uniformFloat64(rng) < 0.5 ? -1 : 1), between(0, LENGTH)));
    const peaks = Array.from({ length: 40 }, () => drawnAt(between(35, 45) * (uniformFloat64(rng) < 0.5 ? -1 : 1), between(0, LENGTH)));
    expect(Math.min(...banks)).toBeGreaterThan(0.1);
    expect(Math.min(...peaks)).toBeGreaterThan(8);
  });

  it('gives scenery the height the mesh draws, so props neither float nor sink', () => {
    for (let i = 0; i < 100; i += 1) {
      const x = between(PLAYABLE_HALF, 30) * (uniformFloat64(rng) < 0.5 ? -1 : 1);
      const z = between(-10, LENGTH + 40);
      expect(Math.abs(valley.heightAt(x, z) - drawnAt(x, z)), `x ${x.toFixed(2)} z ${z.toFixed(2)}`).toBeLessThan(0.01);
    }
  });

  it('draws with flat-shaded faces and palette vertex colours', () => {
    const { geometry } = valley;
    expect(geometry.index).toBeNull();
    const normal = geometry.getAttribute('normal');
    // Flat shading: všechny tři vrcholy trojúhelníku mají tutéž normálu.
    for (let face = 0; face < normal.count; face += 997 * 3) {
      expect(normal.getY(face)).toBeCloseTo(normal.getY(face + 1), 6);
      expect(normal.getY(face)).toBeCloseTo(normal.getY(face + 2), 6);
    }
    expect(geometry.getAttribute('color').count).toBe(geometry.getAttribute('position').count);
  });

  it('takes an icy lane for snow, sand for the desert and a road for the city', () => {
    expect(valleyPalette(LOOKS.snow).lane).not.toBe(valleyPalette(LOOKS.snow).surface);
    expect(valleyPalette(LOOKS.desert).surface).toBe(LOOKS.desert.ground);
    expect(valleyPalette(LOOKS.city).lane).not.toBe(valleyPalette(LOOKS.desert).lane);
    // Sada bez vlastní palety si ji odvodí ze země a dráhy.
    expect(valleyPalette(LOOKS.meadow)).toMatchObject({ surface: LOOKS.meadow.ground, lane: LOOKS.meadow.track });
  });

  it.each(LOOK_IDS)('%s derives no purple terrain colour', (id) => {
    for (const hex of Object.values(valleyPalette(LOOKS[id]))) {
      const { h, s } = new Color(hex).getHSL({ h: 0, s: 0, l: 0 });
      if (s > 0.05) expect(h * 360 < 250 || h * 360 > 320, `${id} ${hex}`).toBe(true);
    }
  });
});
