/**
 * Údolí běžce (P32A T3, ukázka B): ledová dráha se zubatým krajem, sněhové
 * náspy a za nimi svahy do hor. Posunutá rovina – mřížka sloupců napříč tratí
 * a řad podél ní – bez indexů a s normálou na plochu (flat shading), barvy
 * ve vrcholech z palety sady (`valleyPalette`).
 *
 * Uvnitř hrací plochy (`PLAYABLE_HALF`) má každý vrchol přesně výšku země jádra
 * (`playableGround`, všude 0), takže každý bod uvnitř leží v trojúhelníku ze
 * samých nul. Mimo ni se terén tvaruje libovolně. `heightAt` vrací výšku, kterou
 * síť opravdu kreslí (tentýž trojúhelník, lineárně) – kulisy na ní stojí.
 *
 * Čistá funkce vstupu: žádná náhoda, táž trať má pokaždé stejné údolí.
 */

import { BufferGeometry, Color, Float32BufferAttribute } from 'three';

import { UNIT } from '@/play/arcade/contract';
import type { Look } from '@/play/arcade/look';
import { RUNNER } from '@/play/arcade/pieces/runner';

/** Půl šířky dráhy (m): pruhy jádra. */
export const LANE_HALF = (RUNNER.lanes * RUNNER.laneWidth) / UNIT / 2;
/** Půl šířky hrací plochy (m): dráha, zubatý kraj ledu a rezerva na nejširší tělo. */
export const PLAYABLE_HALF = LANE_HALF + 1.5;

/** Sloupce na jedné straně (m od osy): hustě u dráhy, řídce v horách. */
const COLUMNS = [0, 1, 2, LANE_HALF, LANE_HALF + 0.75, PLAYABLE_HALF, 5.5, 6.8, 8.4, 10.4, 12.8, 15.6, 19, 23, 28, 34, 41, 49, 58, 68];
const XS = [...COLUMNS.slice(1).reverse().map((x) => -x), ...COLUMNS];
/** Krok řad podél trati (m). */
const ROW = 2;

export interface ValleyPalette {
  readonly surface: string;
  readonly shade: string;
  readonly rock: string;
}

export const mix = (from: string, to: string, t: number): string => `#${new Color(from).lerp(new Color(to), t).getHexString()}`;

/** Barvy údolí: povrch je země sady, stín a skála z `look.terrain`, jinak odvozené. Dráhu kreslí pás cesty (P46G T2). */
export function valleyPalette(look: Look): ValleyPalette {
  const surface = look.ground;
  return {
    surface,
    shade: look.terrain?.shade ?? mix(surface, look.light[1], 0.35),
    rock: look.terrain?.rock ?? mix(surface, '#57534e', 0.6),
  };
}

/** Celočíselný hash dvou souřadnic do [0, 1). Sdílí ho i ostatní generátory terénu (T9). */
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

/** Výška vrcholu mimo hrací plochu: násep, svah do hor a hrbolatost, která s odstupem roste. */
function reliefAt(x: number, z: number): number {
  const d = Math.abs(x) - PLAYABLE_HALF;
  const side = x < 0 ? 37 : 0;
  const bank = 1.1 * smooth(d / 6);
  const slope = 26 * Math.pow(Math.max(0, d - 5) / 30, 1.5);
  const rough = (0.65 * noise(x * 0.11 + side, z * 0.09) + 0.35 * noise(x * 0.27 + side, z * 0.23) - 0.5) * (0.3 + d * 0.16);
  return Math.max(0.04 * d, bank + slope + rough);
}

/** Posun řad sloupce podél trati (m) – mřížka tak nepůsobí jako mřížka. Hrací plocha ho nemá. */
const shiftOf = (column: number): number => (Math.abs(XS[column]!) <= PLAYABLE_HALF ? 0 : (hash(column, 911) - 0.5) * 0.9 * ROW);

/** Úhlopříčka buňky: střídá se podle hashe, trojúhelníky pak nejdou v pruzích. */
const flipped = (column: number, row: number): boolean => hash(column * 7 + 3, row) < 0.5;

export interface Valley {
  readonly geometry: BufferGeometry;
  /** Výška nakreslené sítě v bodě scény (m); mimo síť výška nejbližšího okraje. */
  heightAt(x: number, z: number): number;
}

export interface ValleyOptions {
  readonly look: Look;
  /** Rozsah údolí podél trati (m, osa z scény). */
  readonly from: number;
  readonly to: number;
}

