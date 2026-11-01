/**
 * Kamera směny se stavbou obchodu (P68-S T5): pevná deska 3/4 shora a buňky pro prst.
 *
 * **Souřadnice scény:** scéna kreslí desku ve skupině otočené o π kolem svislé osy, takže bod jádra (x, z) leží ve
 * scéně v (−x, −z). Kamera stojí za dveřmi a kouká po +z jako ostatní scény (slunce a rig s tím počítají): sloupec 0
 * je vlevo, řada 0 (zadní stěna) nahoře, řada palety pod deskou dole u palce. Mřížka = 5 sloupců × 7 řad (deska
 * 5 × 6 + paleta), číslovaná po řadách zleva shora – přesně jak ji čte `cellAxisAt` (`lanes-input.ts`).
 *
 * **Úzký zorný úhel:** sdílený vstup dělí obdélník `data-lane-cells` na stejné buňky, perspektiva ale dělá blízké řady
 * vyšší než vzdálené. Kamera proto stojí daleko s úzkým úhlem (skoro izometrický pohled jako tycoony) a obdélník
 * buněk je nejlepší rovnoměrná náhrada promítnutých hranic (minimax, `cellsAttr`): střed každé buňky padne do své
 * buňky s rezervou, kterou pinuje test. Mlhu a vzdálenou rovinu kvůli vzdálenosti posouvá scéna (`BuildshiftScene`).
 *
 * **Na výšku** (`camera.aspect < 1`) přes `fitTall` z `portrait-frame.ts` do hracího obdélníku (`usePlayRectRef`),
 * deska pak sjede ke spodní hraně – paleta je pod palcem. **Na šířku** vlastní póza: 7 řad se na 390 px výšky pod
 * horní pás HUD (120 px s řádkem cíle) nevejde, takže deska zabere výšku ve sloupci mezi rohy HUD (`wideFrame`):
 * pilulka postupu vlevo a časovač s pauzou vpravo leží vedle vzdálených řad, ne na nich. Dolní řada HUD (Restart,
 * „Change one thing“, sdílení) ale vede přes celou šířku, takže dolní hrana rámu je i na šířku horní hrana dolního
 * pásu hracího obdélníku – jinak by tlačítka ležela přes paletu a ťuk by místo stavby otevřel změnu hry (e2e T6).
 * Na šířku telefonu (343–390 px výšky) tak buňka vyjde 36–42 px, pod `--sp-size-touch-min`; 44 px chce dolní řadu
 * HUD mimo sloupec desky (požadavek v `evals/play/p68/stavba/integration.md`).
 */

import { Box3, MathUtils, type PerspectiveCamera, Vector3 } from 'three';

import { size, space } from '@/brand/tokens';
import { UNIT } from '@/play/arcade/contract';
import { BUILDSHIFT, GRID_CELLS, cellX, cellZ } from '@/play/arcade/pieces/buildshift-world';

import { FIT_MARGIN_PX, type FrameRect, type PlayRect, fitTall, playRect } from '../../portrait-frame';

/** Plátno v CSS px. */
export interface Canvas {
  readonly width: number;
  readonly height: number;
}

export const VIEW = {
  /** Úhel pohledu pod vodorovnou (rad, ~60°): 3/4 shora, postavy a stanoviště mají ještě bok. */
  pitch: 1.04,
  /** Zorný úhel (°) na výšku a na šířku: úzký, ať jsou řady skoro stejně vysoké (viz hlavička). */
  tallFov: 24,
  wideFov: 12,
  /** Na výšku deska nad spodní hranou hracího obdélníku o tolik px (palec, gesto systému). */
  bottomInset: space['4'],
  /** Na šířku: rezerva rohů HUD do stran (pilulka postupu se životy, časovač s pauzou) a okraj nahoře a dole. */
  cornerPx: 240,
  edgePx: space['2'],
  /** Výška krabice desky (m): nízká zadní stěna; vyšší stanoviště vzadu smí sahat do okraje. */
  boxTop: 0.6,
} as const;

/** Mřížka: sloupce, řady (deska + paleta), buňka (m). */
export const GRID = { cols: BUILDSHIFT.cols, rows: GRID_CELLS / BUILDSHIFT.cols, cell: BUILDSHIFT.cell / UNIT } as const;

