/**
 * Kamera minigolfu (P68 T8, P70D T3, P71C T1): dívá se po ose kamery `minigolfCameraAxis` – z míčku na cíl trasy, ne
 * po míření (`aux0`), takže míření kamerou nehne. Tah prstu (`minigolf-touch.ts`) se měří proti téže ose.
 *
 * - **V klidu** přehled 3/4: sklon `rest.pitch`° dolů, kamera posunutá na střed krabice z míčku a zbytku trasy od
 *   cíle (`minigolfFocus`) po jamku včetně vlajky; odstup a výška z `fitTall`, takže čím dál jamka, tím výš a dál.
 *   Na výšku do hracího obdélníku (`rect`, nezměřený = celé plátno), na šířku vždy do celého plátna; před prvním
 *   vstupem (`start`) do plochy pod úvodní kartou.
 * - **Míček v pohybu** sleduje z pózy `roll` za ním; na výšku přes `fitTall`, aby míček i cíl ležely v hracím
 *   obdélníku. Cíl = jamka, nebo nejvzdálenější bod trasy, na který je po dráze vidět z místa rány – vybere se jednou
 *   při odpalu, během valení se nemění; když je jamka za rohem, rámuje se roh.
 * - **Přechody** mezi pózami vede `minigolfCameraStep` (P71C T2): jeden plynulý přechod `settle` s, žádné tlumení
 *   honící se za cílem.
 *
 * Póza je čistá funkce bez `window` a bez stavu kresby; scéna x jádra zrcadlí (x scény = −x jádra, jako aréna), takže
 * kladná osa míří na obrazovce doprava. Mimo stav i hash.
 */

import { Box3, MathUtils, PerspectiveCamera, Vector3 } from 'three';

import { BODY, HEADER, UNIT, bodyBase } from '@/play/arcade/contract';
import type { MinigolfLayout } from '@/play/arcade/pieces/minigolf-hole';
import { minigolfAim, minigolfAxisToward } from '@/play/arcade/pieces/minigolf-roll';

import { DIORAMA_FRAMING } from '../../look/framing';
import { type PlayRect, fitTall, playRect } from '../../portrait-frame';

type Point = readonly [number, number];

export const MINIGOLF_CAMERA = {
  /** Zorný úhel plátna (`STAGE_CANVAS` feedu i vlastní plátno). */
  fov: 60,
  /**
   * Klid: sklon pohledu pod vodorovnou (°) a okraj krabice kolem míčku (m, půl dlaždice – vidět i odpaliště).
   * P73D T2: 50° → 26° (`DIORAMA_FRAMING.minigolf`) – jamka i svět kolem v záběru a obzor v horní třetině, dřív
   * malý obdélník uprostřed bílé mlhy.
   */
  rest: { pitch: DIORAMA_FRAMING.minigolf.pitch, around: 2 },
  /** Míček v pohybu: výš a dál, pohled blíž k míčku. */
  roll: { back: 3.6, up: 2.2, ahead: 1.2 },
  /** Krabice na výšku: okraj kolem míčku a cíle (m), výška vlajky nad jamkou (m). */
  pad: 0.6,
  flag: 1.6,
  /** Krok vzorků přímky (jednotky) při hledání bodu trasy, na který je z míčku vidět. */
  sample: 250,
  /** Délka přechodu mezi pózami (s); `delta` snímku nad `maxDelta` s se počítá jako `maxDelta`. */
  settle: 0.8,
  maxDelta: 0.1,
  /** Klidová póza se pohnula o víc (m) než tohle = nový přechod (přeměřený hrací obdélník, zmizelá karta startu). */
  still: 0.05,
} as const;

/**
 * Kamera scény mezi snímky (P71C T2) – jen obraz, mimo stav i hash. `eye` / `look` = kde kamera je; přechod jede
 * z `fromEye` / `fromLook` k živé póze, `t` = sekundy přechodu (≥ `settle` = kamera sedí na póze).
 */
