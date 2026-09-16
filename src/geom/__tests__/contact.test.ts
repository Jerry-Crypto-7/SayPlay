import { describe, expect, it } from 'vitest';
import { Box3, BoxGeometry, Matrix4, Vector3 } from 'three';

import { isSupported, outOfBounds, overlaps, placedBoxes, unsupported } from '../contact';
import type { GeomPlacement } from '../placements';

/**
 * Podpora je práh nad čísly: špatná tolerance vypadá na snímku stejně a tiše
 * prohlásí visící desku za stojící — přesně vada `t4` z P18.
 */

/** Kvádr o rozměrech `size`, jehož spodek leží na `base`. */
function slab(size: [number, number, number], base: [number, number, number]): GeomPlacement {
  const geometry = new BoxGeometry(...size);
  return {
    kind: 'mesh',
    geometry,
    matrix: new Matrix4().makeTranslation(base[0], base[1] + size[1] / 2, base[2]),
    mirrored: false,
  };
}

const WORLD = new Box3(new Vector3(-10, 0, -10), new Vector3(10, 10, 10));

describe('contact of placed pieces', () => {
  it('reports a piece 20 cm above the floor as unsupported', () => {
    const boxes = placedBoxes([slab([1, 0.1, 1], [0, 0.2, 0])]);
    expect(unsupported(boxes)).toEqual([0]);
  });

  it('treats a gap within one centimetre as contact, and a larger one as hanging', () => {
    expect(unsupported(placedBoxes([slab([1, 0.1, 1], [0, 0.009, 0])]))).toEqual([]);
    expect(unsupported(placedBoxes([slab([1, 0.1, 1], [0, 0.02, 0])]))).toEqual([0]);
  });

  it('reports a piece on a table top as supported', () => {
    const boxes = placedBoxes([
      slab([1.2, 0.75, 0.8], [0, 0, 0]),
      slab([0.3, 0.3, 0.3], [0.2, 0.75, 0]),
    ]);
    expect(unsupported(boxes)).toEqual([]);
    expect(overlaps(boxes)).toEqual([]);
  });

  it('keeps a piece hanging when its centre falls beyond the edge it touches', () => {
    const boxes = placedBoxes([
      slab([1, 0.75, 1], [0, 0, 0]),
      slab([1, 0.1, 1], [0.9, 0.75, 0]),
    ]);
    expect(isSupported(boxes, 1)).toBe(false);
  });

  it('reports two interpenetrating pieces as an overlap', () => {
    const boxes = placedBoxes([
      slab([1, 1, 1], [0, 0, 0]),
      slab([1, 1, 1], [0.5, 0, 0]),
    ]);
    expect(overlaps(boxes)).toEqual([[0, 1]]);
  });

  it('reports a piece beyond the world edge as out of bounds', () => {
    const boxes = placedBoxes([slab([1, 1, 1], [0, 0, 0]), slab([1, 1, 1], [10.2, 0, 0])]);
    expect(outOfBounds(boxes, WORLD)).toEqual([1]);
  });

  it('measures kit pieces in world coordinates', () => {
    const matrix = new Matrix4().makeTranslation(5, 3, 0);
    const [box] = placedBoxes([{ kind: 'piece', pieceId: 'fixture.crate', matrix, mirrored: false }]);
    expect(box.pieceId).toBe('fixture.crate');
    expect(box.box.getCenter(new Vector3()).x).toBeCloseTo(5, 1);
    expect(unsupported([box])).toEqual([0]);
  });

  it('survives an empty scene', () => {
    const boxes = placedBoxes([]);
    expect(unsupported(boxes)).toEqual([]);
    expect(overlaps(boxes)).toEqual([]);
    expect(outOfBounds(boxes, WORLD)).toEqual([]);
  });
});
