/**
 * P73D T5: tři vrstvy scény. Obzor má znak místa (vodojemy, kužel sopky s kouřem, korálové oblouky, mlýny,
 * věže hradu, lízátka), střed orientační bod z katalogu, popředí 1–2 rámující kusy mimo osu kamera → hrdina.
 * Sopečný kaňon běžce je nižší, teplý a vedle cesty teče láva.
 */
import { Color, PerspectiveCamera, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';

import { LOOK_IDS, LOOKS, type Mark, modelHeight, sceneLook } from '@/play/arcade/look';

import { backdropLayers, buildBackdrop } from '../backdrop-shapes';
import type { Box } from '../ground';
import { footOf, type HeroBox, placeFraming } from '../landmark-places';
import { buildValley, LAVA_BAND, PLAYABLE_HALF, valleyPalette } from '../rig/terrain/valley';

const CLEAR = 6;
const offAxis = (angle: number): number => Math.min(angle, 2 * Math.PI - angle);
const luminance = (hex: string): number => {
  const { r, g, b } = new Color(hex);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

describe('P73D T5: obzor podle místa', () => {
  it('každá sada má kulisu aspoň o dvou vrstvách a orientační bod z katalogu', () => {
    for (const id of LOOK_IDS) {
      expect(LOOKS[id].skyline?.layers.length ?? 0, id).toBeGreaterThanOrEqual(2);
      expect(LOOKS[id].landmark.length, id).toBeGreaterThanOrEqual(1);
    }
  });

  it('místa z QA mají svůj znak, cukrová země z věty lízátka, louka bez cukru mlýny', () => {
    const expected: Record<string, Mark> = { city: 'tanks', volcano: 'cone', underwater: 'arches', meadow: 'mills', castle: 'turrets' };
    for (const [id, mark] of Object.entries(expected)) expect(LOOKS[id as keyof typeof LOOKS].skyline?.marks, id).toBe(mark);
    expect(sceneLook({ setting: 'candy land with lollipops', mood: 'happy', look: 'meadow' }).skyline?.marks).toBe('lollipops');
    expect(sceneLook({ setting: 'quiet meadow', mood: 'happy', look: 'meadow' }).skyline?.marks).toBe('mills');
  });

  it('znaky jsou v síti vrstvy navíc, mimo průsek nad cestou, a kužel sopky stojí vedle osy pohledu', () => {
    for (const id of ['city', 'volcano', 'underwater', 'meadow', 'castle'] as const) {
      const parts = buildBackdrop(LOOKS[id], { seed: 7, clear: CLEAR, skirt: 0.05 });
      const marked = parts.filter(({ layer }) => layer.marks.length > 0);
      expect(marked, id).toHaveLength(1);
      const { layer, geometry } = marked[0]!;
      expect(geometry.getIndex()!.count, id).toBeGreaterThan(6 * (layer.profile.length - 1));
      const nearest = parts.at(-1)!.layer;
      if (layer === nearest) for (const mark of layer.marks) expect(offAxis(mark.angle), id).toBeGreaterThanOrEqual((1.8 * CLEAR) / layer.radius);
    }
    const cone = backdropLayers(LOOKS.volcano, 7, CLEAR)[0]!;
    expect(cone.marks.some((mark) => offAxis(mark.angle) < 0.6)).toBe(true);
    expect(backdropLayers(LOOKS.desert, 7, CLEAR).every((layer) => layer.marks.length === 0)).toBe(true);
  });

  it('obrysy vrstev zůstaly, jaké byly – znaky mají vlastní stream semínka', () => {
    const before = backdropLayers({ ...LOOKS.city, skyline: { ...LOOKS.city.skyline!, marks: undefined } }, 7, CLEAR);
    const after = backdropLayers(LOOKS.city, 7, CLEAR);
    expect(after.map((layer) => layer.profile)).toEqual(before.map((layer) => layer.profile));
  });
});

describe('P73D T5: sopečný kaňon běžce', () => {
  const heights = (geometry: ReturnType<typeof buildValley>['geometry']): number => {
    const position = geometry.getAttribute('position');
    let top = 0;
    for (let i = 0; i < position.count; i += 1) top = Math.max(top, position.getY(i));
    return top;
  };

  it('stěna je nejvýš polovina běžného svahu a sráz není skoro černý', () => {
    const volcano = buildValley({ look: LOOKS.volcano, from: 0, to: 40 });
    const meadow = buildValley({ look: LOOKS.meadow, from: 0, to: 40 });
    expect(heights(volcano.geometry)).toBeLessThan(0.5 * heights(meadow.geometry));
    expect(luminance(valleyPalette(LOOKS.volcano).rock)).toBeGreaterThan(0.08);
    expect(luminance(valleyPalette(LOOKS.volcano).shade)).toBeGreaterThan(0.05);
  });

  it('vedle cesty teče láva, jinde ne; louka lávu nemá', () => {
    const lavaVertices = (look: typeof LOOKS.volcano): number[] => {
      const { geometry } = buildValley({ look, from: 0, to: 40 });
      const [position, color] = [geometry.getAttribute('position'), geometry.getAttribute('color')];
      const xs: number[] = [];
      for (let i = 0; i < color.count; i += 1) if (color.getX(i) > 0.6 && color.getX(i) > 3 * color.getY(i)) xs.push(Math.abs(position.getX(i)));
      return xs;
    };
    const lava = lavaVertices(LOOKS.volcano);
    expect(lava.length).toBeGreaterThan(30);
    // Vrcholy lávových trojúhelníků leží na sloupcích kolem pásu – nejvýš o krok sítě za ním.
    for (const x of lava) expect(x - PLAYABLE_HALF).toBeLessThan(LAVA_BAND[1] + 1);
    expect(lavaVertices(LOOKS.meadow)).toHaveLength(0);
  });
});

describe('P73D T5: popředí nezakryje hrdinu', () => {
  const camera = new PerspectiveCamera(50, 16 / 9, 0.1, 200);
  camera.position.set(0, 7, -10);
  camera.lookAt(0, 0.8, 6);
  camera.updateMatrixWorld();
  camera.updateProjectionMatrix();
  const hero: HeroBox = { x: 0, y: 0, z: 0, r: 0.5, h: 1.6 };
  const area: Box[] = [{ x0: -3.5, x1: 3.5, z0: -2, z1: 30 }];
  const eye = camera.position.clone();
  const target = new Vector3(hero.x, hero.y + hero.h / 2, hero.z);

  it('1–2 kusy na sadu, žádný neprotne úsečku kamera → hrdina, a rám dostane víc než polovina sad', () => {
    let framed = 0;
    for (const id of LOOK_IDS) {
      const pieces = placeFraming({ camera, look: LOOKS[id], seed: 11, area, hero, ground: () => 0 });
      expect(pieces.length, id).toBeLessThanOrEqual(2);
      if (pieces.length > 0) framed += 1;
      for (const piece of pieces) {
        const [r, top] = [footOf(piece), piece.y + modelHeight(piece.id) * piece.scale];
        for (let k = 0; k <= 200; k += 1) {
          const q = eye.clone().lerp(target, k / 200);
          const inside = Math.hypot(q.x - piece.x, q.z - piece.z) < r && q.y < top && q.y > piece.y;
          expect(inside, `${id} ${piece.id}`).toBe(false);
        }
      }
    }
    expect(framed).toBeGreaterThan(LOOK_IDS.length / 2);
  });
});
