/**
 * Jeden šev rámování na výšku (P64 T2, `portrait-frame.ts`).
 *
 * - Na šířku (`camera.aspect ≥ 1`) je `fitTall` identita: na 19 žánrech z `e2e/p64-cells.ts` s kamerou, kterou žánr
 *   dnes staví na šířku (otisky stráže `evals/play/p64/landscape-baseline.json`, chromium i Pixel 7 na šířku), vrátí
 *   tatáž čísla polohy, nulový posun a kamery se nedotkne.
 * - Na Pixel 7 na výšku (412 × 839) s pásy z T1 leží krabice žánru po fitu celá v `playRect` i s okrajem a fit je
 *   těsný – kamera, která by jen couvla do nekonečna, by „uvnitř“ splnila taky.
 * - Bez pásů je posun nulový; okraj do stran nikdy neubere `keep`.
 *
 * Krabice žánru = to, co jeho kamera na šířku rámuje: rohy NDC ±0,9 ve dvou hloubkách kolem země pod osou pohledu.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { Box3, PerspectiveCamera, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';

import { UNIT } from '@/play/arcade/contract';
import { TIMING } from '@/play/arcade/pieces/timing';

import { P64_CELLS } from '../../../../../e2e/p64-cells';
import type { CameraPrint } from '../ArcadeStage';
import { FIT_MARGIN_PX, type PlayRect, fitTall, playRect } from '../portrait-frame';
import { SLICE_SIZES, SLICE_TALL } from '../genres/slice/SliceScene';
import { timingDistance, timingTallBox } from '../timing/TimingScene';

interface Print {
  readonly tick: number;
  readonly camera: CameraPrint;
}

const BASELINE = (JSON.parse(readFileSync(join(process.cwd(), 'evals/play/p64/landscape-baseline.json'), 'utf8')) as { prints: Record<string, Record<string, readonly Print[]>> }).prints;
const GENRE_CELLS = P64_CELLS.filter((cell) => !cell.key.startsWith('control:'));

const PIXEL7 = { width: 412, height: 839 } as const;
/** Pásy T1 na Pixel 7 na výšku (`audit.json` → `before`, `playRect` top / bottom); ostatní žánry 120 / 839. */
const T1_BANDS: Readonly<Record<string, readonly [number, number]>> = {
  platformer: [138, 703],
  arena: [119, 596],
  quest: [120, 597],
  rhythm: [138, 839],
  duel: [120, 703],
};
const bandsOf = (key: string): readonly [number, number] => T1_BANDS[key] ?? [120, 839];

/** Kamera z otisku stráže; `aspect` přepíše poměr stran (telefon na výšku). */
function cameraOf(print: CameraPrint, aspect = print.aspect!): PerspectiveCamera {
  const near = print.projection[14]! / (print.projection[10]! - 1);
  const far = print.projection[14]! / (print.projection[10]! + 1);
  const camera = new PerspectiveCamera(print.fov!, aspect, near, far);
  camera.position.fromArray(print.position);
  camera.quaternion.fromArray(print.quaternion);
  camera.updateMatrixWorld();
  return camera;
}

const forwardOf = (camera: PerspectiveCamera): Vector3 => new Vector3(0, 0, -1).applyQuaternion(camera.quaternion);

/** Bod světa v NDC (x, y) a hloubce `depth` podél osy pohledu kamery. */
function pointAt(camera: PerspectiveCamera, x: number, y: number, depth: number): Vector3 {
  const t = Math.tan((camera.fov * Math.PI) / 360);
  return new Vector3(x * t * camera.aspect * depth, y * t * depth, -depth).applyQuaternion(camera.quaternion).add(camera.position);
}

/** Krabice, kterou kamera žánru rámuje: rohy NDC ±0,9 v 0,8× a 1,2× hloubky země pod osou (kamera bez země 10 m). */
function boxSeenBy(camera: PerspectiveCamera): Box3 {
  const forward = forwardOf(camera);
  const depth = forward.y < -0.05 && camera.position.y > 0 ? camera.position.y / -forward.y : 10;
  const box = new Box3();
  for (const scale of [0.8, 1.2]) for (const x of [-0.9, 0.9]) for (const y of [-0.9, 0.9]) box.expandByPoint(pointAt(camera, x, y, depth * scale));
  return box;
}