export interface MinigolfCameraRig {
  readonly eye: Vector3;
  readonly look: Vector3;
  readonly fromEye: Vector3;
  readonly fromLook: Vector3;
  /** Póza minulého snímku: v klidu pozná, že se póza pohnula. */
  readonly lastEye: Vector3;
  t: number;
  /** Fáze minulého snímku (`null` = ještě nic nevykresleno) a jeho tik (restart = tik klesl). */
  rolling: boolean | null;
  tick: number;
}

export function minigolfCameraRig(): MinigolfCameraRig {
  return { eye: new Vector3(), look: new Vector3(), fromEye: new Vector3(), fromLook: new Vector3(), lastEye: new Vector3(), t: MINIGOLF_CAMERA.settle, rolling: null, tick: 0 };
}

/**
 * Jeden snímek kamery k póze `pose`. Odpal, zastavení míčku a restart (tik klesl – i první dotek ve feedu, který
 * hru restartuje na tik 0) i klidová póza, která se pohnula, spustí jeden přechod z místa, kde kamera je, k živé
 * póze: `settle` s po křivce smootherstep – první snímky skoro stojí, žádný skok, dojezd bez zákmitu. Mimo přechod
 * kamera sedí na póze (valení: jede s míčkem). Výjimky skáčou v jednom snímku: první snímek a klidová póza, která se
 * pohnula, dokud se čeká na první vstup (`hold`: HUD se při načítání přeskládá – tlumení by ~1 s hýbalo plochou bez
 * vstupu, P68-L T3).
 */
export function minigolfCameraStep(rig: MinigolfCameraRig, pose: MinigolfCameraPose, tick: number, delta: number, hold: boolean): void {
  const { settle, maxDelta, still } = MINIGOLF_CAMERA;
  const first = rig.rolling === null;
  const turn = !first && (tick < rig.tick || pose.rolling !== rig.rolling);
  const moved = !first && !turn && !pose.rolling && rig.t >= settle && pose.position.distanceTo(rig.lastEye) > still;
  rig.rolling = pose.rolling;
  rig.tick = tick;
  rig.lastEye.copy(pose.position);
  if (first || (moved && hold)) rig.t = settle;
  else if (turn || moved) {
    rig.fromEye.copy(rig.eye);
    rig.fromLook.copy(rig.look);
    rig.t = 0;
  } else rig.t = Math.min(settle, rig.t + Math.min(delta, maxDelta));
  const s = MathUtils.smootherstep(rig.t, 0, settle);
  rig.eye.lerpVectors(rig.fromEye, pose.position, s);
  rig.look.lerpVectors(rig.fromLook, pose.look, s);
}

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

/** Míček ze stavu (jednotky jádra): poloha, místo poslední rány (`respawnX/Z`) a jestli se valí. */
function ballOf(state: ArrayLike<number>): { readonly x: number; readonly z: number; readonly fromX: number; readonly fromZ: number; readonly rolling: boolean } {
  const p = bodyBase(state[HEADER.player] as number);
  const rolling = (state[p + BODY.vx] as number) !== 0 || (state[p + BODY.vz] as number) !== 0;
  return { x: state[p + BODY.x] as number, z: state[p + BODY.z] as number, fromX: state[HEADER.respawnX] as number, fromZ: state[HEADER.respawnZ] as number, rolling };
}

/**
 * Osa kamery (P71C T1) v tvaru osy míření jádra: směr z míčku na cíl trasy (`minigolfFocus`); míček v pohybu z místa
 * rány, takže se osa během valení nemění. Míření (`aux0`) ji nehýbe – tah prstu se měří proti ní (`MinigolfTouch`).
 */
export function minigolfCameraAxis(state: ArrayLike<number>, course: MinigolfCourseView): number {
  const { origin, focus } = aimedOf(ballOf(state), course);
  return minigolfAxisToward(focus[0] - origin[0], focus[1] - origin[1]);
}

