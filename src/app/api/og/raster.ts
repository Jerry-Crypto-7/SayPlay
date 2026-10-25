/**
 * Kreslení náhledu sdíleného odkazu do vlastního bufferu (P58C T2).
 *
 * Kartu výzvy dřív kreslil `next/og` (satori + resvg ve WASM, MPL-2.0); pravidla
 * hackathonu zakazují copyleft i „podobné povinnosti“, takže karta teď vzniká
 * tady: zaoblené obdélníky a kruhy s vyhlazeným okrajem, vložený RGBA obrázek
 * a text z atlasu glyfů Roboto (`glyphs.json`, generuje
 * `scripts/p58c/og-glyphs.mjs`). Výsledek kóduje `encodePng` z `png.ts`.
 *
 * Tvar je funkce pokrytí pixelu (0–1) nad svým obdélníkem pixelů; okraj se
 * vyhlazuje vzdáleností středu pixelu od hrany. Text se kreslí z masek ve
 * velikosti 80 px se vzorkováním n×n na pixel, takže zmenšení i otočení (odznak
 * −6°) jde jednou cestou.
 */

import { inflateSync } from 'node:zlib';

import atlas from './glyphs.json';

export type Rgb = readonly [number, number, number];

export interface Raster {
  readonly width: number;
  readonly height: number;
  /** `width * height * 3` bajtů, po řádcích shora dolů – vstup `encodePng`. */
  readonly rgb: Uint8Array;
}

export interface RgbaImage {
  readonly width: number;
  readonly height: number;
  readonly rgba: Uint8Array;
}

/** Pokrytí pixelu `(px, py)` tvarem, 0–1, nad obdélníkem pixelů `[x0, x1) × [y0, y1)`. */
export interface Shape {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
  at(px: number, py: number): number;
}

/** Otočení kolem bodu `(cx, cy)` o `angle` radiánů, kladný úhel po směru hodin jako CSS `rotate`. */
export interface Turn {
  readonly cx: number;
  readonly cy: number;
  readonly angle: number;
}

export function raster(width: number, height: number, fill: Rgb): Raster {
  const rgb = new Uint8Array(width * height * 3);
  for (let at = 0; at < rgb.length; at += 3) rgb.set(fill, at);
  return { width, height, rgb };
}

function blend(target: Raster, px: number, py: number, rgb: Rgb, alpha: number): void {
  if (alpha <= 0 || px < 0 || py < 0 || px >= target.width || py >= target.height) return;
  const at = (py * target.width + px) * 3;
  const a = Math.min(1, alpha);
  for (let c = 0; c < 3; c += 1) target.rgb[at + c] = Math.round(target.rgb[at + c] + (rgb[c] - target.rgb[at + c]) * a);
}

/** Zaoblený obdélník; kruh je `roundRect(x, y, d, d, d / 2)`. */
export function roundRect(x: number, y: number, w: number, h: number, r: number): Shape {
  const [hx, hy] = [w / 2, h / 2];
  const [cx, cy] = [x + hx, y + hy];
  const radius = Math.max(0, Math.min(r, hx, hy));
  return {
    x0: Math.floor(x),
    y0: Math.floor(y),
    x1: Math.ceil(x + w),
    y1: Math.ceil(y + h),
    at(px, py) {
      // Znaménková vzdálenost středu pixelu od okraje; pokrytí = půl pixelu kolem hrany.
      const qx = Math.abs(px + 0.5 - cx) - (hx - radius);
      const qy = Math.abs(py + 0.5 - cy) - (hy - radius);
      const d = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius;
      return Math.max(0, Math.min(1, 0.5 - d));
    },
  };
}

export function paint(target: Raster, shape: Shape, rgb: Rgb): void {
  for (let py = Math.max(0, shape.y0); py < Math.min(target.height, shape.y1); py += 1) {
    for (let px = Math.max(0, shape.x0); px < Math.min(target.width, shape.x1); px += 1) blend(target, px, py, rgb, shape.at(px, py));
  }
}

/**
 * RGBA obrázek do obdélníku `(x, y, w, h)` s bilineárním vzorkováním (náhled
 * hrdiny 256 → 318 px, logo 1:1); `clip` ořízne pokrytím (zaoblený rám).
 */
