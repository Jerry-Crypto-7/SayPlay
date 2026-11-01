/**
 * Kamera střelnice z očí (P68-F T5). Čisté funkce bez React a R3F: scéna z nich staví kameru, dotykový adaptér a e2e
 * z nich přepočítají bod na obrazovce na sektor a zpět. Hra kameru nikdy nečte – póza je jen obraz natočení `yawStep`
 * ze stavu (`railfps-world.ts`), interpolovaný podílem tiku kresby.
 *
 * **Oko** stojí nad počátkem ve výšce prostředního řádku (`EYE_HEIGHT`), bez naklánění. Kladné natočení je doprava:
 * +x jádra. Scéna x zrcadlí (`scenePoint`), protože kamera kouká po +z a +x světa by jinak leželo vlevo.
 *
 * **Svislé pole** na výšku (`aspect < 1`) a na šířku zvlášť (`RAILFPS_VIEW`), nikdy užší, než aby pás hry
 * (`playRect` z `portrait-frame.ts`: mezi horním HUD a zónou palce) ukázal všechny řádky výšky: střed každého řádku
 * ve vzdálenosti `RAILFPS.reach` a celý terč v nejbližší vzdálenosti nástupu. Horizont oka padne doprostřed pásu
 * posunem záběru (`shift` pro `setViewOffset`), takže svislice zůstanou svislé.
 */

import type { PerspectiveCamera } from 'three';

import { space } from '@/brand/tokens';
import { UNIT } from '@/play/arcade/contract';
import { EYE_HEIGHT, HEIGHT_ROWS, RAILFPS, YAW } from '@/play/arcade/pieces/railfps-world';

import type { PlayRect } from '../../portrait-frame';

/** Stupňů na jeden krok `yawStep` (3,75°). */
export const STEP_DEG = YAW.stepDeg / YAW.stepsPerSector;
/** Výška oka (m). */
export const EYE_M = EYE_HEIGHT / UNIT;

/**
 * Svislé zorné pole celého plátna (°). Na výšku 68°: na Pixel 7 (412 × 839) je vidět 2,4 sektoru (aktuální a středy
 * obou sousedních) a nepřítel ve 22 m doroste na `LEGIBLE_SHARE.target` se zvětšením 1,9 (strop `LEGIBLE_CAP` 2).
 * Na šířku 50°: na 1280 × 720 je vidět 5,3 sektoru a nepřítel ve 22 m potřebuje zvětšení 1,3.
 */
export const RAILFPS_VIEW = { tallFovDeg: 68, wideFovDeg: 50 } as const;

/** Okraj mezi řádky a hranou pásu hry (`--sp-space-2`, jako `FIT_MARGIN_PX` v `portrait-frame.ts`). */
const MARGIN_PX = space['2'];

/**
 * Míry scény, které čte i test čitelnosti (T9): zábrany stojí za místem nástupu nepřátel (m), značka sektoru je
 * krátký klín na podlaze kousek za obloukem dosahu (m; T10 – klín až po zábrany byl z oka vysoký žlutý pruh),
 * zaměřovač je prstenec o poloměru `crosshairPx` (px).
 */
export const RAILFPS_LAYOUT = {
  barrier: RAILFPS.enemyFar / UNIT + 2,
  markNear: RAILFPS.reach / UNIT + 0.1,
  markFar: RAILFPS.reach / UNIT + 3,
  crosshairPx: space['4'],
} as const;

/**
 * Největší tangenta nad i pod horizontem, kterou pás hry musí ukázat: střed každého řádku na dosah nepřítele
 * a celý terč (± půl výšky) v nejbližší vzdálenosti, kde terč vzniká.
 */
const ROWS_TAN = Math.max(
  ...HEIGHT_ROWS.map((row) => Math.abs(row - EYE_HEIGHT) / RAILFPS.reach),
  ...HEIGHT_ROWS.map((row) => (Math.abs(row - EYE_HEIGHT) + RAILFPS.target.h / 2) / RAILFPS.targetNear),
);

const toRad = (deg: number): number => (deg * Math.PI) / 180;
const toDeg = (rad: number): number => (rad * 180) / Math.PI;
const halfTan = (fovDeg: number): number => Math.tan(toRad(fovDeg) / 2);

export interface RailfpsPose {
  /** Oko ve scéně (m). */
  readonly position: { readonly x: number; readonly y: number; readonly z: number };
  /** Natočení (°), kladné doprava; sektor `s` má střed v `s × 15°`. */
  readonly yawDeg: number;
  /** Svislé zorné pole celého plátna (°). */
  readonly fovDeg: number;
  /** Posun záběru (px) pro `setViewOffset(w, h, 0, shift, w, h)`: horizont oka uprostřed pásu hry. */
  readonly shift: number;
}