const cornersOf = (box: Box3): Vector3[] =>
  [0, 1, 2, 3, 4, 5, 6, 7].map((i) => new Vector3(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z));

/** Kamera po fitu: tatáž orientace a zorné pole, nová poloha. */
function fitted(camera: PerspectiveCamera, position: Vector3): PerspectiveCamera {
  const moved = camera.clone();
  moved.position.copy(position);
  moved.updateMatrixWorld();
  moved.updateProjectionMatrix();
  return moved;
}

/**
 * Rezervy rohů vůči `playRect` zmenšenému o okraj (NDC): svisle všech rohů `vertical`, do stran rohů `horizontal`.
 * Záporná rezerva = roh mimo; `inFront` = všechny rohy před kamerou.
 */
function slack(camera: PerspectiveCamera, rect: PlayRect, vertical: readonly Vector3[], horizontal: readonly Vector3[]): { readonly min: number; readonly inFront: boolean } {
  const my = (2 * FIT_MARGIN_PX) / rect.canvas.height;
  const mx = (2 * FIT_MARGIN_PX) / rect.canvas.width;
  const ndc = (point: Vector3) => point.clone().project(camera);
  const depth = (point: Vector3) => -point.clone().applyMatrix4(camera.matrixWorldInverse).z;
  const ys = vertical.flatMap((point) => {
    const y = ndc(point).y;
    return [rect.ndc.top - my - y, y - (rect.ndc.bottom + my)];
  });
  const xs = horizontal.map((point) => 1 - mx - Math.abs(ndc(point).x));
  return { min: Math.min(...ys, ...xs), inFront: [...vertical, ...horizontal].every((point) => depth(point) > 0) };
}

const numbersOf = (camera: PerspectiveCamera): number[] => [...camera.position.toArray(), ...camera.quaternion.toArray(), camera.fov, camera.aspect, ...camera.projectionMatrix.elements, ...camera.matrixWorld.elements];

describe('playRect (P64 T2)', () => {
  it('is the canvas without the top HUD band and the bottom controls band, in px and NDC', () => {
    const rect = playRect(PIXEL7, 120, 703);
    expect(rect.canvas).toEqual({ width: 412, height: 839 });
    expect(rect.px).toEqual({ left: 0, top: 120, right: 412, bottom: 703 });
    expect(rect.ndc.left).toBe(-1);
    expect(rect.ndc.right).toBe(1);
    expect(rect.ndc.top).toBeCloseTo(1 - 240 / 839, 12);
    expect(rect.ndc.bottom).toBeCloseTo(1 - 1406 / 839, 12);
  });

  it('clamps the bands to the canvas and never lets them cross', () => {
    expect(playRect(PIXEL7, -5, 900).px).toEqual({ left: 0, top: 0, right: 412, bottom: 839 });
    expect(playRect(PIXEL7, 0, 839).ndc).toEqual({ left: -1, top: 1, right: 1, bottom: -1 });
    expect(playRect(PIXEL7, 500, 400).px).toEqual({ left: 0, top: 500, right: 412, bottom: 500 });
  });
});