/** Bod jádra → scéna (otočení o π). */
export const sceneX = (x: number): number => -x / UNIT;
export const sceneZ = (z: number): number => -z / UNIT;

/** Buňka mřížky (i paleta) ve scéně: levý a pravý bok na obrazovce, vzdálená a blízká hrana. */
export function cellRect(cell: number): { readonly left: number; readonly right: number; readonly far: number; readonly near: number } {
  const x = sceneX(cellX(cell));
  const z = sceneZ(cellZ(cell));
  const half = GRID.cell / 2;
  // Kamera kouká po +z: vlevo na obrazovce je +x, nahoře (dál) +z.
  return { left: x + half, right: x - half, far: z + half, near: z - half };
}

/** Hrany celé mřížky ve scéně. */
const EDGES = { left: cellRect(0).left, right: cellRect(GRID.cols - 1).right, far: cellRect(0).far, near: cellRect(GRID_CELLS - 1).near } as const;

/** Krabice, kterou kamera rámuje: celá mřížka s nízkou zadní stěnou. */
export const GRID_BOX = new Box3(new Vector3(EDGES.right, 0, EDGES.near), new Vector3(EDGES.left, VIEW.boxTop, EDGES.far));
const CENTER = GRID_BOX.getCenter(new Vector3()).setY(0);
/** Směr od středu desky ke kameře: za dveřmi (−z) a nad nimi pod `VIEW.pitch`. */
const BACK = new Vector3(0, Math.sin(VIEW.pitch), -Math.cos(VIEW.pitch));

/** Na šířku: sloupec mezi rohy HUD od horní hrany plátna po dolní pás hracího obdélníku `rect` (px, y dolů). */
export function wideFrame(canvas: Canvas, rect: PlayRect): FrameRect {
  const corner = Math.min(VIEW.cornerPx, canvas.width / 4);
  return { left: corner, top: VIEW.edgePx, right: canvas.width - corner, bottom: Math.min(canvas.height, rect.px.bottom) - VIEW.edgePx };
}

/** Kamera kouká na střed desky ze směru `BACK` (zatím z libovolné dálky). */
function aim(camera: PerspectiveCamera, fov: number): void {
  if (camera.fov !== fov) {
    camera.fov = fov;
    camera.updateProjectionMatrix();
  }
  camera.position.copy(BACK).multiplyScalar(40).add(CENTER);
  camera.lookAt(CENTER);
  camera.updateMatrixWorld();
}

/** Rohy krabice promítnuté na plátno (px, y dolů): nejvyšší a nejnižší. */
function verticalPx(camera: PerspectiveCamera, box: Box3, canvas: Canvas): { readonly top: number; readonly bottom: number } {
  const probe = new Vector3();
  let top = Infinity;
  let bottom = -Infinity;
  for (let i = 0; i < 8; i += 1) {
    probe.set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z).project(camera);
    const y = ((1 - probe.y) / 2) * canvas.height;
    top = Math.min(top, y);
    bottom = Math.max(bottom, y);
  }
  return { top, bottom };
}

/**
 * Na šířku: nejbližší kamera s danou orientací, ve které leží celá krabice v `frame` (px). Táž úvaha jako `fitTall`
 * (každý roh dá dolní mez posunu po ose pohledu, svislý posun dá střed krabice do středu rámu) – `fitTall` je na
 * `aspect ≥ 1` záměrně identita. Rám je do stran souměrný.
 */
function fitFrame(camera: PerspectiveCamera, box: Box3, frame: FrameRect, canvas: Canvas): Vector3 {
  const forward = new Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
  const up = new Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
  const right = new Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
  const distance = box.getCenter(new Vector3()).sub(camera.position).dot(forward);
  const top = 1 - (2 * frame.top) / canvas.height;
  const bottom = 1 - (2 * frame.bottom) / canvas.height;
  const wide = 1 - (2 * frame.left) / canvas.width;
  const half = (top - bottom) / 2;
  const mid = (top + bottom) / 2;
  const t = Math.tan(MathUtils.degToRad(camera.getEffectiveFOV()) / 2);
  const lift = mid * distance * t;
  const corner = new Vector3();
  let back = -Infinity;
  for (let i = 0; i < 8; i += 1) {
    corner.set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z).sub(camera.position);
    const x = corner.dot(right);
    const y = corner.dot(up);
    const z = corner.dot(forward);
    back = Math.max(back, (y + lift - top * z * t) / (t * half), (bottom * z * t - y - lift) / (t * half), Math.abs(x) / (wide * t * camera.aspect) - z, camera.near - z);
  }
  const shift = -mid * (distance + back) * t;
  return camera.position.clone().addScaledVector(forward, -back).addScaledVector(up, shift);
}

