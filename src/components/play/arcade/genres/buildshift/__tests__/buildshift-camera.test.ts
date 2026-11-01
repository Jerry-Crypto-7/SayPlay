/**
 * Kamera a buňky směny se stavbou obchodu (P68-S T5). Posunutá mřížka vypadá správně a prst staví o buňku vedle:
 * test pinuje, že promítnuté buňky desky i palety sedí s `data-lane-cells`, jak ho čte sdílený `cellAxisAt`, že se
 * všech 35 buněk vejde do hracího obdélníku nad dolní řadu HUD a že je každá aspoň `--sp-size-touch-min` velká – na
 * výšku telefonu (390 × 844, iPhone 15, Pixel 7 s pásy HUD změřenými v P64) a na šířku desktopu; na šířku telefonu
 * (844 × 390, iPhone 15 a Pixel 7 na šířku) se 44 px nad dolní řadu HUD nevejde, tam řady vyplní volnou výšku.
 */

import { PerspectiveCamera, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';

import { size } from '@/brand/tokens';
import { GRID_CELLS, PALETTE_ROW, rowOf } from '@/play/arcade/pieces/buildshift-world';
import { axisOfCell } from '@/play/arcade/pieces/lanes';

import { type FrameRect, playRect } from '../../../portrait-frame';
import { cellAxisAt } from '../../lanes/lanes-input';
import { type Canvas, cellRect, cellsAttr, placeCamera, tallFallback, wideFrame } from '../buildshift-camera';

/**
 * Pás HUD nahoře na výšku (P64 audit `after`: iPhone 99 px, Pixel 7 98 px) a dole dolní řada HUD (Restart, „Change
 * one thing“, sdílení: `--_bottom` 16 px + `--_row` 58 px, `play.css`), která vede přes celou šířku i na šířku – e2e T6
 * ji na šířku našel přes paletu. Na šířku skutečné rozměry telefonů z Playwright (`iPhone 15 landscape`, `Pixel 7
 * landscape`) a desktop `chromium`.
 */
const HUD_ROW = 16 + 58;
const VIEWPORTS = [
  { name: 'phone 390 × 844', canvas: { width: 390, height: 844 }, top: 99 },
  { name: 'iPhone 15', canvas: { width: 393, height: 659 }, top: 99 },
  { name: 'Pixel 7', canvas: { width: 412, height: 839 }, top: 98 },
  { name: 'phone 844 × 390', canvas: { width: 844, height: 390 }, top: 120 },
  { name: 'iPhone 15 landscape', canvas: { width: 734, height: 343 }, top: 120 },
  { name: 'Pixel 7 landscape', canvas: { width: 863, height: 360 }, top: 120 },
  { name: 'desktop 1280 × 720', canvas: { width: 1280, height: 720 }, top: 120 },
] as const;

/** Bod uvnitř buňky jako podíl od jejího levého boku (`u`) a vzdálené hrany (`v`). */
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
  return { camera, frame: camera.aspect < 1 ? rect.px : wideFrame(canvas, rect) };
}

/** Bod scény na zemi → px plátna (y dolů). */
function px(camera: PerspectiveCamera, canvas: Canvas, x: number, z: number): { readonly x: number; readonly y: number } {
  const ndc = new Vector3(x, 0, z).project(camera);
  return { x: ((ndc.x + 1) / 2) * canvas.width, y: ((1 - ndc.y) / 2) * canvas.height };
}

/** Bod uvnitř buňky (`u` zleva, `v` od vzdálené hrany) → px. */
function inCell(camera: PerspectiveCamera, canvas: Canvas, cell: number, u: number, v: number): { readonly x: number; readonly y: number } {
  const r = cellRect(cell);
  return px(camera, canvas, r.left + (r.right - r.left) * u, r.far + (r.near - r.far) * v);
}

describe('buildshift camera and tap cells (P68-S T5)', () => {
  for (const { name, canvas, top } of VIEWPORTS) {
    describe(name, () => {
      const { camera, frame } = setup(canvas, top);
      const cells = Array.from({ length: GRID_CELLS }, (_, cell) => cell);

      it('all 35 cells (board and palette) lie inside the play rect', () => {
        // Fit staví mřížku přesně na hranu rámu; desetina px je zaokrouhlení, ne přesah.
        const slack = 0.1;
        for (const cell of cells) {
          for (const [u, v] of [[0, 0], [1, 0], [0, 1], [1, 1]] as const) {
            const at = inCell(camera, canvas, cell, u, v);
            expect(at.x, `cell ${cell} x`).toBeGreaterThanOrEqual(frame.left - slack);
            expect(at.x, `cell ${cell} x`).toBeLessThanOrEqual(frame.right + slack);
            expect(at.y, `cell ${cell} y`).toBeGreaterThanOrEqual(frame.top - slack);
            expect(at.y, `cell ${cell} y`).toBeLessThanOrEqual(frame.bottom + slack);
            // Nad dolní řadou HUD v každé orientaci: jinak tlačítka leží přes paletu (e2e T6 na šířku).
            expect(at.y, `cell ${cell} under the HUD bottom row`).toBeLessThanOrEqual(canvas.height - HUD_ROW);
          }
        }
      });

      it('every cell is at least --sp-size-touch-min on its shorter side (on a landscape phone: as big as the free height allows)', () => {
        // Na šířku telefonu se 7 řad po 44 px nad dolní řadu HUD nevejde (integration.md): tam řady vyplní volnou výšku.
        const floor = canvas.width < canvas.height ? size['touch-min'] : Math.min(size['touch-min'], (frame.bottom - frame.top) / 8);
        for (const cell of cells) {
          const width = inCell(camera, canvas, cell, 1, 0.5).x - inCell(camera, canvas, cell, 0, 0.5).x;
          const height = inCell(camera, canvas, cell, 0.5, 1).y - inCell(camera, canvas, cell, 0.5, 0).y;
          expect(Math.min(width, height), `cell ${cell}`).toBeGreaterThanOrEqual(floor);
        }
      });

      it('cellAxisAt from the shared lanes input returns each cell for the middle half of the drawn cell', () => {
        const attr = cellsAttr(camera, canvas);
        expect(attr.startsWith('5,7,')).toBe(true);
        for (const cell of cells) {
          for (const [u, v] of INSIDE) {
            const at = inCell(camera, canvas, cell, u, v);
            expect(cellAxisAt(at.x / canvas.width, at.y / canvas.height, attr), `cell ${cell} at ${u},${v}`).toBe(axisOfCell(cell));
          }
        }
      });

      if (canvas.width < canvas.height) {
        it('the palette row lies in the bottom 45 % of the height, under the thumb', () => {
          for (const cell of cells.filter((each) => rowOf(each) === PALETTE_ROW)) {
            expect(inCell(camera, canvas, cell, 0.5, 0).y, `cell ${cell}`).toBeGreaterThanOrEqual(canvas.height * 0.55);
          }
        });
      }
    });
  }

  it('before the play rect is measured, the portrait fallback still keeps the grid under the HUD pills', () => {
    const canvas = { width: 390, height: 844 };
    const camera = new PerspectiveCamera(50, canvas.width / canvas.height, 0.1, 500);
    const rect = tallFallback(canvas);
    placeCamera(camera, canvas, rect);
    for (const cell of [0, 4]) expect(inCell(camera, canvas, cell, 0.5, 0).y).toBeGreaterThanOrEqual(rect.px.top);
  });
});
