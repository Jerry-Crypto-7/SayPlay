/**
 * Kamera závodu s triky (P68V T4, pohled `chase` z `P68_VIEWS`): za autem a nad ním, dívá se dopředu po trati.
 * Čistá funkce stavu a poměru stran – žádné `window`, žádná paměť mezi snímky; scéna ji volá ve `useFrame`.
 *
 * - **Na šířku** vlastní póza: kamera `back` m za autem a `up` m nad zemí, do strany jde za autem jen z části
 *   (`follow`), míří `ahead` m před auto na osu trati – zatáčka před autem je v záběru. Hrací obdélník ji nemění.
 * - **Na výšku** (`aspect < 1`) táž póza (nižší sklon, blíž), pak `fitTall` (`portrait-frame.ts`) dojede po ose pohledu
 *   a nahoru, až krabice hry – auto a `frame.ahead` m trati před ním (osa ± `frame.half`) – leží v hracím obdélníku
 *   mezi horním pásem HUD a tlačítkem brzdy. Bod pohledu jede o týž vektor, takže `lookAt` na něj fit nevrátí.
 * - **Ve skoku** kamera stoupá s autem a o `air.lift` navíc na metr výšky, bod pohledu o `air.look` – výška auta je
 *   spojitá (balistika jádra), takže i kamera stoupá a klesá plynule.
 * - **Po nárazu** (milost `stunt_crash`, `graceOf`) krátký tlumený otřes `shake.ticks` tiků; směr z tiků milosti, ne
 *   z náhody, takže týž záznam třese stejně. `reduced` (`prefers-reduced-motion`, čte scéna) ho vypne.
 *
 * Jen obraz: stav čte, nic nezapisuje, hash se nehne. Metry scény, x zrcadlené jako těla (`-x` jádra).
 */

import { Box3, PerspectiveCamera, Vector3 } from 'three';

import { type ArcadeState, BODY, HEADER, UNIT, bodyBase, graceOf } from '@/play/arcade/contract';
import { STUNT } from '@/play/arcade/pieces/stunt-track';

import { type PlayRect, fitTall } from '../../portrait-frame';

export const STUNT_CAMERA = {
  /** Úhel pohledu plátna (`STAGE_CANVAS`, `FreshCamera`). */
  fov: 60,
  near: 0.1,
  /** Póza na šířku (m): výška, odstup, kam míří, výška bodu pohledu; podíl, kterým jde kamera a bod pohledu za autem. */
  wide: { up: 2.9, back: 6.8, ahead: 11, lookUp: 0.9, follow: 0.8, followLook: 0.5 },
  /** Póza na výšku před fitem: blíž a níž, ať je auto čitelné (`LEGIBLE_SHARE.hero`) a 30 m trati se vejde nad brzdu. */
  tall: { up: 3.2, back: 5.6, ahead: 12, lookUp: 0.6, follow: 0.7, followLook: 0.5 },
  /** Ve vzduchu: kamera navíc o `lift` m a bod pohledu o `look` m na metr výšky auta. */
  air: { lift: 0.5, look: 0.6 },
  /** Krabice fitu na výšku (m): okraj kolem auta, kus za ním, trať `ahead` m před ním po `step` m a `half` m od osy. */
  frame: { pad: 0.3, behind: 0.5, top: 0.4, ahead: 30, step: 5, half: 1 },
  /** Otřes po nárazu: tolik tiků od začátku milosti, nejvýš tolik metrů. */
  shake: { ticks: 15, metres: 0.2 },
} as const;

/** Osa trati ve scéně (m, x zrcadlené): střed silnice v místě `z` (`stripCurve` nad `roadShapeOf`). */
export type StuntRoad = (z: number) => { readonly center: number };

export interface StuntCameraOptions {
  /** Stav před posledním tikem a podíl rozběhnutého tiku – auto se kreslí interpolované, kamera s ním. */
  readonly prev?: ArcadeState;
  readonly alpha?: number;
  /** Osa trati; bez ní kamera míří rovně před auto. */
  readonly road?: StuntRoad;
  readonly fov?: number;
  /** `prefers-reduced-motion`: bez otřesu. */
  readonly reduced?: boolean;
}