/** Odkud kamera míří (míček, při valení místo rány) a cíl trasy odtud – při valení vybraný jednou, při odpalu. */
function aimedOf(ball: ReturnType<typeof ballOf>, course: MinigolfCourseView): { readonly origin: Point; readonly focus: Point } {
  const origin: Point = ball.rolling ? [ball.fromX, ball.fromZ] : [ball.x, ball.z];
  return { origin, focus: minigolfFocus(course, origin[0], origin[1]) };
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
 * Póza kamery ze stavu: míček (hráč) a osa kamery (`minigolfCameraAxis`), pohyb podle `vx/vz`. `rect` = hrací obdélník
 * plátna (`usePlayRectRef`), `null` = nezměřený – pak póza bez fitu. `fov` = zorný úhel kamery plátna. `start` = plocha
 * pod úvodní kartou (P71C T2), dokud se čeká na první vstup: klidový přehled se rámuje do ní na výšku i na šířku.
 */
export function minigolfCameraPose(state: ArrayLike<number>, aspect: number, rect: PlayRect | null, course: MinigolfCourseView, fov: number = MINIGOLF_CAMERA.fov, start: PlayRect | null = null): MinigolfCameraPose {
  const at = ballOf(state);
  const { x, z, rolling } = at;
  const [ax, az] = minigolfAim(minigolfCameraAxis(state, course));
  const ball = new Vector3(-x / UNIT, 0, z / UNIT);
  const ahead = new Vector3(-ax, 0, az).normalize();
  const { focus } = aimedOf(at, course);
  const { camera, box, corner } = scratch;
  const pad = MINIGOLF_CAMERA.pad;
  /** Do krabice čtverec ±`r` m kolem bodu scény (`sx`, `sz`) od země do výšky `h` m. */
  const take = (sx: number, sz: number, r: number, h: number): void => {
    box.expandByPoint(corner.set(sx - r, 0, sz - r)).expandByPoint(corner.set(sx + r, h, sz + r));
  };
  /** Kamera z `position` na `look`, fitem posunutá tak, aby krabice ležela v `frame`; orientace drží. */
  const fit = (position: Vector3, look: Vector3, frame: PlayRect): { position: Vector3; look: Vector3 } => {
    camera.fov = fov;
    camera.aspect = aspect;
    camera.updateProjectionMatrix();
    camera.position.copy(position);
    camera.lookAt(look);
    camera.updateMatrixWorld();
    const fitted = fitTall(camera, box, frame, { anyAspect: true }).position;
    return { position: fitted, look: look.add(fitted.clone().sub(position)) };
  };
  box.makeEmpty();

  if (!rolling) {
    take(ball.x, ball.z, MINIGOLF_CAMERA.rest.around, pad);
    const from = Math.max(0, course.route.findIndex(([rx, rz]) => rx === focus[0] && rz === focus[1]));
    for (const [rx, rz] of [...course.route.slice(from), course.hole]) take(-rx / UNIT, rz / UNIT, pad, MINIGOLF_CAMERA.flag);
    const pitch = MathUtils.degToRad(MINIGOLF_CAMERA.rest.pitch);
    const look = box.getCenter(new Vector3());
    const position = look.clone().addScaledVector(ahead, -Math.cos(pitch)).setY(look.y + Math.sin(pitch));
    const frame = start ?? (aspect < 1 && rect !== null ? rect : playRect({ width: aspect * 1000, height: 1000 }, 0, 1000));
    return { ...fit(position, look, frame), focus, rolling };
  }

  const view = MINIGOLF_CAMERA.roll;
  const position = ball.clone().addScaledVector(ahead, -view.back).setY(view.up);
  const look = ball.clone().addScaledVector(ahead, view.ahead);
  if (!(aspect < 1) || rect === null) return { position, look, focus, rolling };
  take(ball.x, ball.z, pad, pad);
  take(-focus[0] / UNIT, focus[1] / UNIT, pad, MINIGOLF_CAMERA.flag);
  return { ...fit(position, look, rect), focus, rolling };
}
