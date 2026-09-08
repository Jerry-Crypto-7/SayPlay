/**
 * Goniometrie volného režimu kamery.
 *
 * Dá se ověřit bez plátna i bez GPU, a je to ta část, kterou oko neuhlídá:
 * prohozená osa, obrácené znaménko nebo náklon, který propadne pod podlahu,
 * vypadají na snímku jako záměr. Poznají se až tím, že se pojmenuje, co má
 * tažení udělat.
 *
 * `orbitFrom` a `orbitTo` jsou navzájem protějšky, takže složením musí vzniknout
 * identita — bez toho by přepnutí do volného režimu kameru cuklo dřív, než se
 * jí kdo dotkne.
 */

import { describe, expect, it } from 'vitest';

import {
  FOLLOW_OFFSET,
  MAX_POLAR,
  MIN_POLAR,
  ORBIT_PER_PIXEL,
  dragOrbit,
  orbitFrom,
  orbitTo,
} from '../FollowCamera';
import type { Vec3 } from '../projection';

const CENTER: Vec3 = { x: -2, y: 0.45, z: 3 };
const SEAT: Vec3 = {
  x: CENTER.x + FOLLOW_OFFSET.x,
  y: CENTER.y + FOLLOW_OFFSET.y,
  z: CENTER.z + FOLLOW_OFFSET.z,
};

describe('přepnutí do volného režimu kameru necukne', () => {
  it('popis dráhy a zpátky dá tutéž pozici', () => {
    const back = orbitTo(orbitFrom(SEAT, CENTER), CENTER);

    expect(back.x).toBeCloseTo(SEAT.x, 10);
    expect(back.y).toBeCloseTo(SEAT.y, 10);
    expect(back.z).toBeCloseTo(SEAT.z, 10);
  });

  it('vzdálenost od středu je ta, na které kamera stála', () => {
    expect(orbitFrom(SEAT, CENTER).radius).toBeCloseTo(
      Math.hypot(FOLLOW_OFFSET.x, FOLLOW_OFFSET.y, FOLLOW_OFFSET.z),
      10,
    );
  });

  it('sledovací odstup míří nad podlahu, ne do ní', () => {
    const { polar } = orbitFrom(SEAT, CENTER);

    expect(polar).toBeGreaterThan(MIN_POLAR);
    expect(polar).toBeLessThan(MAX_POLAR);
  });
});

describe('tažení myší', () => {
  const start = orbitFrom(SEAT, CENTER);

  it('vodorovný tah obíhá a nemění vzdálenost ani náklon', () => {
    const dragged = dragOrbit(start, 120, 0);

    expect(dragged.azimuth).toBeCloseTo(start.azimuth - 120 * ORBIT_PER_PIXEL, 10);
    expect(dragged.polar).toBeCloseTo(start.polar, 10);
    expect(dragged.radius).toBeCloseTo(start.radius, 10);
  });

  it('svislý tah naklání a nemění obíhání', () => {
    const dragged = dragOrbit(start, 0, 40);

    expect(dragged.polar).toBeCloseTo(start.polar - 40 * ORBIT_PER_PIXEL, 10);
    expect(dragged.azimuth).toBeCloseTo(start.azimuth, 10);
  });

  it('opačné tahy se vyruší — jinak by se scéna po vrácení myši nevrátila', () => {
    const there = dragOrbit(start, 90, 30);
    const back = dragOrbit(there, -90, -30);

    expect(back.azimuth).toBeCloseTo(start.azimuth, 10);
    expect(back.polar).toBeCloseTo(start.polar, 10);
  });

  it('vodorovný tah kamerou opravdu pohne, ne jen změní čísla', () => {
    const before = orbitTo(start, CENTER);
    const after = orbitTo(dragOrbit(start, 120, 0), CENTER);

    expect(Math.hypot(after.x - before.x, after.z - before.z)).toBeGreaterThan(0.5);
  });

  it('náklon dolů nepropadne pod podlahu ani při vzteklém tahu', () => {
    const dragged = dragOrbit(start, 0, -10_000);

    expect(dragged.polar).toBe(MAX_POLAR);
    expect(orbitTo(dragged, CENTER).y).toBeGreaterThan(CENTER.y);
  });

  it('náklon nahoru se zastaví před pohledem přesně shora', () => {
    const dragged = dragOrbit(start, 0, 10_000);

    expect(dragged.polar).toBe(MIN_POLAR);
    // Nad středem, ale ne přesně nad ním: odsud je ještě poznat, kam se kouká.
    expect(orbitTo(dragged, CENTER).y).toBeGreaterThan(CENTER.y);
    expect(Math.hypot(orbitTo(dragged, CENTER).x - CENTER.x, orbitTo(dragged, CENTER).z - CENTER.z)).toBeGreaterThan(
      0,
    );
  });

  it('obíhání drží vzdálenost po celém kruhu', () => {
    for (let pixels = 0; pixels <= 1200; pixels += 100) {
      const seat = orbitTo(dragOrbit(start, pixels, 0), CENTER);
      const distance = Math.hypot(seat.x - CENTER.x, seat.y - CENTER.y, seat.z - CENTER.z);

      expect(distance).toBeCloseTo(start.radius, 8);
    }
  });
});
