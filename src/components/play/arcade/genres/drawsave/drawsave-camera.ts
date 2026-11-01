/**
 * Kamera hry kresli a zachraň (P68-S T14): pevná deska z boku (`side`, `P68_VIEWS`) a buňky pro prst.
 *
 * **Souřadnice scény:** deska stojí svisle v rovině z = 0, scéna ji kreslí ve skupině otočené o π kolem svislé osy,
 * takže bod jádra (x, y) leží ve scéně v (−x, y, 0). Kamera kouká po +z jako ostatní scény (slunce a rig s tím
 * počítají): sloupec 0 je vlevo, řada 0 nahoře – přesně jak mřížku 8 × 12 čte `cellAxisAt` (`lanes-input.ts`).
 *
 * **Bez zkreslení:** kamera kouká kolmo na rovinu desky (bez náklonu), takže se deska promítne podobností – každá
 * buňka je na plátně stejně velký čtverec a `data-lane-cells` (`cellsAttr`) je přesný obraz desky, ne náhrada
 * jako u šikmé kamery stavby. Póza se proto počítá přímo: měřítko (px na m) z rámu, z něj vzdálenost, a posun
 * kamery v rovině tak, aby spodní hrana desky ležela na spodní hraně rámu a deska uprostřed do stran.
 *
 * **Rám:** krabice = deska a nad ní pruh `VIEW.strip` s ukazatelem inkoustu a času. Na výšku (`aspect < 1`) hrací
 * obdélník z `usePlayRectRef` bez okrajů, deska sedí dole u palce a nad ní zbude nebe, odkud hrozby padají. Na šířku
 * sloupec mezi rohy HUD od horní hrany plátna po dolní pás hracího obdélníku (dolní řada HUD vede přes celou šířku,
 * vzor `buildshift-camera.ts`). Dvanáct řad se na nízké plátno (telefon na šířku 343–390 px, iPhone 15 na výšku
 * 659 px) po 44 px nevejde: buňka tam vyplní volnou výšku (test pinuje nejmenší velikost).
 */

import { MathUtils, type PerspectiveCamera, Vector3 } from 'three';

import { size, space } from '@/brand/tokens';
import { UNIT } from '@/play/arcade/contract';
import { BOARD_TOP, DRAWSAVE, HALF_WIDTH } from '@/play/arcade/pieces/drawsave-world';

import { FIT_MARGIN_PX, type FrameRect, type PlayRect, playRect } from '../../portrait-frame';

/** Plátno v CSS px. */
export interface Canvas {
  readonly width: number;
  readonly height: number;
}

export const VIEW = {
  /** Svislý zorný úhel (°): deska je rovina kolmo k pohledu, úhel mění jen hloubku země a těl. */
  fov: 40,
  /** Pruh nad deskou (m): ukazatel inkoustu a času kreslení či obrany. */
  strip: 0.6,
  /** Na výšku deska nad spodní hranou hracího obdélníku o tolik px (palec, gesto systému). */
  bottomInset: space['4'],
  /** Na šířku: rezerva rohů HUD do stran (pilulka postupu, časovač s pauzou) a okraj nahoře a dole. */
  cornerPx: 240,
  edgePx: space['2'],
} as const;

/** Mřížka: sloupce, řady, buňka (m). */
export const GRID = { cols: DRAWSAVE.cols, rows: DRAWSAVE.rows, cell: DRAWSAVE.cell / UNIT } as const;

/** Krabice, kterou kamera rámuje (m, scéna): šířka a výška desky s pruhem; spodní hrana je země (y = 0). */
export const BOARD_BOX = { width: (2 * HALF_WIDTH) / UNIT, height: BOARD_TOP / UNIT + VIEW.strip } as const;

/** Bod jádra → scéna (skupina desky je otočená o π). */
export const sceneX = (x: number): number => -x / UNIT;
export const sceneY = (y: number): number => y / UNIT;

