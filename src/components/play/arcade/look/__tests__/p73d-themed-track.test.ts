/**
 * P73D T6: žádný zástupný tvar na trati. Překážky sady kreslí model kitu (ne náhradní kvádr),
 * turbo jsou šipky v půdorysu těla, mantinel má dvě barvy povrchu ve stejném objemu
 * jako dřív a písek s hlínou mají drobky uvnitř pásu.
 */
import { describe, expect, it } from 'vitest';
import { Box3, type BufferGeometry, Color, SRGBColorSpace } from 'three';

import { ROLE } from '@/play/arcade/contract';
import { LOOKS, SURFACES, type Surface, type SurfaceKind } from '@/play/arcade/look';
import kits from '@/play/arcade/look/obstacle-kits.json';

import { type Cast, modelIdOf } from '../../World';
import { HEMI_LIFT, SUN_LIFT } from '../rig/fog-light';
import { WALL_BAND, boostPadGeometry, fleckGeometry, roadGeometry } from '../road-strip';

const KINDS = ['hurdle', 'cone', 'crate', 'slide-bar'] as const;
const STRAIGHT = [{ near: 0, far: 30, center: 2, width: 10 }];
const boxOf = (geometry: BufferGeometry): Box3 => new Box3().setFromBufferAttribute(geometry.getAttribute('position') as never);

describe('obstacles draw the kit model of their set', () => {
  for (const [look, kit] of Object.entries(kits.kits)) {
    it(`${look}: every obstacle kind resolves to its kit model, not the bare kind`, () => {
      const cast: Cast = { player: 'p', enemy: 'e', chaser: 'c', props: {}, kit };
      for (const kind of KINDS) {
        const id = modelIdOf({ index: 1, kind, role: ROLE.obstacle, w: 1, h: 1, d: 1 }, cast);
        expect(id).toBe(kit[kind]);
        expect(id).not.toBe(kind);
      }
    });
  }
});

describe('turbo pad', () => {
  const pad = boostPadGeometry(1.5, 0.3, 1.5);
  const position = pad.getAttribute('position');

  it('stays inside the body footprint and lies flat', () => {
    const box = boxOf(pad);
    expect(box.min.x).toBeGreaterThanOrEqual(-0.75 - 1e-6);
    expect(box.max.x).toBeLessThanOrEqual(0.75 + 1e-6);
    expect(box.min.z).toBeGreaterThanOrEqual(-0.75 - 1e-6);
    expect(box.max.z).toBeLessThanOrEqual(0.75 + 1e-6);
    expect(box.min.y).toBeCloseTo(0, 6);
    expect(box.max.y).toBeCloseTo(0.12, 6);
  });

  it('is two arrows pointing down the track (+z), not a box', () => {
    let [tip, wing] = [-Infinity, -Infinity];
    for (let i = 0; i < position.count; i += 1) {
      const [x, z] = [position.getX(i), position.getZ(i)];
      if (Math.abs(x) < 1e-6) tip = Math.max(tip, z);
      if (Math.abs(Math.abs(x) - 0.75) < 1e-6) wing = Math.max(wing, z);
    }
    expect(tip - wing).toBeGreaterThan(0.3);
    expect(position.count).toBeGreaterThan(24);
  });
});

describe('race barriers', () => {
  const surface: Surface = SURFACES.asphalt;
  const road = roadGeometry(STRAIGHT, surface, { height: 1, thickness: 0.5 })!;

  it('fill the same volume as the one-colour wall did', () => {
    const box = boxOf(road.walls!).union(boxOf(road.bands!));
    expect([box.min.x, box.max.x, box.min.y, box.max.y, box.min.z, box.max.z]).toEqual([-3.5, 7.5, 0, 1, 0, 30]);
  });

  it('alternate base and band pieces down the track', () => {
    const pieces = (geometry: BufferGeometry): number => new Set(Array.from({ length: geometry.getAttribute('position').count }, (_, i) => Math.floor(geometry.getAttribute('position').getZ(i) / WALL_BAND.on - 1e-6))).size;
    expect(pieces(road.walls!)).toBeGreaterThanOrEqual(10);
    expect(pieces(road.bands!)).toBeGreaterThanOrEqual(10);
  });

  it('have two different colours on every surface', () => {
    for (const kind of Object.keys(SURFACES) as SurfaceKind[]) {
      const [base, band] = (SURFACES[kind] as Surface).wall;
      expect(base, kind).not.toBe(band);
    }
  });
});

describe('track flecks', () => {
  it('sand and dirt get flecks inside the strip, asphalt none', () => {
    for (const kind of ['sand', 'dirt'] as const) {
      const flecks = fleckGeometry(STRAIGHT, SURFACES[kind])!;
      const box = boxOf(flecks);
      expect(flecks.index!.count / 6, kind).toBeGreaterThan(15);
      expect(box.min.x).toBeGreaterThanOrEqual(2 - 5 + 0.4);
      expect(box.max.x).toBeLessThanOrEqual(2 + 5 - 0.4);
    }
    expect(fleckGeometry(STRAIGHT, SURFACES.asphalt)).toBeNull();
  });

  it('are the same for the same track', () => {
    const [a, b] = [fleckGeometry(STRAIGHT, SURFACES.sand)!, fleckGeometry(STRAIGHT, SURFACES.sand)!];
    expect(Array.from(a.getAttribute('position').array)).toEqual(Array.from(b.getAttribute('position').array));
  });
});

describe('seabed track under the underwater light', () => {
  // Rozptyl na rovné trati jako v rigu: obloha polokoule a slunce sady po zvednutí, / π, plus svit povrchu.
  const look = LOOKS.underwater;
  const [sky, sun] = [new Color(look.light[0]), new Color(look.sunColor)];
  const hueOf = (hex: string, glow = '#000000'): number => {
    const [own, self] = [new Color(hex), new Color(glow)];
    const lit = (['r', 'g', 'b'] as const).map((c) => (own[c] * (sky[c] * look.light[2] * HEMI_LIFT + sun[c] * look.sun * SUN_LIFT)) / Math.PI + self[c]) as [number, number, number];
    return new Color().setRGB(...lit).getHSL({ h: 0, s: 0, l: 0 }, SRGBColorSpace).h * 360;
  };

  it('reads as sand with coral flecks, where plain sand turned green', () => {
    expect(look.surface).toBe('seabed');
    const seabed: Surface = SURFACES.seabed;
    expect(hueOf(SURFACES.sand.color)).toBeGreaterThan(90);
    expect(hueOf(seabed.color, seabed.glow)).toBeGreaterThan(20);
    expect(hueOf(seabed.color, seabed.glow)).toBeLessThan(50);
    expect(hueOf(seabed.flecks!, seabed.glow)).toBeLessThan(20);
  });
});
