/**
 * Jeden šev rámování na výšku (P64 T2). Kamery žánrů (T3–T5) na telefonu na výšku přes něj plní výšku mezi HUD
 * a ovládáním; na šířku a na desktopu se nic nemění.
 *
 * - `playRect` = plátno bez horního pásu HUD a dolního pásu ovládání, v px a v NDC. Z DOM ho měří `usePlayRect`
 *   v `StageCanvas` (`ArcadeStage.tsx`) při změně rozměrů, ne v každém snímku, do ref v `PlayRectContext`; nikdy do
 *   relace ani hashe.
 * - `fitTall` = vzdálenost a svislý posun kamery, aby krabice hry ležela v `playRect` s okrajem. Úhel pohledu žánru
 *   zůstává: kamera jede po své ose pohledu (blíž, dál) a po své ose nahoru – totéž jako posunout bod pohledu o týž
 *   vektor. Projekční matice se nemění, žádné `setViewOffset`.
 * - Na `camera.aspect ≥ 1` je fit identita: tatáž čísla polohy, nulový posun. Rozhoduje poměr stran plátna, nikdy
 *   `window`, takže XR rig s vlastní kamerou zůstane netknutý.
 *
 * Scéna ve `useFrame`, až kameru postaví jako dnes:
 *
 *   const playRect = usePlayRectRef();            // v těle komponenty
 *   useFrame(({ camera }) => {
 *     …                                           // poloha a lookAt žánru
 *     const rect = playRect.current;              // null = ještě nezměřeno nebo mimo StageCanvas
 *     if (rect !== null) camera.position.copy(fitTall(camera as PerspectiveCamera, box, rect, { keep }).position);
 *   });
 *
 * Po fitu už žádné `lookAt` – orientaci fit nemění a nový `lookAt` na starý bod by posun vrátil.
 */

import { type RefObject, createContext, useContext } from 'react';
import { type Box3, MathUtils, type PerspectiveCamera, Vector3 } from 'three';

export interface FrameRect {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

export interface PlayRect {
  /** Plátno v CSS px. */
  readonly canvas: { readonly width: number; readonly height: number };
  /** Hrací obdélník v px od levého horního rohu plátna (y dolů). Do stran celé plátno. */
  readonly px: FrameRect;
  /** Týž obdélník v NDC (y nahoru, `top > bottom`). */
  readonly ndc: FrameRect;
}

/**
 * Hrací obdélník plátna: bez horního pásu HUD (`hudBottomPx` = spodní hrana horních lišt od horní hrany plátna) a bez
 * dolního pásu ovládání (`controlsTopPx` = horní hrana dolních prvků). Pásy se oříznou na plátno a nepřekříží se –
 * jako `bandsOf` auditu `e2e/p64-portrait-audit.spec.ts`.
 */
export function playRect(canvas: { readonly width: number; readonly height: number }, hudBottomPx: number, controlsTopPx: number): PlayRect {
  const { width, height } = canvas;
  const top = MathUtils.clamp(hudBottomPx, 0, height);
  const bottom = MathUtils.clamp(controlsTopPx, top, height);
  return {
    canvas: { width, height },
    px: { left: 0, top, right: width, bottom },
    ndc: { left: -1, top: 1 - (2 * top) / height, right: 1, bottom: 1 - (2 * bottom) / height },
  };
}

/** Okraj mezi krabicí hry a hranou `playRect` či plátna (`--sp-space-2`). */
export const FIT_MARGIN_PX = 8;

export interface FitOptions {
  /** Okraj v CSS px plátna; výchozí `FIT_MARGIN_PX`. */
  readonly margin?: number;
  /**
   * Co se nesmí uříznout (dráha hrdiny, cíle). S ním smí fit ubrat do stran okraj krabice mimo `keep`: vodorovně se
   * vejde jen `keep`, svisle celá krabice i `keep`. Bez něj se vejde celá krabice.
   */
  readonly keep?: Box3;
}

export interface TallFit {
  /** Poloha kamery po fitu (svět); na `aspect ≥ 1` tatáž čísla jako vstup. Orientace se nemění. */
  readonly position: Vector3;
  /** Vzdálenost od kamery ke středu krabice podél osy pohledu po fitu. */
  readonly distance: number;
  /** O kolik kamera vyjela po své ose nahoru (m): kladný = záběr dolů pod horní pás HUD. 0, když jsou pásy nulové. */
  readonly shift: number;
}

const CORNERS = [0, 1, 2, 3, 4, 5, 6, 7] as const;

/** Rohy krabice v souřadnicích kamery: `x` doprava, `y` nahoru, `z` hloubka před kamerou. */
function cornersIn(box: Box3, eye: Vector3, right: Vector3, up: Vector3, forward: Vector3): { readonly x: number; readonly y: number; readonly z: number }[] {
  const corner = new Vector3();
  return CORNERS.map((i) => {
    corner.set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z).sub(eye);
    return { x: corner.dot(right), y: corner.dot(up), z: corner.dot(forward) };
  });
}