/** Rám desky na plátně (px, y dolů) podle orientace; `rect` = hrací obdélník (na šířku se z něj čte jen dolní pás). */
export function boardFrame(canvas: Canvas, rect: PlayRect): FrameRect {
  if (canvas.width >= canvas.height) {
    const corner = Math.min(VIEW.cornerPx, canvas.width / 4);
    return { left: corner, top: VIEW.edgePx, right: canvas.width - corner, bottom: Math.min(canvas.height, rect.px.bottom) - VIEW.edgePx };
  }
  return { left: FIT_MARGIN_PX, top: rect.px.top + FIT_MARGIN_PX, right: canvas.width - FIT_MARGIN_PX, bottom: rect.px.bottom - VIEW.bottomInset };
}

/** Hrací obdélník na výšku, dokud ho `usePlayRect` nezměří: pod pásem pilulek HUD až po spodní hranu. */
export const tallFallback = (canvas: Canvas): PlayRect => playRect(canvas, space['4'] + size['hud-pill'] + space['3'], canvas.height);

/**
 * Postaví kameru: zorný úhel, polohu a orientaci (kolmo na desku, matice světa aktualizované). Krabice desky se
 * vepíše do rámu `boardFrame` co největší, spodní hranou na spodní hranu rámu, do stran doprostřed.
 */
export function placeCamera(camera: PerspectiveCamera, canvas: Canvas, rect: PlayRect): void {
  if (camera.fov !== VIEW.fov) {
    camera.fov = VIEW.fov;
    camera.updateProjectionMatrix();
  }
  const frame = boardFrame(canvas, rect);
  const t = Math.tan(MathUtils.degToRad(VIEW.fov) / 2);
  const scale = Math.max(1e-3, Math.min((frame.right - frame.left) / BOARD_BOX.width, (frame.bottom - frame.top) / BOARD_BOX.height));
  const distance = canvas.height / (2 * t * scale);
  // Kamera kouká po +z, takže vpravo na plátně je −x: střed desky (x = 0) padne na střed rámu, když kamera stojí v x.
  const x = ((frame.left + frame.right) / canvas.width - 1) * distance * t * camera.aspect;
  // Spodní hrana desky (y = 0) na spodní hraně rámu.
  const y = -(1 - (2 * frame.bottom) / canvas.height) * distance * t;
  camera.position.set(x, y, -distance);
  camera.lookAt(x, y, 0);
  camera.updateMatrixWorld();
}

/**
 * `data-lane-cells` pro kameru: „sloupce,řady,vlevo,nahoře,vpravo,dole“ ve zlomcích plátna – promítnuté rohy desky
 * (levý horní roh na plátně je sloupec 0, řada 0). Zlomky na celé px plátna, takže se atribut mění, jen když se
 * mřížka opravdu pohne.
 */
export function cellsAttr(camera: PerspectiveCamera, canvas: Canvas): string {
  const probe = new Vector3();
  const corner = (x: number, y: number): { readonly x: number; readonly y: number } => {
    probe.set(sceneX(x), sceneY(y), 0).project(camera);
    return { x: (probe.x + 1) / 2, y: (1 - probe.y) / 2 };
  };
  const topLeft = corner(-HALF_WIDTH, BOARD_TOP);
  const bottomRight = corner(HALF_WIDTH, 0);
  const snap = (fraction: number, px: number): string => (Math.round(fraction * px) / px).toFixed(4);
  return [String(GRID.cols), String(GRID.rows), snap(topLeft.x, canvas.width), snap(topLeft.y, canvas.height), snap(bottomRight.x, canvas.width), snap(bottomRight.y, canvas.height)].join(',');
}

/** Hloubka desky před kamerou (m) – odtud scéna posouvá mlhu a vzdálenou rovinu. */
export const reachOf = (camera: PerspectiveCamera): number => Math.abs(camera.position.z);
