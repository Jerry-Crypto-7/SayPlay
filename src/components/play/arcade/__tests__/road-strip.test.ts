/**
 * Cesta jako jeden souvislý pás (P46G T2). Silnice skládaná z obdélníků po
 * úsecích dělala v šikaně schod a okrajová čára se trhala. Měří se nakreslená
 * síť – řezy napříč pásem po 5 cm a řady jejích vrcholů –, ne křivka, ze které vznikla.
 */

import type { BufferGeometry } from 'three';
import { describe, expect, it } from 'vitest';

import { arcadeWorldOf } from '@/play/arcade/compile';
import { SURFACES } from '@/play/arcade/look';
import { draftGameSpecWithMeta } from '@/play/draft';

import { roadGeometry, type StripSegment } from '../look/road-strip';
import { roadShapeOf } from '../steer/road-shape';

/** Šikana o 3 m, zúžení na polovinu a krátký úsek kratší než přechod. */
const CHICANE: readonly StripSegment[] = [
  { near: 0, far: 30, center: 0, width: 10 },
  { near: 30, far: 50, center: 3, width: 10 },
  { near: 50, far: 80, center: 0, width: 5 },
  { near: 80, far: 84, center: -1.5, width: 5 },
  { near: 84, far: 120, center: 0, width: 8 },
];

function citySegments(): readonly StripSegment[] {
  const made = arcadeWorldOf(draftGameSpecWithMeta('A car races through the city', 1).spec, 3);
  if (!made.ok) throw new Error(made.issues.join('; '));
  return roadShapeOf(made.world).segments;
}

const CASES = [
  ['chicane and narrowing', CHICANE],
  ['city streets', citySegments()],
] as const;

type Interval = readonly [number, number];

type Corners = readonly (readonly [x: number, z: number])[];

/** Řez sítí: průsečíky jejích trojúhelníků s příčnou rovinou `z` jako úseky na ose x (trojúhelníky v přihrádkách po 1 m). */
function slicer(geometry: BufferGeometry): (z: number) => Interval[] {
  const position = geometry.getAttribute('position');
  const index = geometry.index;
  const count = index === null ? position.count : index.count;
  const vertex = (k: number): readonly [number, number] => {
    const i = index === null ? k : index.getX(k);
    return [position.getX(i), position.getZ(i)];
  };
  const bins = new Map<number, Corners[]>();
  for (let k = 0; k < count; k += 3) {
    const corners = [vertex(k), vertex(k + 1), vertex(k + 2)];
    const zs = corners.map(([, z]) => z);
    for (let bin = Math.floor(Math.min(...zs)); bin <= Math.floor(Math.max(...zs)); bin += 1) bins.set(bin, [...(bins.get(bin) ?? []), corners]);
  }
  return (z) => {
    const out: Interval[] = [];
    for (const corners of bins.get(Math.floor(z)) ?? []) {
      const xs: number[] = [];
      for (let e = 0; e < 3; e += 1) {
        const [[x0, z0], [x1, z1]] = [corners[e]!, corners[(e + 1) % 3]!];
        if (z0 === z1 || (z0 - z) * (z1 - z) > 0) continue;
        xs.push(x0 + ((z - z0) / (z1 - z0)) * (x1 - x0));
      }
      if (xs.length > 0) out.push([Math.min(...xs), Math.max(...xs)]);
    }
    return out;
  };
}

/** Sjednocení úseků do souvislých kusů. */
function union(intervals: readonly Interval[]): Interval[] {
  const sorted = [...intervals].sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  for (const [from, to] of sorted) {
    const last = out[out.length - 1];
    if (last !== undefined && from <= last[1] + 1e-6) last[1] = Math.max(last[1], to);
    else out.push([from, to]);
  }
  return out;
}

/** Řezy po 5 cm od začátku po konec cesty, mimo přesné hranice úseků. */
function cuts(segments: readonly StripSegment[]): number[] {
  const from = Math.min(...segments.map((segment) => segment.near));
  const to = Math.max(...segments.map((segment) => segment.far));
  return Array.from({ length: Math.floor((to - from) / 0.05) - 1 }, (_, i) => from + 0.0251 + i * 0.05);
}

describe.each(CASES)('road strip – %s', (_, segments) => {
  const road = roadGeometry(segments, SURFACES.asphalt)!;
  const surfaceAt = slicer(road.surface);
  const edgesAt = slicer(road.edges);

  it('never steps: centre and width move at most 0.3 m between neighbouring cuts and vertex rows', () => {
    let previous: { readonly center: number; readonly width: number } | null = null;
    for (const z of cuts(segments)) {
      const pieces = union(surfaceAt(z));
      expect(pieces, `surface at z ${z.toFixed(2)}`).toHaveLength(1);
      const [left, right] = pieces[0]!;
      const now = { center: (left + right) / 2, width: right - left };
      if (previous !== null) {
        expect(Math.abs(now.center - previous.center), `centre at z ${z.toFixed(2)}`).toBeLessThanOrEqual(0.3);
        expect(Math.abs(now.width - previous.width), `width at z ${z.toFixed(2)}`).toBeLessThanOrEqual(0.3);
      }
      previous = now;
    }
    // Řady vrcholů pásu: aspoň po 0,5 m a mezi sousedními řadami posun nejvýš 0,3 m.
    const position = road.surface.getAttribute('position');
    const rows = new Map<number, number[]>();
    for (let i = 0; i < position.count; i += 1) {
      const z = Math.round(position.getZ(i) * 1e4) / 1e4;
      rows.set(z, [...(rows.get(z) ?? []), position.getX(i)]);
    }
    const ordered = [...rows.entries()].sort((a, b) => a[0] - b[0]).map(([z, xs]) => ({ z, left: Math.min(...xs), right: Math.max(...xs) }));
    for (let i = 1; i < ordered.length; i += 1) {
      const [a, b] = [ordered[i - 1]!, ordered[i]!];
      expect(b.z - a.z, `row gap at z ${a.z}`).toBeLessThanOrEqual(0.5 + 1e-6);
      expect(Math.abs(b.left - a.left), `left at z ${b.z}`).toBeLessThanOrEqual(0.3);
      expect(Math.abs(b.right - a.right), `right at z ${b.z}`).toBeLessThanOrEqual(0.3);
    }
  });

  it('draws each edge line without a gap over 0.05 m', () => {
    const lines = cuts(segments).map((z) => {
      const [left, right] = union(surfaceAt(z))[0]!;
      const center = (left + right) / 2;
      const intervals = edgesAt(z);
      return [-1, 1].map((sign) => union(intervals.filter(([a, b]) => sign * ((a + b) / 2 - center) > 0)));
    });
    lines.forEach((sides, i) => {
      for (const [s, pieces] of sides.entries()) {
        expect(pieces, `side ${s} at cut ${i}`).toHaveLength(1);
        if (i === 0) continue;
        const [[a0, a1], [b0, b1]] = [lines[i - 1]![s]![0]!, pieces[0]!];
        // Mezera mezi čárou v sousedních řezech: 0, když se překrývají.
        expect(Math.max(0, b0 - a1, a0 - b1), `side ${s} at cut ${i}`).toBeLessThanOrEqual(0.05);
      }
    });
  });

  it('gives the same geometry for the same game', () => {
    const again = roadGeometry(segments, SURFACES.asphalt)!;
    for (const key of ['surface', 'edges', 'marks'] as const) {
      expect(Array.from(again[key]!.getAttribute('position').array)).toEqual(Array.from(road[key]!.getAttribute('position').array));
    }
  });
});