describe('fitTall (P64 T2)', () => {
  it('covers the 19 genre cells of the landscape guard', () => {
    expect(GENRE_CELLS).toHaveLength(19);
    for (const project of ['chromium', 'pixel7-touch']) for (const cell of GENRE_CELLS) expect(BASELINE[project]?.[cell.key], `${project} ${cell.key}`).toHaveLength(3);
  });

  it('is the identity on a landscape or desktop canvas: the same numbers, no shift, the camera untouched', () => {
    for (const project of ['chromium', 'pixel7-touch']) {
      for (const cell of GENRE_CELLS) {
        for (const print of BASELINE[project]![cell.key]!) {
          const camera = cameraOf(print.camera);
          expect(camera.aspect).toBeGreaterThanOrEqual(1);
          const before = numbersOf(camera);
          const box = boxSeenBy(camera);
          const size = { width: 1280, height: Math.round(1280 / camera.aspect) };
          // Pásy, se kterými by na výšku fit pohnul kamerou – na šířku nesmí.
          for (const rect of [playRect(size, 120, size.height - 160), playRect(size, 0, size.height)]) {
            for (const opts of [{}, { keep: box.clone().expandByScalar(-0.5) }]) {
              const fit = fitTall(camera, box, rect, opts);
              const at = `${project} ${cell.key} tick ${String(print.tick)}`;
              expect(fit.position.toArray().map((value, i) => Object.is(value, camera.position.getComponent(i))), at).toEqual([true, true, true]);
              expect(fit.shift, at).toBe(0);
              expect(numbersOf(camera), at).toEqual(before);
            }
          }
        }
      }
    }
  });

  it('puts every genre box inside the T1 play rect of a Pixel 7 in portrait, as close as the rect allows', () => {
    for (const cell of GENRE_CELLS) {
      const landscape = cameraOf(BASELINE.chromium![cell.key]![0]!.camera);
      const box = boxSeenBy(landscape);
      const camera = cameraOf(BASELINE.chromium![cell.key]![0]!.camera, PIXEL7.width / PIXEL7.height);
      const before = numbersOf(camera);
      const [top, bottom] = bandsOf(cell.key);
      const rect = playRect(PIXEL7, top, bottom);
      const fit = fitTall(camera, box, rect);
      const corners = cornersOf(box);
      const after = slack(fitted(camera, fit.position), rect, corners, corners);
      expect(after.inFront, cell.key).toBe(true);
      expect(after.min, `${cell.key} box inside the play rect`).toBeGreaterThanOrEqual(-1e-9);
      expect(after.min, `${cell.key} fit is tight`).toBeLessThan(1e-6);
      expect(fit.distance, cell.key).toBeGreaterThan(0);
      expect(numbersOf(camera), `${cell.key} camera untouched`).toEqual(before);
      // Střed `playRect` pod středem plátna (horní pás vyšší než dolní) → záběr dolů, kamera nahoru podél své osy; nad ním naopak.
      expect(Math.sign(fit.shift), cell.key).toBe(Math.sign((top + bottom) / 2 - PIXEL7.height / 2));
    }
  });

  it('does not shift when the bands are zero – only the distance changes', () => {
    for (const cell of GENRE_CELLS) {
      const landscape = cameraOf(BASELINE.chromium![cell.key]![0]!.camera);
      const box = boxSeenBy(landscape);
      const camera = cameraOf(BASELINE.chromium![cell.key]![0]!.camera, PIXEL7.width / PIXEL7.height);
      const rect = playRect(PIXEL7, 0, PIXEL7.height);
      const fit = fitTall(camera, box, rect);
      expect(Math.abs(fit.shift), cell.key).toBe(0);
      const moved = fit.position.clone().sub(camera.position);
      expect(moved.clone().cross(forwardOf(camera)).length(), `${cell.key} moves along the view axis only`).toBeLessThan(1e-9 * Math.max(1, moved.length()));
      const corners = cornersOf(box);
      expect(slack(fitted(camera, fit.position), rect, corners, corners).min, cell.key).toBeGreaterThanOrEqual(-1e-9);
    }
  });

  describe('trimming the sides', () => {
    // Deska 20 m široká, hrdina jezdí v pruhu 4 m uprostřed; kamera shora zepředu, telefon na výšku.
    const board = new Box3(new Vector3(-10, 0, -4), new Vector3(10, 1, 4));
    const lane = new Box3(new Vector3(-2, 0, -4), new Vector3(2, 1, 4));
    const aside = new Box3(new Vector3(5, 0, -4), new Vector3(9, 1, 4));
    const rect = playRect(PIXEL7, 120, 839);
    const camera = (): PerspectiveCamera => {
      const made = new PerspectiveCamera(50, PIXEL7.width / PIXEL7.height, 0.1, 500);
      made.position.set(0, 12, 14);
      made.lookAt(0, 0, 0);
      made.updateMatrixWorld();
      return made;
    };

    it('without keep the whole box stays on the canvas', () => {
      const eye = camera();
      const fit = fitTall(eye, board, rect);
      const corners = cornersOf(board);
      expect(slack(fitted(eye, fit.position), rect, corners, corners).min).toBeGreaterThanOrEqual(-1e-9);
    });

    it.each([
      ['a centred lane', lane],
      ['a lane off to one side', aside],
    ] as const)('with keep only the margin outside %s goes, never the lane itself', (_name, keep) => {
      const eye = camera();
      const whole = fitTall(eye, board, rect);
      const fit = fitTall(eye, board, rect, { keep });
      const view = fitted(eye, fit.position);
      const corners = cornersOf(board);
      // Lane: celá na plátně i s okrajem; deska svisle celá v `playRect`.
      expect(slack(view, rect, [...corners, ...cornersOf(keep)], cornersOf(keep)).min).toBeGreaterThanOrEqual(-1e-9);
      // Okraj desky do stran opravdu odešel a kamera je blíž než bez `keep`.
      expect(Math.max(...corners.map((corner) => Math.abs(corner.clone().project(view).x)))).toBeGreaterThan(1);
      expect(fit.distance).toBeLessThan(whole.distance);
    });
  });

  // P64 T8-R3: celá cílová věž v kvádru odvezla kameru do mlhy (36 palačinek, b64-01). Kamera jako `TimingScene`.
  describe('timing on a tall goal', () => {
    const rect = playRect(PIXEL7, 120, 703);
    const sliderW = TIMING.blockW / UNIT;
    const goalTop = (rounds: number): number => (TIMING.baseH + rounds * TIMING.blockH) / UNIT;
    const timingCamera = (followY: number): PerspectiveCamera => {
      const eye = new PerspectiveCamera(60, PIXEL7.width / PIXEL7.height, 0.1, 70);
      eye.position.set(0, followY + 3.5, -timingDistance(eye.fov, eye.aspect, sliderW));
      eye.lookAt(0, followY, 0);
      eye.updateMatrixWorld();
      return eye;
    };

    // Na startu okno s podstavou couvne o 4 %; celá věž v kvádru couvla o ~100 %.
    it.each([0.6, 12, 21])('a 36-piece goal keeps the camera within 5 % of main (stack at %s m)', (followY) => {
      const eye = timingCamera(followY);
      const box = timingTallBox(new Box3(), followY, goalTop(36), sliderW);
      const forward = new Vector3(0, 0, -1).applyQuaternion(eye.quaternion);
      const before = box.getCenter(new Vector3()).sub(eye.position).dot(forward);
      const fit = fitTall(eye, box, rect, { margin: 0 });
      expect(fit.distance).toBeLessThanOrEqual(before * 1.05);
      // Vršek stohu a příští díl leží svisle v `playRect`.
      const view = fitted(eye, fit.position);
      for (const y of [followY, followY + (2 * TIMING.blockH) / UNIT]) {
        const ndc = new Vector3(0, y, 0).project(view).y;
        expect(ndc).toBeLessThanOrEqual(rect.ndc.top);
        expect(ndc).toBeGreaterThanOrEqual(rect.ndc.bottom);
      }
    });

    it('a short goal keeps its top in the box (T4)', () => {
      const box = timingTallBox(new Box3(), TIMING.baseH / UNIT, goalTop(5), sliderW);
      expect(box.max.y).toBeGreaterThanOrEqual(goalTop(5) + 1);
      expect(box.min.y).toBe(0);
    });
  });

  // T8-R5: kameru krájení na výšku drží šíře pruhů, hrdina a věci se proto zvětší – a pořád se vejdou do pruhu.
  describe('slice portrait scale (T8-R5)', () => {
    it('grows the hero and the thrown things at least 1.3x, the hero still inside its lane, a thing inside half a lane', () => {
      expect(SLICE_TALL.hero).toBeGreaterThanOrEqual(1.3);
      expect(SLICE_TALL.thing).toBeGreaterThanOrEqual(1.3);
      expect(SLICE_SIZES.hero * SLICE_TALL.hero).toBeLessThan(SLICE_SIZES.lane);
      expect(SLICE_SIZES.thing * SLICE_TALL.thing).toBeLessThanOrEqual(SLICE_SIZES.lane / 2);
    });
  });
});