export function drawImage(target: Raster, image: RgbaImage, x: number, y: number, w: number, h: number, clip?: Shape): void {
  const [sx, sy] = [image.width / w, image.height / h];
  const texel = (u: number, v: number, c: number): number => {
    const [cu, cv] = [Math.min(image.width - 1, Math.max(0, u)), Math.min(image.height - 1, Math.max(0, v))];
    return image.rgba[(cv * image.width + cu) * 4 + c];
  };
  for (let py = Math.max(0, Math.floor(y)); py < Math.min(target.height, Math.ceil(y + h)); py += 1) {
    for (let px = Math.max(0, Math.floor(x)); px < Math.min(target.width, Math.ceil(x + w)); px += 1) {
      const u = (px + 0.5 - x) * sx - 0.5;
      const v = (py + 0.5 - y) * sy - 0.5;
      const [u0, v0] = [Math.floor(u), Math.floor(v)];
      const [fu, fv] = [u - u0, v - v0];
      // Předem vynásobená alfa, ať průhledný okraj nepřinese do míchání černou.
      const premultiplied = [0, 0, 0, 0];
      for (const [du, dv, weight] of [[0, 0, (1 - fu) * (1 - fv)], [1, 0, fu * (1 - fv)], [0, 1, (1 - fu) * fv], [1, 1, fu * fv]] as const) {
        const alpha = texel(u0 + du, v0 + dv, 3) / 255;
        for (let c = 0; c < 3; c += 1) premultiplied[c] += texel(u0 + du, v0 + dv, c) * alpha * weight;
        premultiplied[3] += alpha * weight;
      }
      const alpha = premultiplied[3] * (clip === undefined ? 1 : clip.at(px, py));
      if (premultiplied[3] <= 0) continue;
      const rgb: Rgb = [premultiplied[0] / premultiplied[3], premultiplied[1] / premultiplied[3], premultiplied[2] / premultiplied[3]];
      blend(target, px, py, rgb, alpha);
    }
  }
}

// ---------------------------------------------------------------------------
// Text z atlasu
// ---------------------------------------------------------------------------

/** `[advance, x, y, w, h, offset]` v px při velikosti `atlas.size`; `x, y` = levý horní roh masky od počátku na účaří. */
type Glyph = readonly [number, number, number, number, number, number];

interface Atlas {
  readonly size: number;
  readonly fonts: Record<string, { readonly ascent: number; readonly descent: number; readonly glyphs: Record<string, Glyph> }>;
  readonly alpha: string;
  readonly logo: { readonly width: number; readonly height: number; readonly rgba: string };
}

const ATLAS = atlas as unknown as Atlas;

/** Řezy v atlasu: Black 900 má celou podmnožinu latinky, Bold 700 jen ASCII (slovo odznaku). */
export type Weight = 700 | 900;

let MASKS: Uint8Array | null = null;
let LOGO: RgbaImage | null = null;

function masks(): Uint8Array {
  MASKS ??= new Uint8Array(inflateSync(Buffer.from(ATLAS.alpha, 'base64')));
  return MASKS;
}

/** Logo Sayplay v rozměru karty, rasterizované spolu s atlasem. */
export function logoImage(): RgbaImage {
  LOGO ??= { width: ATLAS.logo.width, height: ATLAS.logo.height, rgba: new Uint8Array(inflateSync(Buffer.from(ATLAS.logo.rgba, 'base64'))) };
  return LOGO;
}

/** Má atlas pro znak glyf v daném řezu? */
export function hasGlyph(ch: string, weight: Weight = 900): boolean {
  return ch in ATLAS.fonts[weight].glyphs;
}

/**
 * Glyf znaku, a když ho atlas nemá, glyf jeho základního písmene (`ě` → `e`):
 * karta s takovým textem je jen dočasná (`fontCovers` v `_og.ts`), ale aspoň
 * se dá přečíst. Bez obojího `null` – znak se vynechá.
 */
function glyphOf(ch: string, weight: Weight): Glyph | null {
  const glyphs = ATLAS.fonts[weight].glyphs;
  return glyphs[ch] ?? glyphs[ch.normalize('NFD')[0]] ?? null;
}

export interface TextStyle {
  readonly weight: Weight;
  readonly size: number;
  /** CSS `letter-spacing` v px, přičte se za každý znak. */
  readonly spacing: number;
}