/**
 * Kamera na výšku, aby krabice hry (svět) ležela v `playRect` s okrajem, co nejblíž. Kamera bez rodiče (poloha
 * a kvaternion jsou světové) a bez `setViewOffset`; kamery se nedotkne, polohu vrátí.
 *
 * Kamera jede o `back` po ose pohledu dozadu (záporný = blíž) a o `shift` po své ose nahoru. `shift` posune obraz
 * ve hloubce středu krabice přesně o střed `playRect` v NDC (`mid`), takže při nulových pásech je nula a kompozice
 * žánru zůstane. Každý roh pak dává jednu dolní mez `back` (svisle nad i pod, do stran, před bližší rovinou), takže
 * nejbližší kamera, ve které se vše vejde, je jejich maximum – bez hledání.
 */
export function fitTall(camera: PerspectiveCamera, box: Box3, rect: PlayRect, opts: FitOptions = {}): TallFit {
  const forward = new Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
  const distance = box.getCenter(new Vector3()).sub(camera.position).dot(forward);
  const same: TallFit = { position: camera.position.clone(), distance, shift: 0 };
  if (!(camera.aspect < 1)) return same;

  const margin = opts.margin ?? FIT_MARGIN_PX;
  const top = rect.ndc.top - (2 * margin) / rect.canvas.height;
  const bottom = rect.ndc.bottom + (2 * margin) / rect.canvas.height;
  const wide = 1 - (2 * margin) / rect.canvas.width;
  const half = (top - bottom) / 2;
  // Obdélník menší než okraje: není kam rámovat, kamera žánru zůstane.
  if (half <= 0 || wide <= 0) return same;

  const mid = (top + bottom) / 2;
  const t = Math.tan(MathUtils.degToRad(camera.getEffectiveFOV()) / 2);
  const up = new Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
  const right = new Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
  const whole = cornersIn(box, camera.position, right, up, forward);
  const kept = opts.keep === undefined ? whole : cornersIn(opts.keep, camera.position, right, up, forward);
  const lift = mid * distance * t;

  let back = -Infinity;
  // Svisle: Y = (y + mid·(distance + back)·t) / ((z + back)·t) mezi `bottom` a `top`.
  for (const { y, z } of opts.keep === undefined ? whole : [...whole, ...kept]) {
    back = Math.max(back, (y + lift - top * z * t) / (t * half), (bottom * z * t - y - lift) / (t * half), camera.near - z);
  }
  // Do stran: |X| = |x| / ((z + back)·t·aspect) ≤ `wide`.
  for (const { x, z } of kept) back = Math.max(back, Math.abs(x) / (wide * t * camera.aspect) - z, camera.near - z);

  const shift = -mid * (distance + back) * t;
  return { position: camera.position.clone().addScaledVector(forward, -back).addScaledVector(up, shift), distance: distance + back, shift };
}

/** Ref s `playRect` plátna (P64 T2) – drží ho `usePlayRect` v `StageCanvas`; `null` = ještě nezměřeno, nebo mimo něj. */
export const PlayRectContext = createContext<RefObject<PlayRect | null>>({ current: null });

/** Ref s `playRect` pro scénu uvnitř `StageCanvas`; `.current` se čte ve `useFrame`. */
export function usePlayRectRef(): RefObject<PlayRect | null> {
  return useContext(PlayRectContext);
}
