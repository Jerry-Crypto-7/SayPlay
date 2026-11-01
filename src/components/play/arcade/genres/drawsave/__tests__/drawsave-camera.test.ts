/**
 * Kamera a buňky hry kresli a zachraň (P68-S T14). Posunutá mřížka vypadá správně a prst kreslí o buňku vedle:
 * test pinuje, že bod uvnitř každé nakreslené buňky dá přes `data-lane-cells` a sdílený `cellAxisAt` tutéž buňku,
 * jakou pod ním vidí jádro (`cellAtWorld`), že celá deska leží v rámu nad dolní řadou HUD a jak velká je nejmenší
 * buňka – na výšku telefonu (390 × 844, iPhone 15, Pixel 7 s pásy HUD z P64), na šířku telefonu (844 × 390, iPhone 15
 * a Pixel 7 na šířku) i na desktopu.
 */

import { PerspectiveCamera, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';

import { size } from '@/brand/tokens';
import { UNIT } from '@/play/arcade/contract';
import { BOARD_CELLS, DRAWSAVE, cellAtWorld, cellX, cellY, rowOf } from '@/play/arcade/pieces/drawsave-world';
import { axisOfCell, cellOfAxis } from '@/play/arcade/pieces/lanes';

import { type FrameRect, playRect } from '../../../portrait-frame';
import { cellAxisAt } from '../../lanes/lanes-input';
import { BOARD_BOX, type Canvas, boardFrame, cellsAttr, placeCamera, sceneX, sceneY, tallFallback } from '../drawsave-camera';

/**
 * Pás HUD nahoře (P64 audit `after`: iPhone 99 px, Pixel 7 98 px; na šířku 120 px s řádkem cíle) a dole dolní řada
 * HUD (Restart, „Change one thing“, sdílení: `--_bottom` 16 px + `--_row` 58 px, `play.css`) přes celou šířku.
 * `cell` = nejmenší strana buňky (px), jakou kamera dnes dá – pin proti tomu, aby se deska potichu zmenšila.
 */
const HUD_ROW = 16 + 58;
const VIEWPORTS = [
  { name: 'phone 390 × 844', canvas: { width: 390, height: 844 }, top: 99, cell: 46.7 },
  { name: 'iPhone 15', canvas: { width: 393, height: 659 }, top: 99, cell: 36.6 },
  { name: 'Pixel 7', canvas: { width: 412, height: 839 }, top: 98, cell: 49.4 },
  { name: 'phone 844 × 390', canvas: { width: 844, height: 390 }, top: 120, cell: 23.8 },
  { name: 'iPhone 15 landscape', canvas: { width: 734, height: 343 }, top: 120, cell: 20.0 },
  { name: 'Pixel 7 landscape', canvas: { width: 863, height: 360 }, top: 120, cell: 21.4 },
  { name: 'desktop 1280 × 720', canvas: { width: 1280, height: 720 }, top: 120, cell: 49.9 },
] as const;

/** Bod uvnitř buňky jako podíl od jejího levého boku (`u`) a horní hrany (`v`). */
const INSIDE = [
  [0.5, 0.5],
  [0.25, 0.25],
  [0.75, 0.25],
  [0.25, 0.75],
  [0.75, 0.75],
] as const;

function setup(canvas: Canvas, top: number): { readonly camera: PerspectiveCamera; readonly frame: FrameRect } {
  const camera = new PerspectiveCamera(50, canvas.width / canvas.height, 0.1, 500);
  const rect = playRect(canvas, top, canvas.height - HUD_ROW);
  placeCamera(camera, canvas, rect);
  return { camera, frame: boardFrame(canvas, rect) };
}

/** Bod jádra (jednotky) → px plátna (y dolů). */
function px(camera: PerspectiveCamera, canvas: Canvas, x: number, y: number): { readonly x: number; readonly y: number } {
  const ndc = new Vector3(sceneX(x), sceneY(y), 0).project(camera);
  return { x: ((ndc.x + 1) / 2) * canvas.width, y: ((1 - ndc.y) / 2) * canvas.height };
}

/** Bod jádra uvnitř buňky: `u` od levého boku (menší x), `v` od horní hrany (větší y). */
function inCell(cell: number, u: number, v: number): { readonly x: number; readonly y: number } {
  const half = DRAWSAVE.cell / 2;
  return { x: cellX(cell) - half + u * DRAWSAVE.cell, y: cellY(cell) + half - v * DRAWSAVE.cell };
}

describe('drawsave side camera and drag cells (P68-S T14)', () => {
  for (const { name, canvas, top, cell: smallest } of VIEWPORTS) {
    describe(name, () => {
      const { camera, frame } = setup(canvas, top);
      const cells = Array.from({ length: BOARD_CELLS }, (_, cell) => cell);

      it('all 96 cells lie inside the frame, above the HUD bottom row', () => {
        // Rám staví desku přesně na hranu; desetina px je zaokrouhlení, ne přesah.
        const slack = 0.1;
        for (const cell of cells) {
          for (const [u, v] of [[0, 0], [1, 0], [0, 1], [1, 1]] as const) {
            const at = px(camera, canvas, inCell(cell, u, v).x, inCell(cell, u, v).y);
            expect(at.x, `cell ${cell} x`).toBeGreaterThanOrEqual(frame.left - slack);
            expect(at.x, `cell ${cell} x`).toBeLessThanOrEqual(frame.right + slack);
            expect(at.y, `cell ${cell} y`).toBeGreaterThanOrEqual(frame.top - slack);
            expect(at.y, `cell ${cell} y`).toBeLessThanOrEqual(frame.bottom + slack);
            expect(at.y, `cell ${cell} under the HUD bottom row`).toBeLessThanOrEqual(canvas.height - HUD_ROW);
          }
        }
      });

      it(`every cell is a square of the same size, at least ${String(smallest)} px (--sp-size-touch-min where the free height allows)`, () => {
        const sides: number[] = [];
        for (const cell of cells) {
          const a = px(camera, canvas, inCell(cell, 0, 0).x, inCell(cell, 0, 0).y);
          const b = px(camera, canvas, inCell(cell, 1, 1).x, inCell(cell, 1, 1).y);
          expect(b.x - a.x, `cell ${cell} square`).toBeCloseTo(b.y - a.y, 6);
          sides.push(Math.min(b.x - a.x, b.y - a.y));
        }
        expect(Math.max(...sides) - Math.min(...sides), 'no foreshortening').toBeLessThan(1e-6);
        const side = Math.min(...sides);
        expect(side).toBeGreaterThanOrEqual(smallest);
        // Deska je tak velká, jak rám dovolí: buď je buňka dotykový cíl, nebo deska vyplní volnou výšku či šířku.
        const fill = Math.min((frame.right - frame.left) / BOARD_BOX.width, (frame.bottom - frame.top) / BOARD_BOX.height) * (DRAWSAVE.cell / UNIT);
        expect(side).toBeCloseTo(fill, 6);
        if (fill >= size['touch-min']) expect(side).toBeGreaterThanOrEqual(size['touch-min']);
      });

      it('cellAxisAt from the shared lanes input returns the cell the kernel sees under the point, for the middle half of each drawn cell', () => {
        const attr = cellsAttr(camera, canvas);
        expect(attr.startsWith('8,12,')).toBe(true);
        for (const cell of cells) {
          for (const [u, v] of INSIDE) {
            const world = inCell(cell, u, v);
            expect(cellAtWorld(world.x, world.y), `kernel cell ${cell} at ${u},${v}`).toBe(cell);
            const at = px(camera, canvas, world.x, world.y);
            const axis = cellAxisAt(at.x / canvas.width, at.y / canvas.height, attr);
            expect(axis, `cell ${cell} at ${u},${v}`).toBe(axisOfCell(cell));
            expect(cellOfAxis(axis as number)).toBe(cellAtWorld(world.x, world.y));
          }
        }
      });

      if (canvas.width < canvas.height) {
        it('the hero rows (lower third) lie in the bottom half of the screen, under the thumb', () => {
          for (const cell of cells.filter((each) => rowOf(each) >= DRAWSAVE.heroRows.min)) {
            expect(px(camera, canvas, cellX(cell), cellY(cell)).y, `cell ${cell}`).toBeGreaterThanOrEqual(canvas.height * 0.5);
          }
        });
      }
    });
  }

  it('before the play rect is measured, the portrait fallback still keeps the board under the HUD pills', () => {
    const canvas = { width: 390, height: 844 };
    const camera = new PerspectiveCamera(50, canvas.width / canvas.height, 0.1, 500);
    const rect = tallFallback(canvas);
    placeCamera(camera, canvas, rect);
    for (const cell of [0, DRAWSAVE.cols - 1]) expect(px(camera, canvas, cellX(cell), inCell(cell, 0.5, 0).y).y).toBeGreaterThanOrEqual(rect.px.top);
  });
});