export function buildValley({ look, from, to }: ValleyOptions): Valley {
  const rows = Math.max(1, Math.ceil((to - from) / ROW));
  const shifts = XS.map((_, column) => shiftOf(column));
  const zAt = (column: number, row: number): number => from + row * ROW + shifts[column]!;
  // Výšky vrcholů: řada `row` sloupce `column` na indexu `row * XS.length + column`.
  const heights = new Float32Array((rows + 1) * XS.length);
  for (let row = 0; row <= rows; row += 1) {
    for (let column = 0; column < XS.length; column += 1) {
      const x = XS[column]!;
      heights[row * XS.length + column] = Math.abs(x) <= PLAYABLE_HALF ? 0 : reliefAt(x, zAt(column, row));
    }
  }
  const h = (column: number, row: number): number => heights[row * XS.length + column]!;

  const palette = valleyPalette(look);
  const colors = { surface:new Color(palette.surface), shade: new Color(palette.shade), rock: new Color(palette.rock) };
  const cells = rows * (XS.length - 1);
  const positions = new Float32Array(cells * 18);
  const tints = new Float32Array(cells * 18);
  const face = new Color();
  let at = 0;
  const corner = (column: number, row: number): void => {
    positions[at] = XS[column]!;
    positions[at + 1] = h(column, row);
    positions[at + 2] = zAt(column, row);
    at += 3;
  };
  /** Barva trojúhelníku z posledních devíti souřadnic: led, sníh, stín nebo skála podle polohy a sklonu. */
  const paint = (index: number): void => {
    const p = positions;
    const o = at - 9;
    const [ax, ay, az, bx, by, bz, cx, cy, cz] = [p[o]!, p[o + 1]!, p[o + 2]!, p[o + 3]!, p[o + 4]!, p[o + 5]!, p[o + 6]!, p[o + 7]!, p[o + 8]!];
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = cx - ax, vy = cy - ay, vz = cz - az;
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const up = ny / Math.max(1e-9, Math.hypot(nx, ny, nz));
    const mx = (ax + bx + cx) / 3;
    const mz = (az + bz + cz) / 3;
    // Dráhu kreslí hladký pás nad údolím (P46G T2): zubatý kraj po trojúhelnících tu nechával schody.
    if (up < 0.5) face.copy(colors.rock);
    else if (up < 0.78 || noise(mx * 0.2 + 50, mz * 0.2) > 0.72) face.copy(colors.shade);
    else face.copy(colors.surface);
    face.multiplyScalar(0.94 + 0.1 * hash(index, 17));
    for (let k = o; k < at; k += 3) {
      tints[k] = face.r;
      tints[k + 1] = face.g;
      tints[k + 2] = face.b;
    }
  };
  let index = 0;
  const triangle = (corners: readonly (readonly [number, number])[]): void => {
    for (const [column, row] of corners) corner(column, row);
    paint(index);
    index += 1;
  };
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < XS.length - 1; column += 1) {
      // Rohy buňky a (sloupec, řada), b (+1, řada), c (+1, +1), d (sloupec, +1); pořadí vrcholů dává normálu nahoru.
      const [a, b, c, d] = [[column, row], [column + 1, row], [column + 1, row + 1], [column, row + 1]] as const;
      if (flipped(column, row)) {
        triangle([a, d, b]);
        triangle([b, d, c]);
      } else {
        triangle([a, c, b]);
        triangle([a, d, c]);
      }
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new Float32BufferAttribute(tints, 3));
  geometry.computeVertexNormals();

  const heightAt = (x: number, z: number): number => {
    if (Math.abs(x) <= PLAYABLE_HALF) return 0;
    const cx = Math.min(Math.max(x, XS[0]!), XS[XS.length - 1]!);
    let column = 0;
    while (column < XS.length - 2 && XS[column + 1]! < cx) column += 1;
    const t = (cx - XS[column]!) / (XS[column + 1]! - XS[column]!);
    // Buňka je rovnoběžník: svislé hrany po ose z, řady posunuté o posun sloupce.
    const v = Math.min(Math.max((z - from - (shifts[column]! + t * (shifts[column + 1]! - shifts[column]!))) / ROW, 0), rows);
    const row = Math.min(Math.floor(v), rows - 1);
    const s = v - row;
    const a = h(column, row);
    const b = h(column + 1, row);
    const c = h(column + 1, row + 1);
    const d = h(column, row + 1);
    if (flipped(column, row)) return t + s <= 1 ? a + t * (b - a) + s * (d - a) : c + (1 - t) * (d - c) + (1 - s) * (b - c);
    return s <= t ? a + t * (b - a) + s * (c - b) : a + s * (d - a) + t * (c - d);
  };
  return { geometry, heightAt };
}