/**
 * Póza kamery z natočení předchozího a tohoto tiku (`yawStep` −16..16) a podílu tiku kresby `t` (0..1). `aspect`
 * vybere pole na výšku či na šířku, `rect` je pás hry plátna. Čistá funkce: týž vstup, tatáž póza.
 */
export function cameraPose(fromStep: number, toStep: number, t: number, aspect: number, rect: PlayRect): RailfpsPose {
  const base = halfTan(aspect < 1 ? RAILFPS_VIEW.tallFovDeg : RAILFPS_VIEW.wideFovDeg);
  const half = rect.canvas.height / 2;
  const room = (rect.px.bottom - rect.px.top) / 2 - MARGIN_PX;
  // Pás menší než okraje: řádky se nevejdou nikam, zůstane pole orientace.
  const tan = room > 0 ? Math.max(base, (ROWS_TAN * half) / room) : base;
  return {
    position: { x: 0, y: EYE_M, z: 0 },
    yawDeg: (fromStep + (toStep - fromStep) * t) * STEP_DEG,
    fovDeg: toDeg(2 * Math.atan(tan)),
    shift: half - (rect.px.top + rect.px.bottom) / 2,
  };
}

/**
 * Řádek plátna (px od horní hrany), kde póza kreslí bod ve výšce `heightM` ve vodorovné vzdálenosti `distanceM` před
 * okem; `height` je výška plátna. Horizont oka leží uprostřed pásu hry (`shift`), bez naklánění nezávisí na sloupci.
 */
export const screenRowOf = (heightM: number, distanceM: number, pose: RailfpsPose, height: number): number =>
  height / 2 - pose.shift + ((EYE_M - heightM) / distanceM / halfTan(pose.fovDeg)) * (height / 2);

/** Postaví kameru podle pózy; `width × height` je plátno (CSS px). Poměr stran kamery drží R3F. */
export function applyPose(camera: PerspectiveCamera, pose: RailfpsPose, width: number, height: number): void {
  camera.position.set(pose.position.x, pose.position.y, pose.position.z);
  // Kamera kouká po −z; otočení o π − yaw ji pošle po (−sin yaw, 0, cos yaw), tedy doprava k −x scény = +x jádra.
  camera.rotation.set(0, Math.PI - toRad(pose.yawDeg), 0);
  camera.fov = pose.fovDeg;
  camera.setViewOffset(width, height, 0, pose.shift, width, height);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld();
}

/** Bod jádra (jednotky) ve scéně (m): x zrcadlené, aby +x jádra bylo na obrazovce vpravo. */
export const scenePoint = (x: number, y: number, z: number): { readonly x: number; readonly y: number; readonly z: number } => ({ x: -x / UNIT, y: y / UNIT, z: z / UNIT });

/** Sektor (−4..4) směru `yawDeg`; hrana sektoru patří vnitřnímu, jako `sectorOf` jádra. */
export function sectorOfYaw(yawDeg: number): number {
  const v = yawDeg / YAW.stepDeg;
  const sector = Math.sign(v) * Math.ceil(Math.abs(v) - 0.5);
  return Math.max(-YAW.maxSector, Math.min(YAW.maxSector, sector)) + 0;
}

/** Úhel (°) sloupce obrazovky `ndcX` (−1..1) od osy kamery, kladný doprava. Bez naklánění nezávisí na výšce bodu. */
export const screenAngle = (ndcX: number, aspect: number, fovDeg: number): number => toDeg(Math.atan(ndcX * halfTan(fovDeg) * aspect));

/** Sektor pod sloupcem obrazovky `ndcX` při natočení kamery `cameraYawDeg`. */
export const screenToSector = (ndcX: number, cameraYawDeg: number, aspect: number, fovDeg: number): number => sectorOfYaw(cameraYawDeg + screenAngle(ndcX, aspect, fovDeg));

/** Sloupec obrazovky (`ndcX`), kde kamera kreslí střed sektoru, nebo `null`, když je mimo obraz. */
export function sectorToScreen(sector: number, cameraYawDeg: number, aspect: number, fovDeg: number): number | null {
  const off = sector * YAW.stepDeg - cameraYawDeg;
  if (Math.abs(off) >= 90) return null;
  const x = Math.tan(toRad(off)) / (halfTan(fovDeg) * aspect);
  return Math.abs(x) <= 1 ? x : null;
}

/** Podíl výšky plátna, který tělo výšky `heightM` zabere ve vzdálenosti `distanceM` před okem (vstup `foeScale`). */
export const heightShare = (heightM: number, distanceM: number, fovDeg: number): number => (distanceM > 0 ? heightM / (2 * distanceM * halfTan(fovDeg)) : 0);
