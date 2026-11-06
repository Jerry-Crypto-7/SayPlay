/**
 * Řada kulis stojí za `inner` (P62 T1-R1). Posun řady `(index * 37 + side * 11) % 5` vyšel pro první levý kus
 * v JS záporný (−1), kus pak stál 1,3 m uvnitř `inner` – u rytmu v ploše pruhů na x = −2,7 m (audit T1). Měří se
 * místa, která scéna rytmu kreslí (`RhythmScene`: `inner = pruhy / 2 + 2`, `from = 2`, `to = 60`), a že se ostatní
 * kusy nepohnuly.
 */

import { describe, expect, it } from 'vitest';

import { UNIT } from '@/play/arcade/contract';
import { LOOK_IDS, LOOKS } from '@/play/arcade/look';
import { RHYTHM } from '@/play/arcade/pieces/rhythm';

import { sceneryPlaces } from '../Scenery';

const LANES_HALF = (RHYTHM.lanes * RHYTHM.laneW) / UNIT / 2;
const RHYTHM_INNER = LANES_HALF + 2;

describe('sceneryPlaces keeps every piece outside inner', () => {
  it('no rhythm piece stands in the lanes area, on any look', () => {
    for (const id of LOOK_IDS) {
      const places = sceneryPlaces(LOOKS[id].props, 'sides', RHYTHM_INNER, 2, 60);
      for (const place of places) expect(Math.abs(place.x), `${id} ${place.kind} z=${place.z}`).toBeGreaterThan(LANES_HALF + 1);
    }
  });

  it('every piece of both sides and the sparse row sits at |x| >= inner', () => {
    const props = LOOKS.city.props;
    for (const inner of [3, RHYTHM_INNER, 9, 14]) {
      for (const sparse of [false, true]) {
        for (const place of sceneryPlaces(props, 'sides', inner, -40, 120, undefined, sparse)) {
          expect(Math.abs(place.x)).toBeGreaterThanOrEqual(inner);
          expect(Math.abs(place.x)).toBeLessThanOrEqual(inner + 4 * 1.3 + 1e-9);
        }
      }
    }
  });

  it('only the first left piece moved – the rest keep their old slots', () => {
    const inner = RHYTHM_INNER;
    const places = sceneryPlaces(LOOKS.city.props, 'sides', inner, 2, 60);
    places.forEach((place, i) => {
      const index = Math.floor(i / 2);
      const side = i % 2 === 0 ? -1 : 1;
      if (index === 0 && side === -1) {
        expect(place.x).toBeCloseTo(-(inner + 4 * 1.3));
        return;
      }
      // Stará formule bez opravy – pro všechny ostatní kusy je zbytek kladný a místo stejné jako na `main`.
      expect(place.x).toBeCloseTo(side * (inner + ((index * 37 + side * 11) % 5) * 1.3));
    });
  });

  it('clear leaves the row empty around z = 0 and keeps every other piece where it was (stacking, P73D)', () => {
    for (const id of LOOK_IDS) {
      const all = sceneryPlaces(LOOKS[id].props, 'behind', 10, -26, 26);
      const cleared = sceneryPlaces(LOOKS[id].props, 'behind', 10, -26, 26, undefined, false, 9);
      expect(cleared, id).toEqual(all.filter((place) => Math.abs(place.z) >= 9));
      if (all.length === 0) continue;
      expect(cleared.some((place) => place.z < 0) && cleared.some((place) => place.z > 0), id).toBe(true);
    }
  });
});
