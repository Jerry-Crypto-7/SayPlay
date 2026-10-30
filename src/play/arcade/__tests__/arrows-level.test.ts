/**
 * Mřížka šipek (P66 T9): úroveň řešitelná konstrukcí.
 *
 * - Řešič (`solveArrows`, hladový – odebrání kusu cesty jen uvolní) vyčistí každé kolo 200 semínek; generátor, který
 *   by občas postavil zaseknutou mřížku, by na pěti semínkách prošel okem, tady ne.
 * - Kusy kola se kladou v obráceném pořadí odletu: obrácené pořadí položení je samo platné pořadí odletu.
 */

import { describe, expect, it } from 'vitest';

import {
  ARROWS,
  type ArrowPiece,
  type ArrowsGrid,
  arrowsRounds,
  gridIssue,
  pathClear,
  roundGrids,
  solveArrows,
  totalPieces,
} from '../pieces/arrows-level';
import { AXIS_MAX } from '../contract';
import { checkArrowsLevel } from '../pieces/arrows';
import { axisOfCell } from '../pieces/lanes';

const SEEDS = Array.from({ length: 200 }, (_, index) => index + 1);

/** Platné pořadí odletu: každý kus má v době svého tahu volnou cestu od kusů, které ještě stojí. */
function validOrder(grid: ArrowsGrid, pieces: readonly ArrowPiece[], order: readonly number[]): boolean {
  if (new Set(order).size !== pieces.length || order.length !== pieces.length) return false;
  const standing = new Set(pieces.map((piece) => piece.cell));
  for (const index of order) {
    const piece = pieces[index] as ArrowPiece;
    if (!pathClear(grid, piece.cell, piece.dir, (cell) => standing.has(cell))) return false;
    standing.delete(piece.cell);
  }
  return true;
}

describe('arrows grid (P66 T9)', () => {
  it('every round of 200 seeds is solvable, with exactly its piece count on distinct cells', () => {
    for (const rounds of [ARROWS.rounds.min, ARROWS.rounds.default, ARROWS.rounds.max]) {
      for (const seed of SEEDS) {
        const { grids, pieces } = arrowsRounds(seed, rounds);
        grids.forEach((grid, round) => {
          const placed = pieces[round];
          expect(placed, `seed ${seed} round ${round}`).not.toBeNull();
          expect(placed).toHaveLength(grid.pieces);
          expect(new Set(placed!.map((piece) => piece.cell)).size).toBe(grid.pieces);
          const order = solveArrows(grid, placed!);
          expect(order, `seed ${seed} round ${round} jams`).not.toBeNull();
          expect(validOrder(grid, placed!, order!)).toBe(true);
          // Konstrukce: kusy v obráceném pořadí položení odletí jeden po druhém.
          expect(validOrder(grid, placed!, placed!.map((_, index) => placed!.length - 1 - index))).toBe(true);
        });
      }
    }
  });

  it('the solver catches a jam: two pieces facing each other in a row, or a piece walled in', () => {
    const grid = { cols: 4, rows: 3 };
    // Řada 1: kus v buňce 4 míří doprava na kus v buňce 6, ten doleva na něj.
    expect(solveArrows(grid, [{ cell: 4, dir: 1 }, { cell: 6, dir: 3 }])).toBeNull();
    expect(solveArrows(grid, [{ cell: 4, dir: 1 }, { cell: 6, dir: 1 }])).toEqual([1, 0]);
  });

  it('the puzzle is not trivial: on most seeds some piece of the finale starts blocked', () => {
    let blocked = 0;
    for (const seed of SEEDS) {
      const { grids, pieces } = arrowsRounds(seed, ARROWS.rounds.default);
      const grid = grids.at(-1)!;
      const placed = pieces.at(-1)!;
      const cells = new Set(placed.map((piece) => piece.cell));
      if (placed.some((piece) => !pathClear(grid, piece.cell, piece.dir, (cell) => cells.has(cell)))) blocked += 1;
    }
    expect(blocked).toBeGreaterThanOrEqual(SEEDS.length * 0.9);
  });

  it('the same seed builds the same rounds, another seed other ones', () => {
    expect(arrowsRounds(7, 3)).toEqual(arrowsRounds(7, 3));
    expect(arrowsRounds(8, 3).pieces).not.toEqual(arrowsRounds(7, 3).pieces);
  });

  it('rounds grow to the finale, and five rounds fit the 50 a role can count', () => {
    for (let rounds = ARROWS.rounds.min; rounds <= ARROWS.rounds.max; rounds += 1) {
      const grids = roundGrids(rounds);
      expect(grids).toHaveLength(rounds);
      expect(grids.at(-1)).toEqual(ARROWS.steps.at(-1));
      for (let round = 1; round < rounds; round += 1) expect(grids[round]!.cols * grids[round]!.rows).toBeGreaterThan(grids[round - 1]!.cols * grids[round - 1]!.rows);
    }
    expect(totalPieces(ARROWS.rounds.max)).toBeLessThanOrEqual(50);
  });

  it('a grid carries at most 999 cells, so the last tap axis stays within AXIS_MAX (T2a)', () => {
    // Ťuk nese buňku v ose (`axisOfCell`); výzva (`score/dare.ts`) bere osu nejvýš `AXIS_MAX`.
    expect(axisOfCell(ARROWS.maxCells - 1)).toBeLessThanOrEqual(AXIS_MAX);
    for (const step of ARROWS.steps) expect(gridIssue(step), `${step.cols} × ${step.rows}`).toBeNull();
    expect(gridIssue({ cols: 27, rows: 37 })).toBeNull();
    expect(gridIssue({ cols: 25, rows: 40 })).toMatch(/1000 cells/);
    const grids = [{ cols: 4, rows: 3 }, { cols: 50, rows: 20 }];
    expect(checkArrowsLevel(grids, [[{ cell: 0, dir: 0 }], [{ cell: 0, dir: 0 }]], 3).join(' ')).toMatch(/round 2: .*1000 cells/);
  });
});
