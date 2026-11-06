/**
 * P73D: chytání má místo řady korun nad pruhy (visela přes horní hranu obrazu, bez kmenů) sad na zemi. Pinuje, co
 * by na snímku mohlo vypadat skoro dobře a být špatně: strom za hranou podstavce (visí do prázdna), koruna nad
 * obzorem kamery chytání nebo u horní hrany, strom v pruzích nebo v uličce před nimi.
 */
import { PerspectiveCamera, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';

import { LOOK_IDS, LOOKS } from '@/play/arcade/look';

import { CATCH_LAND, CATCH_ORCHARD, CATCH_PITCH, placeCatchWide } from '../../genres/catch/CatchScene';
import { CANVAS_FOV, horizonNdc } from '../framing';
import { placeOrchard } from '../vegetation-places';

const DEG = 180 / Math.PI;
const { keep } = CATCH_ORCHARD;

describe('sad chytání (P73D)', () => {
  it('louka: jabloně v řadách po stranách pruhů i za nimi', () => {
    const plants = placeOrchard({ flora: LOOKS.meadow.flora!, seed: 7, ...CATCH_ORCHARD });
    expect(new Set(plants.map((plant) => plant.id))).toEqual(new Set(['gen3d-apple-tree']));
    expect(plants.filter((plant) => Math.abs(plant.x) < keep.x1 && plant.z > keep.z1).length).toBeGreaterThanOrEqual(6);
    expect(plants.filter((plant) => Math.abs(plant.x) > keep.x1 && plant.z < keep.z1).length).toBeGreaterThanOrEqual(8);
  });

  it('každá sada: strom stojí na podstavci mimo pruhy a uličku, koruna pod obzorem kamery chytání', () => {
    for (const aspect of [1440 / 900, 16 / 9, 1]) {
      const camera = new PerspectiveCamera(CANVAS_FOV, aspect, 0.1, 500);
      placeCatchWide(camera);
      camera.updateMatrixWorld();
      const horizon = horizonNdc(CATCH_PITCH * DEG, camera.fov);
      // Strop sadu aspoň 2 m pod okem kamery: i nejbližší koruna zůstane zřetelně pod obzorem.
      expect(CATCH_ORCHARD.top + 2).toBeLessThan(camera.position.y);
      for (const id of LOOK_IDS) {
        const flora = LOOKS[id].flora;
        if (flora === undefined) continue;
        for (const seed of [1, 4242]) {
          for (const plant of placeOrchard({ flora, seed, ...CATCH_ORCHARD })) {
            const label = `${id} ${plant.id} (${plant.x.toFixed(1)}, ${plant.z.toFixed(1)})`;
            expect(plant.x - plant.reach, label).toBeGreaterThan(CATCH_LAND.x0);
            expect(plant.x + plant.reach, label).toBeLessThan(CATCH_LAND.x1);
            expect(plant.z + plant.reach, label).toBeLessThan(CATCH_LAND.z1);
            const clear = plant.x + plant.reach <= keep.x0 || plant.x - plant.reach >= keep.x1 || plant.z - plant.reach >= keep.z1;
            expect(clear, `${label} in the lanes or the aisle`).toBe(true);
            // Model rostliny má výšku 1 a patu na zemi (`bakePlant`): vrchol koruny je `height`.
            const top = plant.height;
            expect(top, label).toBeLessThanOrEqual(CATCH_ORCHARD.top);
            expect(new Vector3(plant.x, top, plant.z).project(camera).y, `${label} crown under the horizon`).toBeLessThan(horizon);
          }
        }
      }
    }
  });
});
