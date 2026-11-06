/**
 * P73D T3 – svět má okraj: podstavec diorama kolem země a smetí jen u hrany a věcí.
 *
 * Oko na snímku pozná, že hrana je, ne že vede všude kolem a nevyjde fialově; a že
 * smetí ubylo na 30 %, ze snímku nespočítá. Tohle pinuje obojí.
 */

import { Color, SRGBColorSpace } from 'three';
import { describe, expect, it } from 'vitest';

import { UNIT } from '@/play/arcade/contract';
import { LOOK_IDS, LOOKS } from '@/play/arcade/look';
import { ARENA } from '@/play/arcade/pieces/arena';

import { isPurple } from '../../../../../../scripts/assets/cc0/palette.mjs';
import { buildPodium, PODIUM_DEPTH_M, PODIUM_RIM_M } from '../ground';
import { arenaDecorPlaces, DENSITY, NEAR_EDGE_M, NEAR_THING_M } from '../rig/terrain/arenaDecor';
import { buildArenaFloor } from '../rig/terrain/arenaFloor';

const AREA = { x0: -20, x1: 24, z0: -18, z1: 30 };
const half = ARENA.half / UNIT;
const keep = [
  { x: 0, z: 0, r: 1.2 },
  { x: 4, z: 3, r: 0.8 },
  { x: -5, z: -2, r: 0.8 },
];

describe('P73D T3: podstavec diorama', () => {
  it('runs all the way round the area, rounds down from the ground and cuts to the full depth', () => {
    for (const id of LOOK_IDS) {
      const position = buildPodium(LOOKS[id], AREA).getAttribute('position');
      let [top, bottom, reach] = [-Infinity, Infinity, 0];
      const sides = { x0: 0, x1: 0, z0: 0, z1: 0 };
      for (let i = 0; i < position.count; i += 1) {
        const [x, y, z] = [position.getX(i), position.getY(i), position.getZ(i)];
        [top, bottom] = [Math.max(top, y), Math.min(bottom, y)];
        // Ven od plochy, nikdy do ní: hrana nepřekryje hrací zem.
        const out = Math.hypot(Math.max(AREA.x0 - x, 0, x - AREA.x1), Math.max(AREA.z0 - z, 0, z - AREA.z1));
        const inside = x > AREA.x0 + 1e-4 && x < AREA.x1 - 1e-4 && z > AREA.z0 + 1e-4 && z < AREA.z1 - 1e-4;
        expect(inside, `${id}: vertex inside the area`).toBe(false);
        reach = Math.max(reach, out);
        if (y < -PODIUM_RIM_M) {
          if (x < AREA.x0) sides.x0 += 1;
          if (x > AREA.x1) sides.x1 += 1;
          if (z < AREA.z0) sides.z0 += 1;
          if (z > AREA.z1) sides.z1 += 1;
        }
      }
      expect(top, `${id}: rim starts at ground level`).toBeCloseTo(0, 5);
      expect(bottom, `${id}: side cut depth`).toBeCloseTo(-PODIUM_DEPTH_M, 5);
      expect(reach, `${id}: rim reach`).toBeCloseTo(PODIUM_RIM_M, 4);
      for (const [side, count] of Object.entries(sides)) expect(count, `${id}: side cut on ${side}`).toBeGreaterThan(0);
    }
  });

  it('is the same every time and paints the cut in the colours of the place, never purple', () => {
    const paint = new Color();
    const rgb = { r: 0, g: 0, b: 0 };
    for (const id of LOOK_IDS) {
      const geometry = buildPodium(LOOKS[id], AREA);
      expect(Array.from(buildPodium(LOOKS[id], AREA).getAttribute('color').array), id).toEqual(Array.from(geometry.getAttribute('color').array));
      const colors = geometry.getAttribute('color');
      for (let i = 0; i < colors.count; i += 1) {
        paint.setRGB(colors.getX(i), colors.getY(i), colors.getZ(i)).getRGB(rgb, SRGBColorSpace);
        expect(isPurple([rgb.r, rgb.g, rgb.b]), `${id}: purple podium vertex #${paint.getHexString(SRGBColorSpace)}`).toBe(false);
      }
    }
  });

  it('frames the arena land too', () => {
    const podium = buildArenaFloor({ look: LOOKS.forest, half }).podium.getAttribute('position');
    let bottom = 0;
    for (let i = 0; i < podium.count; i += 1) bottom = Math.min(bottom, podium.getY(i));
    expect(podium.count).toBeGreaterThan(0);
    expect(bottom).toBeCloseTo(-PODIUM_DEPTH_M, 5);
  });
});

describe('P73D T3: smetí na 30 % a jen u hrany a věcí', () => {
  it('keeps at most 30 % of the P36C density, from the seed', () => {
    expect(DENSITY).toBeCloseTo(0.3 * 0.3, 6);
    for (const id of LOOK_IDS) {
      const places = arenaDecorPlaces({ look: LOOKS[id], half, seed: 7, keep });
      expect(places.length, id).toBeLessThanOrEqual(Math.round((2 * half) ** 2 * 0.3 * 0.3));
      expect(places.length, `${id}: still dressed`).toBeGreaterThan(10);
    }
    const a = arenaDecorPlaces({ look: LOOKS.forest, half, seed: 7, keep });
    expect(arenaDecorPlaces({ look: LOOKS.forest, half, seed: 7, keep })).toEqual(a);
    expect(arenaDecorPlaces({ look: LOOKS.forest, half, seed: 8, keep })).not.toEqual(a);
  });

  it('leaves the middle of the floor clean: every piece is by the edge or by a thing', () => {
    for (const id of LOOK_IDS) {
      for (const seed of [3, 11]) {
        for (const place of arenaDecorPlaces({ look: LOOKS[id], half, seed, keep })) {
          const byEdge = Math.max(Math.abs(place.x), Math.abs(place.z)) >= half - NEAR_EDGE_M;
          // Kraj místa věci + nejširší kus (louže 0,6 × 1,25) + pás u věci.
          const byThing = keep.some((spot) => Math.hypot(place.x - spot.x, place.z - spot.z) < spot.r + 0.75 + NEAR_THING_M);
          expect(byEdge || byThing, `${id} ${seed}: ${place.kind} at ${place.x.toFixed(1)}, ${place.z.toFixed(1)} in the open middle`).toBe(true);
        }
      }
    }
  });
});
