/**
 * Zem s kresbou (P46G T3). Plocha kolem trati byla jedna barva sady a hrála
 * jako koberec. Tady má dva až tři odstíny ze šumu, skvrny podle povrchu sady
 * (mech v trávě, světlejší písek, led ve sněhu, šmouhy na dlažbě, tmavší
 * skála), podél cesty pás krajnice (štěrk u silnice a dlažby, vyšlapaný kraj
 * u hliněné, písečné a sněžné cesty) a do strany od trati tmavne.
 *
 * Barvy jsou lineární (`new Color(hex)` jako zbytek terénu). Každý odstín je
 * směs barev palety (`groundPalette`), takže z ní nevyjde. Šum je hash
 * souřadnic – žádná náhoda, tatáž trať má pokaždé stejnou zem. Jen vzhled:
 * jádro o zemi neví, hash hry se nehne.
 */

import { BufferGeometry, Color, Float32BufferAttribute } from 'three';

import { type Cover, type Look, SURFACES } from '@/play/arcade/look';

import { type StripSegment, stripCurve } from './road-strip';

/** Celočíselný hash dvou souřadnic do [0, 1). Sdílí ho všechny generátory terénu. */
export function hash(x: number, y: number): number {
  let h = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Hladký šum hodnot v [0, 1). */
export function noise(x: number, y: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const fx = x - xi;
  const fy = y - yi;
  const u = fx * fx * (3 - 2 * fx);
  const v = fy * fy * (3 - 2 * fy);
  const a = hash(xi, yi);
  const b = hash(xi + 1, yi);
  const c = hash(xi, yi + 1);
  const d = hash(xi + 1, yi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

export const smooth = (t: number): number => {
  const c = Math.min(1, Math.max(0, t));
  return c * c * (3 - 2 * c);
};

export const mix = (from: string, to: string, t: number): string => `#${new Color(from).lerp(new Color(to), t).getHexString()}`;

export interface GroundPalette {
  /** Tři odstíny země: ve stínu, základní (zem sady) a prosvětlený. */
  readonly dark: string;
  readonly base: string;
  readonly light: string;
  /** Skvrny podle povrchu sady. */
  readonly patch: string;
  /** Pás krajnice podél cesty. */
  readonly verge: string;
  /** Kam zem do strany od trati tmavne. */
  readonly far: string;
}

/** Skvrny podle povrchu: mech v trávě, světlejší písek, led ve sněhu, šmouhy na dlažbě, tmavší skála. */
const PATCH: Readonly<Record<Cover, (base: string, look: Look) => string>> = {
  grass: (base) => mix(base, '#4d7c0f', 0.5),
  sand: (base) => mix(base, '#f3e1b5', 0.45),
  snow: (base, look) => mix(base, look.terrain?.lane ?? '#a7cde4', 0.35),
  paving: (base) => mix(base, '#3f3a36', 0.3),
  rock: (base) => mix(base, '#1c1917', 0.35),
};

/**
 * Paleta země sady. `base` = barva souše (údolí a závod `ground`, ostrůvky a aréna
 * svou souš). Stín a dálka jdou k barvě polokoule zespodu, světlo ke slunci sady.
 */
export function groundPalette(look: Look, base: string = look.ground): GroundPalette {
  const road = SURFACES[look.surface];
  return {
    dark: mix(mix(base, look.light[1], 0.3), '#000000', 0.1),
    base,
    light: mix(base, look.sunColor, 0.12),
    patch: PATCH[look.cover](base, look),
    // Štěrk u silnice a dlažby, jinde zem vyšlapaná do barvy cesty.
    verge: look.surface === 'asphalt' || look.surface === 'paving' ? mix('#a39a8c', base, 0.25) : mix(base, road.color, 0.4),
    far: mix(mix(base, look.light[1], 0.5), '#000000', 0.3),
  };
}

/** Kde a jak rychle zem do strany od trati tmavne (m od kraje cesty). */
const FAR_FROM_M = 6;
const FAR_SPAN_M = 30;

/**
 * Barva země v bodě scény (x, z) do `target`. `edge` = vzdálenost od kraje
 * cesty nebo hrací plochy (m, na cestě záporná); `null` = bez cesty (ostrůvky),
 * pak jen odstíny a skvrny.
 */
export type GroundPaint = (x: number, z: number, edge: number | null, target: Color) => Color;

/** `vergeM` = průměrná šířka krajnice od kraje cesty (m). */
export function groundPainter(palette: GroundPalette, vergeM = 1.4): GroundPaint {
  const [dark, base, light, patch, verge, far] = [palette.dark, palette.base, palette.light, palette.patch, palette.verge, palette.far].map((hex) => new Color(hex)) as [Color, Color, Color, Color, Color, Color];
  return (x, z, edge, target) => {
    // Odstín: tři oktávy šumu, roztažené kolem středu – průměr šumu hodnot krajů skoro nedosáhne.
    const n = 0.5 * noise(x * 0.06 + 31, z * 0.06 - 17) + 0.3 * noise(x * 0.17 - 5, z * 0.17 + 11) + 0.2 * noise(x * 0.45 + 3, z * 0.45 - 29);
    const t = Math.min(1, Math.max(0, (n - 0.5) * 2.6 + 0.5));
    if (t < 0.5) target.copy(dark).lerp(base, t * 2);
    else target.copy(base).lerp(light, t * 2 - 1);
    // Skvrny s měkkým, roztřepeným krajem tam, kde hrubý šum přeleze práh.
    const p = 0.7 * noise(x * 0.1 + 101, z * 0.1 + 7) + 0.3 * noise(x * 0.38 - 61, z * 0.38 + 43);
    target.lerp(patch, 0.85 * smooth((p - 0.58) / 0.1));
    if (edge === null) return target;
    // Krajnice: pás od kraje cesty, jeho hranice se podél trati vlní.
    const border = vergeM * (0.7 + 0.6 * noise(x * 0.2 + 5, z * 0.35 - 3));
    target.lerp(verge, 1 - smooth((edge - border) / 0.6 + 0.5));
    return target.lerp(far, 0.65 * smooth((edge - FAR_FROM_M) / FAR_SPAN_M));
  };
}

/** Odstup sloupců země závodu od kraje cesty (m): hustě u krajnice, řídce do dálky. Krok řad podél trati (m). */
const ROAD_COLUMNS = [0, 0.7, 1.5, 2.5, 3.5, 5, 7, 10, 14, 20, 28, 39, 53, 68, 86];
const ROAD_ROW_M = 2;
/**
 * Krajnice závodu je širší než u běžce: kamera jede nízko za autem a mantinel
 * (0,8 m) za sebou schová skoro dva metry země – úzký pás by zmizel celý.
 */
const ROAD_VERGE_M = 3;

/**
 * Zem závodu: mřížka podél osy cesty (`stripCurve`) od `from` do `to`, sloupce
 * v odstupu od kraje cesty, barvy ve vrcholech. Leží v y = 0, normála nahoru.
 */
export function buildRoadGround(look: Look, segments: readonly StripSegment[], from: number, to: number): BufferGeometry {
  const curve = stripCurve(segments);
  const paint = groundPainter(groundPalette(look), ROAD_VERGE_M);
  // Sloupec = (strana, odstup od kraje); prostřední leží pod cestou.
  const columns: readonly (readonly [side: number, offset: number])[] = [...ROAD_COLUMNS.map((d) => [-1, d] as const).reverse(), [0, 0], ...ROAD_COLUMNS.map((d) => [1, d] as const)];
  const rows = Math.max(1, Math.ceil((to - from) / ROAD_ROW_M));
  const positions = new Float32Array((rows + 1) * columns.length * 3);
  const colors = new Float32Array(positions.length);
  const color = new Color();
  for (let row = 0; row <= rows; row += 1) {
    const z = Math.min(to, from + row * ROAD_ROW_M);
    const { center, width } = curve(z);
    columns.forEach(([side, offset], column) => {
      const x = center + side * (width / 2 + offset);
      paint(x, z, side === 0 ? -width / 2 : offset, color);
      const at = (row * columns.length + column) * 3;
      positions.set([x, 0, z], at);
      colors.set([color.r, color.g, color.b], at);
    });
  }
  const index: number[] = [];
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column + 1 < columns.length; column += 1) {
      const a = row * columns.length + column;
      const [b, c, d] = [a + 1, a + columns.length, a + columns.length + 1];
      index.push(a, c, b, b, c, d);
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new Float32BufferAttribute(colors, 3));
  geometry.setIndex(index);
  geometry.computeVertexNormals();
  return geometry;
}
