import { describe, expect, it } from 'vitest';
import { BoxGeometry, Matrix4 } from 'three';

import { placedBoxes, unsupported } from '../contact';
import { compilePlacements, type GeomPlacement } from '../placements';
import { GEOM_VERSION, type GeomNode, type GeomProgram } from '../program';
import { settlePlacements } from '../settle';

/**
 * Usazení je rozhodnutí o každém kusu zvlášť. Usadit okno na podlahu je horší
 * vada než visící okno a na snímku vypadá jako záměr — proto pin na obě půlky.
 */

const program = (nodes: GeomNode[]): GeomProgram =>
  ({
    version: GEOM_VERSION,
    nodes: [...nodes, { kind: 'group', children: nodes.map((_node, index) => index) }],
    root: nodes.length,
  }) as GeomProgram;

const bottomOf = (placements: readonly GeomPlacement[], index: number): number =>
  placedBoxes(placements)[index].box.min.y;

const topOf = (placements: readonly GeomPlacement[], index: number): number =>
  placedBoxes(placements)[index].box.max.y;

describe('settling placed pieces', () => {
  it('drops a slab hanging 40 cm above the floor onto the floor', () => {
    const raw = compilePlacements(program([{ kind: 'mass', variant: 'plinth', at: [0, 3, 0] }]), undefined, { settle: false });
    const lifted = bottomOf(raw, 0);
    const shifted = compilePlacements(program([{ kind: 'mass', variant: 'plinth', at: [0, 3 - lifted + 0.4, 0] }]), undefined, { settle: false });
    expect(bottomOf(shifted, 0)).toBeCloseTo(0.4);

    const settled = settlePlacements(shifted);
    expect(bottomOf(settled, 0)).toBeCloseTo(0);
    expect(unsupported(placedBoxes(settled))).toEqual([]);
  });

  it('seats a thing above a table on the table, not on the floor', () => {
    const table = compilePlacements(program([{ kind: 'mass', variant: 'block', at: [0, 0, 0], scale: [2, 1, 2] }]), undefined, { settle: false });
    const lift = -bottomOf(table, 0);
    const placements = compilePlacements(
      program([
        { kind: 'mass', variant: 'block', at: [0, lift, 0], scale: [2, 1, 2] },
        { kind: 'fixture', variant: 'crate', at: [0.2, 4, 0.1] },
      ]),
    );
    expect(bottomOf(placements, 0)).toBeCloseTo(0);
    expect(bottomOf(placements, 1)).toBeCloseTo(topOf(placements, 0));
    expect(unsupported(placedBoxes(placements))).toEqual([]);
  });

  it('leaves the window, the balcony slab and the roof where the model put them', () => {
    const nodes: GeomNode[] = [
      { kind: 'panel', variant: 'window', at: [0, 2, 0] },
      { kind: 'panel', variant: 'floor', at: [3, 4, 0] },
      { kind: 'panel', variant: 'railing', at: [3, 4.6, 0] },
      { kind: 'panel', variant: 'roof', at: [-3, 5, 0] },
    ];
    const raw = compilePlacements(program(nodes), undefined, { settle: false });
    const settled = compilePlacements(program(nodes));
    settled.forEach((placement, index) => {
      expect(placement.matrix.equals(raw[index].matrix)).toBe(true);
    });
  });

  it('leaves a scene with nothing to settle onto alone', () => {
    const rough: GeomPlacement = {
      kind: 'mesh',
      geometry: new BoxGeometry(20, 2, 20),
      matrix: new Matrix4().makeTranslation(0, 0, 0),
      mirrored: false,
    };
    const crate: GeomPlacement = {
      kind: 'piece',
      pieceId: 'fixture.crate',
      matrix: new Matrix4().makeTranslation(1, 3, 1),
      mirrored: false,
    };
    const settled = settlePlacements([rough, crate]);
    expect(settled[1].matrix.equals(crate.matrix)).toBe(true);
    expect(settlePlacements([])).toEqual([]);
    rough.geometry.dispose();
  });

  it('never moves a piece that already stands', () => {
    const raw = compilePlacements(program([{ kind: 'fixture', variant: 'crate', at: [0, 0, 0] }]), undefined, { settle: false });
    const standing = compilePlacements(program([{ kind: 'fixture', variant: 'crate', at: [0, -bottomOf(raw, 0), 0] }]));
    expect(bottomOf(standing, 0)).toBeCloseTo(0);
    const again = settlePlacements(standing);
    expect(again[0].matrix.equals(standing[0].matrix)).toBe(true);
  });
});