export interface StuntCameraPose {
  readonly position: Vector3;
  /** Bod pohledu: `camera.lookAt(look)` dá orientaci, se kterou se fitovalo. */
  readonly look: Vector3;
}

/** Skok dál než tohle (m) mezi tiky je restart, ne jízda – neinterpoluje se. */
const JUMP_M = 5;

const scratch = new PerspectiveCamera();
const box = new Box3();
const point = new Vector3();

/** Auto ve scéně (m): spodní střed interpolovaný mezi `prev` a `state`, rozměry ze stavu. Scéna kreslí auto odsud, kamera míří sem. */
export function stuntCarAt(state: ArcadeState, prev: ArcadeState | undefined, alpha: number): { readonly x: number; readonly y: number; readonly z: number; readonly w: number; readonly h: number; readonly d: number } {
  const p = bodyBase(state[HEADER.player] as number);
  const now = (slot: number): number => (state[p + slot] as number) / UNIT;
  const before = (slot: number): number => ((prev ?? state)[p + slot] as number) / UNIT;
  const fresh = Math.abs(now(BODY.z) - before(BODY.z)) > JUMP_M;
  const at = (slot: number): number => (fresh ? now(slot) : before(slot) + (now(slot) - before(slot)) * alpha);
  return { x: -at(BODY.x), y: at(BODY.y), z: at(BODY.z), w: now(BODY.w), h: now(BODY.h), d: now(BODY.d) };
}

/**
 * Póza kamery za autem pro stav `state` a poměr stran plátna `aspect`. `rect` = hrací obdélník (`usePlayRectRef`);
 * `null` = ještě nezměřený – na výšku pak zůstane póza před fitem. Na šířku se `rect` nečte.
 */
export function stuntCameraPose(state: ArcadeState, aspect: number, rect: PlayRect | null, options: StuntCameraOptions = {}): StuntCameraPose {
  const car = stuntCarAt(state, options.prev, options.alpha ?? 1);
  const road = options.road ?? (() => ({ center: car.x }));
  const tall = aspect < 1;
  const view = tall ? STUNT_CAMERA.tall : STUNT_CAMERA.wide;
  const { air } = STUNT_CAMERA;
  const here = road(car.z).center;
  const there = road(car.z + view.ahead).center;
  const position = new Vector3(here + (car.x - here) * view.follow, view.up + car.y * (1 + air.lift), car.z - view.back);
  const look = new Vector3(car.x + (there - car.x) * view.followLook, view.lookUp + car.y * air.look, car.z + view.ahead);

  if (tall && rect !== null) {
    scratch.fov = options.fov ?? STUNT_CAMERA.fov;
    scratch.aspect = aspect;
    scratch.near = STUNT_CAMERA.near;
    scratch.zoom = 1;
    scratch.position.copy(position);
    scratch.lookAt(look);
    scratch.updateMatrixWorld();
    const { frame } = STUNT_CAMERA;
    box.min.set(car.x - car.w / 2 - frame.pad, car.y, car.z - car.d / 2 - frame.behind);
    box.max.set(car.x + car.w / 2 + frame.pad, car.y + car.h + frame.top, car.z + car.d / 2);
    for (let ahead = 0; ahead <= frame.ahead; ahead += frame.step) {
      const center = road(car.z + ahead).center;
      box.expandByPoint(point.set(center - frame.half, 0, car.z + ahead));
      box.expandByPoint(point.set(center + frame.half, 0, car.z + ahead));
    }
    const fitted = fitTall(scratch, box, rect).position;
    look.add(point.subVectors(fitted, position));
    position.copy(fitted);
  }

  const grace = graceOf(state, state[HEADER.player] as number);
  const since = STUNT.crash.grace - grace;
  const { shake } = STUNT_CAMERA;
  if (options.reduced !== true && grace > 0 && since < shake.ticks) {
    const amount = (1 - since / shake.ticks) ** 2 * shake.metres;
    point.set(Math.sin(since * 2.3) * amount, Math.cos(since * 3.1) * amount * 0.6, 0);
    position.add(point);
    look.add(point);
  }
  return { position, look };
}
