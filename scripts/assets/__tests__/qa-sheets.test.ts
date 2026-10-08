import { describe, expect, it } from 'vitest';

import { cellOrigin, gridPlan } from '../qa-grid.mjs';

const assets = (ids: string[]) => ids.map((assetId) => ({ assetId }));

describe('grid QA sheets (P43 T10)', () => {
  it('maps every model to exactly one cell, sorted by id, nine per sheet', () => {
    const ids = Array.from({ length: 20 }, (_, index) => `m${String(19 - index).padStart(2, '0')}`);
    const plan = gridPlan(assets(ids), 3);
    expect(plan.map((sheet) => sheet.sheet)).toEqual(['grid-001', 'grid-002', 'grid-003']);
    expect(plan.map((sheet) => sheet.cells.length)).toEqual([9, 9, 2]);
    expect(plan[0].cells[0]).toBe('m00');
    expect(plan[1].cells[4]).toBe('m13');
    expect(plan.flatMap((sheet) => sheet.cells).sort()).toEqual([...ids].sort());
  });

  it('is stable whatever order the catalog lists the models in', () => {
    const ids = ['c', 'a', 'b', 'e', 'd'];
    expect(gridPlan(assets(ids), 2)).toEqual(gridPlan(assets([...ids].reverse()), 2));
  });

  it('places cells row by row', () => {
    expect(cellOrigin(0, 3, 340)).toEqual({ x: 0, y: 0 });
    expect(cellOrigin(2, 3, 340)).toEqual({ x: 680, y: 0 });
    expect(cellOrigin(4, 3, 340)).toEqual({ x: 340, y: 340 });
    expect(cellOrigin(8, 3, 340)).toEqual({ x: 680, y: 680 });
  });
});
