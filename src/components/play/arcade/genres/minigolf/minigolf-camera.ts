/**
 * Kamera minigolfu (P68 T8): přes rameno nízko za míčkem, dívá se po ose míření ze stavu (`aux0` míčku, ne z prstu).
 * Míček v pohybu sleduje z vyšší a vzdálenější pózy, po zastavení se vrátí nízko za něj (přechod tlumí scéna).
 *
 * - **Na výšku** (`aspect < 1`) jede póza přes `fitTall` (`portrait-frame.ts`), aby míček i cíl ležely v hracím
 *   obdélníku mezi horním pásem HUD a dolní řadou. Cíl = jamka, nebo nejvzdálenější bod trasy, na který je z míčku
 *   vidět po dráze (`minigolfFocus`) – když je jamka za rohem, rámuje se roh.
 * - **Na šířku** vlastní póza, `rect` ji nemění.
 *
 * Čistá funkce bez `window` a bez stavu kresby; scéna x jádra zrcadlí (x scény = −x jádra, jako aréna), takže
 * kladná osa míří na obrazovce doprava. Mimo stav i hash.
 */

import { Box3, PerspectiveCamera, Vector3 } from 'three';

import { BODY, HEADER, UNIT, bodyBase } from '@/play/arcade/contract';
import type { MinigolfLayout } from '@/play/arcade/pieces/minigolf-hole';
import { minigolfAim } from '@/play/arcade/pieces/minigolf-roll';

import { type PlayRect, fitTall } from '../../portrait-frame';

type Point = readonly [number, number];

export const MINIGOLF_CAMERA = {
  /** Zorný úhel plátna (`STAGE_CANVAS` feedu i vlastní plátno). */
  fov: 60,
  /** Klid: kamera `back` m za míčkem, `up` m nad zemí, dívá se na bod `ahead` m před míčkem. */
  rest: { back: 2.6, up: 1.1, ahead: 2.2 },
  /** Míček v pohybu: výš a dál, pohled blíž k míčku. */
  roll: { back: 3.6, up: 2.2, ahead: 1.2 },
  /** Krabice na výšku: okraj kolem míčku a cíle (m), výška vlajky nad jamkou (m). */
  pad: 0.6,
  flag: 1.6,
  /** Krok vzorků přímky (jednotky) při hledání bodu trasy, na který je z míčku vidět. */
  sample: 250,
} as const;

/** Statická část jamky pro kameru (jednotky jádra): jamka, trasa (rohy, pak jamka) a dlaždice dráhy. */
export interface MinigolfCourseView {
  readonly hole: Point;
  readonly route: readonly Point[];
  readonly floor: readonly { readonly x: number; readonly z: number; readonly w: number; readonly d: number }[];
}

export function minigolfCourseView(initial: ArrayLike<number>, layout: MinigolfLayout): MinigolfCourseView {
  const at = (index: number, slot: number): number => initial[bodyBase(index) + slot] as number;
  const floor = Array.from({ length: layout.floor[1] }, (_, k) => {
    const tile = layout.floor[0] + k;
    return { x: at(tile, BODY.x), z: at(tile, BODY.z), w: at(tile, BODY.w), d: at(tile, BODY.d) };
  });
  return { hole: [at(layout.hole, BODY.x), at(layout.hole, BODY.z)], route: layout.route.map(([x, z]): Point => [x, z]), floor };
}

const onFloor = (course: MinigolfCourseView, x: number, z: number): boolean => course.floor.some((tile) => Math.abs(2 * (x - tile.x)) <= tile.w && Math.abs(2 * (z - tile.z)) <= tile.d);

/** Vede z bodu (`x`, `z`) k `to` přímka celá po dráze (vzorky po `sample`)? */
function inSight(course: MinigolfCourseView, x: number, z: number, to: Point): boolean {
  const steps = Math.max(1, Math.ceil(Math.hypot(to[0] - x, to[1] - z) / MINIGOLF_CAMERA.sample));
  for (let k = 0; k <= steps; k += 1) {
    if (!onFloor(course, x + ((to[0] - x) * k) / steps, z + ((to[1] - z) * k) / steps)) return false;
  }
  return true;
}

/** Cíl kamery z míčku na (`x`, `z`): nejvzdálenější bod trasy, na který je po dráze vidět (jamka, jinak roh). */
export function minigolfFocus(course: MinigolfCourseView, x: number, z: number): Point {
  for (let k = course.route.length - 1; k >= 0; k -= 1) {
    const point = course.route[k] as Point;
    if (inSight(course, x, z, point)) return point;
  }
  return course.route[0] as Point;
}

export interface MinigolfCameraPose {
  /** Poloha kamery a bod, na který se dívá (scéna, m). Na výšku posunuté fitem o týž vektor – orientace drží. */
  readonly position: Vector3;
  readonly look: Vector3;
  /** Cíl záběru na výšku (jednotky jádra): jamka, nebo bod trasy za rohem. */
  readonly focus: Point;
  readonly rolling: boolean;
}

const scratch = { camera: new PerspectiveCamera(MINIGOLF_CAMERA.fov, 1, 0.1, 500), box: new Box3(), corner: new Vector3() };

/**
 * Póza kamery ze stavu: míček (hráč) a jeho míření (`aux0`), pohyb podle `vx/vz`. `rect` = hrací obdélník plátna
 * (`usePlayRectRef`), `null` = nezměřený – pak póza bez fitu. `fov` = zorný úhel kamery plátna.
 */
export function minigolfCameraPose(state: ArrayLike<number>, aspect: number, rect: PlayRect | null, course: MinigolfCourseView, fov: number = MINIGOLF_CAMERA.fov): MinigolfCameraPose {
  const p = bodyBase(state[HEADER.player] as number);
  const x = state[p + BODY.x] as number;
  const z = state[p + BODY.z] as number;
  const rolling = (state[p + BODY.vx] as number) !== 0 || (state[p + BODY.vz] as number) !== 0;
  const [ax, az] = minigolfAim(state[p + BODY.aux0] as number);
  const ball = new Vector3(-x / UNIT, 0, z / UNIT);
  const ahead = new Vector3(-ax, 0, az).normalize();
  const view = rolling ? MINIGOLF_CAMERA.roll : MINIGOLF_CAMERA.rest;
  const position = ball.clone().addScaledVector(ahead, -view.back).setY(view.up);
  const look = ball.clone().addScaledVector(ahead, view.ahead);
  const focus = minigolfFocus(course, x, z);
  if (!(aspect < 1) || rect === null) return { position, look, focus, rolling };

  const { camera, box, corner } = scratch;
  camera.fov = fov;
  camera.aspect = aspect;
  camera.updateProjectionMatrix();
  camera.position.copy(position);
  camera.lookAt(look);
  camera.updateMatrixWorld();
  const pad = MINIGOLF_CAMERA.pad;
  box.makeEmpty();
  box.expandByPoint(corner.set(ball.x - pad, 0, ball.z - pad)).expandByPoint(corner.set(ball.x + pad, MINIGOLF_CAMERA.pad, ball.z + pad));
  box.expandByPoint(corner.set(-focus[0] / UNIT - pad, 0, focus[1] / UNIT - pad)).expandByPoint(corner.set(-focus[0] / UNIT + pad, MINIGOLF_CAMERA.flag, focus[1] / UNIT + pad));
  const fitted = fitTall(camera, box, rect).position;
  return { position: fitted, look: look.add(fitted.clone().sub(position)), focus, rolling };
}