export function measureText(text: string, { weight, size, spacing }: TextStyle): number {
  const k = size / ATLAS.size;
  let width = 0;
  for (const ch of text) width += (glyphOf(ch, weight)?.[0] ?? 0) * k + spacing;
  return width;
}

/** Zalomení po slovech do `maxWidth` jako CSS; slovo delší než řádek stojí samo a přeteče. */
export function wrapText(text: string, style: TextStyle, maxWidth: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/).filter((part) => part !== '')) {
    const next = line === '' ? word : `${line} ${word}`;
    if (line !== '' && measureText(next, style) > maxWidth) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line !== '') lines.push(line);
  return lines;
}

/** Kde leží účaří řádku výšky `lineHeight` (px) s horní hranou `top`: obsah písma uprostřed řádku jako v CSS. */
export function baselineOf(top: number, lineHeight: number, { weight, size }: TextStyle): number {
  const k = size / ATLAS.size;
  const { ascent, descent } = ATLAS.fonts[weight];
  return top + (lineHeight - (ascent + descent) * k) / 2 + ascent * k;
}

/**
 * Jeden řádek textu od `(x, baseline)` barvou `rgb`, s `turn` otočený kolem
 * bodu (odznak). Každý cílový pixel se vzorkuje n×n body zpětně do masky,
 * n podle zmenšení – 24 px písmo z 80 px masky by jedním vzorkem zrnělo.
 */
export function drawText(target: Raster, text: string, x: number, baseline: number, style: TextStyle, rgb: Rgb, turn?: Turn): void {
  const k = style.size / ATLAS.size;
  const n = Math.min(4, Math.max(1, Math.ceil(1 / k)));
  const [cos, sin] = turn === undefined ? [1, 0] : [Math.cos(turn.angle), Math.sin(turn.angle)];
  const [ox, oy] = turn === undefined ? [0, 0] : [turn.cx, turn.cy];
  const alpha = masks();
  let pen = x;
  for (const ch of text) {
    const glyph = glyphOf(ch, style.weight);
    if (glyph === null) continue;
    const [advance, gx, gy, w, h, offset] = glyph;
    const [left, top] = [pen + gx * k, baseline + gy * k];
    pen += advance * k + style.spacing;
    if (w === 0 || h === 0) continue;
    // Obdélník masky v cíli (po otočení jeho obal).
    const corners = [[left, top], [left + w * k, top], [left, top + h * k], [left + w * k, top + h * k]].map(([cx, cy]) => [ox + (cx - ox) * cos - (cy - oy) * sin, oy + (cx - ox) * sin + (cy - oy) * cos]);
    const [x0, x1] = [Math.floor(Math.min(...corners.map((c) => c[0]))), Math.ceil(Math.max(...corners.map((c) => c[0])))];
    const [y0, y1] = [Math.floor(Math.min(...corners.map((c) => c[1]))), Math.ceil(Math.max(...corners.map((c) => c[1])))];
    const sample = (u: number, v: number): number => {
      const [u0, v0] = [Math.floor(u), Math.floor(v)];
      const [fu, fv] = [u - u0, v - v0];
      const at = (mu: number, mv: number): number => (mu < 0 || mv < 0 || mu >= w || mv >= h ? 0 : alpha[offset + mv * w + mu]);
      return (at(u0, v0) * (1 - fu) * (1 - fv) + at(u0 + 1, v0) * fu * (1 - fv) + at(u0, v0 + 1) * (1 - fu) * fv + at(u0 + 1, v0 + 1) * fu * fv) / 255;
    };
    for (let py = Math.max(0, y0); py < Math.min(target.height, y1); py += 1) {
      for (let px = Math.max(0, x0); px < Math.min(target.width, x1); px += 1) {
        let cover = 0;
        for (let j = 0; j < n; j += 1) {
          for (let i = 0; i < n; i += 1) {
            const [dx, dy] = [px + (i + 0.5) / n - ox, py + (j + 0.5) / n - oy];
            // Zpětné otočení do souřadnic textu, pak do pixelů masky (středy pixelů).
            const [lx, ly] = [ox + dx * cos + dy * sin, oy - dx * sin + dy * cos];
            cover += sample((lx - left) / k - 0.5, (ly - top) / k - 0.5);
          }
        }
        blend(target, px, py, rgb, cover / (n * n));
      }
    }
  }
}
