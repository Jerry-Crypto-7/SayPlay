/**
 * Kontaktní stín (P77 T3): rozostřená elipsa pod kulisou a pod tělem, předpečená do jedné textury.
 * Levná náhrada okluze N8AO, kterou `low` (telefon) nemá vůbec: kreslí se na každé úrovni kvality,
 * jedno instancované kreslení na řadu kulis a jedno na těla scény. Barva je tón stínu místa
 * (`shadowTone`) – teplý nebo šedomodrý z palety, nikdy černý.
 */
import { Color, DataTexture, LinearFilter, MeshBasicMaterial, PlaneGeometry } from 'three';

import { oklab, paletteLab, rgbOf, type Rgb } from './rig/toon';

/** Šedomodrá, ke které se hledá tón palety (jen odstín a, b): chladné místo dá šedomodrý stín, teplé teplý. */
const COOL = oklab([0.13, 0.17, 0.25]);
/** Světlost tónu stínu (Oklab L): tmavší než zem, aby ji ztmavil, ale daleko od černé. */
export const SHADE_L = 0.42;
/** Nejvyšší sytost tónu (Oklab chroma): pastelový stín, ne barevná skvrna. */
const SHADE_CHROMA = 0.05;
/**
 * Krytí elipsy uprostřed (T3 0,5; T6 tmavší – soudce chtěl pevnější ukotvení předmětů). P81: měkčí, širší
 * a světlejší stín předlohy (`SHADE_L` 0,38 → 0,42, `CONTACT_SPREAD` 1,35 → 1,6).
 */
export const CONTACT_OPACITY = 0.6;
/** Výška nad zemí proti z-fightingu (m). */
export const CONTACT_LIFT = 0.03;
/** Elipsa je o tolik širší než půdorys předmětu. */
export const CONTACT_SPREAD = 1.6;
/** Nad tolik metrů nad svou zemí (skok) elipsa zmizí. */
export const CONTACT_FADE_M = 2;

/** Tón palety místa nejbližší šedomodré, se světlostí `SHADE_L` a sytostí nejvýš `SHADE_CHROMA`. */
export function shadowToneLab(palette: readonly string[]): Rgb {
  let best: Rgb = [SHADE_L, COOL[1], COOL[2]];
  let bestGap = Infinity;
  for (const tone of paletteLab(palette)) {
    const gap = (tone[1] - COOL[1]) ** 2 + (tone[2] - COOL[2]) ** 2;
    if (gap < bestGap) {
      bestGap = gap;
      best = tone;
    }
  }
  const chroma = Math.hypot(best[1], best[2]);
  const keep = chroma > SHADE_CHROMA ? SHADE_CHROMA / chroma : 1;
  return [SHADE_L, best[1] * keep, best[2] * keep];
}

/** Tón stínu místa jako `#rrggbb` (sRGB). */
export function shadowTone(palette: readonly string[]): string {
  const [r, g, b] = rgbOf(shadowToneLab(palette));
  return `#${new Color(r, g, b).getHexString()}`;
}

/** Kolik odstínu tónu stínu dostane oblohová složka polokulového světla – jediné světlo, které svítí do stínu slunce. */
export const SHADE_SKY = 0.4;

/** Obloha polokulového světla posunutá k odstínu stínu místa (světlost zůstává): stín slunce nese tón místa, ne šeď. */
export function shadeSky(sky: string, palette: readonly string[]): string {
  const color = new Color(sky);
  const [L, a, b] = oklab(color.toArray() as unknown as Rgb);
  const [, shadeA, shadeB] = shadowToneLab(palette);
  const [r, g, bl] = rgbOf([L, a + (shadeA - a) * SHADE_SKY, b + (shadeB - b) * SHADE_SKY]);
  return `#${color.setRGB(r, g, bl).getHexString()}`;
}

/** Krytí elipsy ve vzdálenosti `r` od středu (0 střed, 1 okraj): měkký okraj bez hrany. */
export function blobAlpha(r: number): number {
  if (r >= 1) return 0;
  const t = 1 - r * r;
  return t * t;
}

const TEXELS = 64;
let texture: DataTexture | undefined;

function blobTexture(): DataTexture {
  if (texture !== undefined) return texture;
  const data = new Uint8Array(TEXELS * TEXELS * 4);
  for (let y = 0; y < TEXELS; y++) {
    for (let x = 0; x < TEXELS; x++) {
      const i = (y * TEXELS + x) * 4;
      data.fill(255, i, i + 3);
      data[i + 3] = Math.round(255 * blobAlpha(Math.hypot(((x + 0.5) / TEXELS) * 2 - 1, ((y + 0.5) / TEXELS) * 2 - 1)));
    }
  }
  texture = new DataTexture(data, TEXELS, TEXELS);
  texture.magFilter = LinearFilter;
  texture.minFilter = LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

/** Vodorovný čtverec 2 × 2 m (poloměr 1): instance ho škálují na půdorys. */
export const CONTACT_GEOMETRY = new PlaneGeometry(2, 2).rotateX(-Math.PI / 2);

const materials = new Map<string, MeshBasicMaterial>();

/**
 * Materiál elipsy v tónu stínu místa, sdílený na tón. Bez zápisu hloubky (rig ho bere jako plochu, která stín
 * jen přijímá), s posunem polygonu, aby nebojoval se zemí.
 */
export function contactMaterial(palette: readonly string[]): MeshBasicMaterial {
  const tone = shadowTone(palette);
  let material = materials.get(tone);
  if (material === undefined) {
    material = new MeshBasicMaterial({ color: tone, map: blobTexture(), transparent: true, opacity: CONTACT_OPACITY, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    materials.set(tone, material);
  }
  return material;
}
