/**
 * Šev na výšku pro nové žánry P66 (T2): póza kamery, po které leží celá krabice hry v pásu mezi horním pásem HUD
 * a dolní zónou palce. Tvar volání je týž jako `fitTall(camera, box, rect)` z `portrait-frame.ts` P64 (T2), aby
 * výměna po jeho sloučení byla mechanická (P66 T14).
 *
 * simplified: pásy z konstant, ne z DOM; nahradit portrait-frame.ts z P64 po jeho sloučení (T14).
 */

import { type Box3, Matrix4, type PerspectiveCamera, Vector3 } from 'three';

import { size, space } from '@/brand/tokens';

/** Plátno (px) a pás hry na něm: od `top` do `bottom`, y dolů od horního okraje plátna. */
export interface PlayRect {
  readonly width: number;
  readonly height: number;
  readonly top: number;
  readonly bottom: number;
}

/**
 * Póza z fitu: `distance` = vzdálenost kamery od středu krabice po jejím dosavadním směru pohledu, `shift` = svislý
 * posun záběru v px pro `camera.setViewOffset(width, height, 0, shift, width, height)` – střed krabice tak padne
 * doprostřed pásu hry, ne doprostřed plátna.
 */
export interface TallFit {
  readonly distance: number;
  readonly shift: number;
}

/** Horní pás HUD (kit `08-game-hud.md`): odsazení, řada pilulek postupu a časovače, mezera. */
export const HUD_BAND_PX = space['4'] + size['hud-pill'] + space['3'];
/** Dolní zóna palce: dolní řada HUD (kola 58–60 px, nejbližší token `control-l`), nad ní řada ovládání palcem. */
export const THUMB_ZONE_PX = space['4'] + size['control-l'] + space['3'] + size['control-l'] + space['3'];
/** Okraj mezi krabicí a hranou pásu. */
const FIT_MARGIN_PX = space['2'];

/** Pás hry na plátně `width × height` z konstant kitu. */
export const tokenRect = (width: number, height: number): PlayRect => ({ width, height, top: HUD_BAND_PX, bottom: height - THUMB_ZONE_PX });

/**
 * Vzdálenost a posun, aby krabice `box` (svět) ležela celá v pásu `rect`. Kamera se dívá na střed krabice ze své
 * polohy a směr pohledu se nemění; přesné pro perspektivní projekci (každý roh má svou hloubku). Na šířku
 * (`camera.aspect ≥ 1`) vrací vstupní pózu beze změny.
 */
export function fitTall(camera: PerspectiveCamera, box: Box3, rect: PlayRect): TallFit {
  const center = box.getCenter(new Vector3());
  const distance = camera.position.distanceTo(center);
  if (camera.aspect >= 1) return { distance, shift: 0 };
  // Osy kamery, jak je postaví `lookAt`: x doprava, y nahoru, z od středu ke kameře.
  const basis = new Matrix4().lookAt(camera.position, center, camera.up);
  const right = new Vector3().setFromMatrixColumn(basis, 0);
  const up = new Vector3().setFromMatrixColumn(basis, 1);
  const back = new Vector3().setFromMatrixColumn(basis, 2);
  const tan = Math.tan((camera.fov * Math.PI) / 360) / camera.zoom;
  const halfH = (rect.bottom - rect.top) / 2 - FIT_MARGIN_PX;
  const halfW = rect.width / 2 - FIT_MARGIN_PX;
  // Px na jednotku světa v hloubce d: svisle (height / 2) / (d · tan), vodorovně (width / 2) / (d · tan · aspect).
  const needY = rect.height / 2 / (tan * halfH);
  const needX = rect.width / 2 / (tan * camera.aspect * halfW);
  let fit = 0;
  const corner = new Vector3();
  for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) {
    corner.set(x, y, z).sub(center);
    // Hloubka rohu = vzdálenost + jeho posun po směru pohledu (dál od kamery = víc).
    const deeper = -corner.dot(back);
    fit = Math.max(fit, Math.abs(corner.dot(up)) * needY - deeper, Math.abs(corner.dot(right)) * needX - deeper, camera.near - deeper);
  }
  return { distance: fit, shift: rect.height / 2 - (rect.top + rect.bottom) / 2 };
}