/** Hrací obdélník na výšku, dokud ho `usePlayRect` nezměří: pod pásem pilulek HUD až po spodní hranu. */
export const tallFallback = (canvas: Canvas): PlayRect => playRect(canvas, space['4'] + size['hud-pill'] + space['3'], canvas.height);

/**
 * Postaví kameru: zorný úhel, polohu a orientaci (matice světa aktualizované). `rect` = hrací obdélník z
 * `usePlayRectRef` (nebo `tallFallback`); na šířku se z něj čte jen dolní pás.
 */
export function placeCamera(camera: PerspectiveCamera, canvas: Canvas, rect: PlayRect): void {
  if (camera.aspect >= 1) {
    aim(camera, VIEW.wideFov);
    camera.position.copy(fitFrame(camera, GRID_BOX, wideFrame(canvas, rect), canvas));
    camera.updateMatrixWorld();
    return;
  }
  aim(camera, VIEW.tallFov);
  const bottom = rect.px.bottom - VIEW.bottomInset;
  camera.position.copy(fitTall(camera, GRID_BOX, playRect(canvas, rect.px.top, bottom)).position);
  camera.updateMatrixWorld();
  // Deska je na výšku užší než obdélník (rozhoduje šířka): sjede ke spodní hraně, nad ní zůstane místo.
  const drawn = verticalPx(camera, GRID_BOX, canvas);
  const top = bottom - (drawn.bottom - drawn.top) - 2 * FIT_MARGIN_PX - 2;
  if (top <= rect.px.top) return;
  aim(camera, VIEW.tallFov);
  camera.position.copy(fitTall(camera, GRID_BOX, playRect(canvas, top, bottom)).position);
  camera.updateMatrixWorld();
}

/**
 * `data-lane-cells` pro kameru: „sloupce,řady,vlevo,nahoře,vpravo,dole“ ve zlomcích plátna. Řady: promítnuté hranice
 * řad (osa desky) a nejlepší rovnoměrné dělení v minimaxu – tětiva posunutá o půlku největší odchylky. Sloupce:
 * lichoběžník desky, levý bok v půlce mezi nejužší a nejširší řadou (pravý souměrně). Zlomky na celé px plátna,
 * takže se atribut mění, jen když se mřížka opravdu pohne.
 */
export function cellsAttr(camera: PerspectiveCamera, canvas: Canvas): string {
  const probe = new Vector3();
  const ys: number[] = [];
  const lefts: number[] = [];
  const rights: number[] = [];
  for (let k = 0; k <= GRID.rows; k += 1) {
    const z = EDGES.far - k * GRID.cell;
    ys.push((1 - probe.set(0, 0, z).project(camera).y) / 2);
    lefts.push((probe.set(EDGES.left, 0, z).project(camera).x + 1) / 2);
    rights.push((probe.set(EDGES.right, 0, z).project(camera).x + 1) / 2);
  }
  const first = ys[0] as number;
  const slope = ((ys[GRID.rows] as number) - first) / GRID.rows;
  const residuals = ys.map((y, k) => y - (first + slope * k));
  const offset = (Math.max(...residuals) + Math.min(...residuals)) / 2;
  const left = (Math.min(...lefts) + Math.max(...lefts)) / 2;
  const right = (Math.min(...rights) + Math.max(...rights)) / 2;
  const snap = (fraction: number, px: number): string => (Math.round(fraction * px) / px).toFixed(4);
  return [String(GRID.cols), String(GRID.rows), snap(left, canvas.width), snap(first + offset, canvas.height), snap(right, canvas.width), snap(first + offset + slope * GRID.rows, canvas.height)].join(',');
}
