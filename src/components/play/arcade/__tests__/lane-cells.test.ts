/**
 * Ťuk do buňky mřížky přes vstup pruhů (P66 T2): šipky (`arrows`) nemají vlastní vstup – buňka pod prstem jde v ose
 * dnešního záznamu (`axisOfCell`), jen když scéna plátnu zapíše `data-lane-cells`. Buňka posunutá o jednu by
 * vypadala jako ťuk vedle a hra by tiše poslala jiný kus.
 */

import { describe, expect, it } from 'vitest';

import { AXIS_MAX } from '@/play/arcade/contract';
import { axisOfCell, cellOfAxis } from '@/play/arcade/pieces/lanes';

import { cellAxisAt } from '../genres/lanes/lanes-input';

/** Mřížka 4 × 6 v prostřední části plátna: zleva 0,1 až 0,9, shora 0,2 až 0,8. */
const GRID = '4,6,0.1,0.2,0.9,0.8';

describe('tap cells through the lanes input (P66 T2)', () => {
  it('a cell index rides in the axis: never 0 (no input), always inside the axis range, and back again', () => {
    for (const cell of [0, 1, 23, AXIS_MAX - 1]) {
      const axis = axisOfCell(cell);
      expect(axis).not.toBe(0);
      expect(axis).toBeLessThanOrEqual(AXIS_MAX);
      expect(cellOfAxis(axis)).toBe(cell);
    }
  });

  it('the finger picks the cell under it, row by row from the top left', () => {
    expect(cellAxisAt(0.11, 0.21, GRID)).toBe(axisOfCell(0));
    expect(cellAxisAt(0.89, 0.21, GRID)).toBe(axisOfCell(3));
    expect(cellAxisAt(0.11, 0.31, GRID)).toBe(axisOfCell(4));
    expect(cellAxisAt(0.89, 0.79, GRID)).toBe(axisOfCell(23));
    // Kousek za začátkem druhého sloupce (0,3) a druhé řady (0,3).
    expect(cellAxisAt(0.31, 0.31, GRID)).toBe(axisOfCell(5));
  });

  it('a tap outside the grid picks nothing', () => {
    for (const [x, y] of [[0.05, 0.5], [0.95, 0.5], [0.5, 0.1], [0.5, 0.9], [0.9, 0.5], [0.5, 0.8]] as const) expect(cellAxisAt(x, y, GRID), `${x},${y}`).toBeNull();
  });
});
