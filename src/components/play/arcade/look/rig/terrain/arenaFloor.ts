/**
 * Podlaha arény (P32A T9, ukázka B): hrací plocha podle sady – dlažba hradu
 * a města, led zamrzlého jezera, tráva, písek s čeřinami, holá skála – a za
 * její hranou prstenec stěn: hradby s cimbuřím a věžemi, sněhové a ledové
 * kvádry, balvany. Scéna arény (P32E T5) kreslí `floor` a `walls`, kulisy sady
 * postaví `Scenery` po stranách od `sceneryInner` (jako dnes `ArenaScene`).
 *
 * Celá podlaha leží v y = 0, na zemi jádra (`playableGround`): hráč ani věci
 * nevisí, ani se neboří. Vzor nese barva trojúhelníků, ne výška. Stěny stojí až
 * za hranou a jádro o nich neví – hranou arény je hrana jádra, ne tahle síť.
 *
 * Bez indexů, flat shading, barvy ve vrcholech z palety sady. Čistá funkce
 * vstupu: žádná náhoda, tatáž aréna vypadá pokaždé stejně.
 */

import { type BufferGeometry, Color } from 'three';

import type { Look } from '@/play/arcade/look';

import { Faces, type Vertex, capOf } from './islands';
import { hash, mix, noise } from './valley';

export interface ArenaPalette {
  readonly floor: string;
  /** Spára dlažby, prasklina ledu, hřbet čeřiny, tmavší trs trávy. */
  readonly seam: string;
  /** Zem za hranou arény. */
  readonly land: string;
  readonly wall: string;
  readonly wallTop: string;
}

/** Barvy arény podle `cover`: dlažba z hmoty bloků sady, led z ledové dráhy, jinak souš sady. */
export function arenaPalette(look: Look): ArenaPalette {
  const land = look.land ?? look.ground;
  const rock = look.terrain?.rock ?? look.block?.[0] ?? mix(land, '#57534e', 0.6);
  switch (look.cover) {
    case 'paving': {
      const floor = look.block?.[1] ?? land;
      return { floor, seam: mix(floor, '#1c1917', 0.45), land, wall: look.block?.[0] ?? rock, wallTop: floor };
    }
    case 'snow': {
      const floor = look.terrain?.lane ?? mix(land, look.water, 0.4);
      return { floor, seam: mix(floor, '#ffffff', 0.55), land, wall: look.block?.[0] ?? mix(land, floor, 0.5), wallTop: look.terrain?.cap ?? land };
    }
    case 'sand':
      return { floor: land, seam: mix(land, '#ffffff', 0.13), land, wall: mix(land, rock, 0.55), wallTop: land };
    case 'rock':
      return { floor: land, seam: mix(land, '#000000', 0.35), land, wall: rock, wallTop: mix(rock, '#ffffff', 0.12) };
    default:
      return { floor: land, seam: mix(land, '#000000', 0.22), land, wall: rock, wallTop: mix(rock, land, 0.5) };
  }
}

/** Mezera mezi hranou arény a stěnou, tloušťka stěny a odstup kulis za ní (m). */
const WALL_GAP = 0.8;
const WALL_DEPTH = 1.2;
const SCENERY_GAP = 2.5;
/** Kam za hranu podlaha ještě sahá (m): za kulisy do mlhy. */
const BEYOND = 50;
/** Dlaždice hradní dlažby na vazbu (m) a šířka spáry. */
const STONE = [2, 1.25] as const;
const SEAM = 0.08;

/** Obdélník v y = 0 s normálou nahoru. */
function rect(faces: Faces, x0: number, z0: number, x1: number, z1: number, color: Color): void {
  if (x1 - x0 < 1e-6 || z1 - z0 < 1e-6) return;
  faces.tri([x0, 0, z0], [x0, 0, z1], [x1, 0, z0], color);
  faces.tri([x1, 0, z0], [x0, 0, z1], [x1, 0, z1], color);
}

/**
 * Rovná mřížka v y = 0 s posunutými vnitřními vrcholy (okraj zůstává rovný,
 * sousední plochy na sebe navazují). `paint` dostane střed trojúhelníku a jeho pořadí.
 */
function grid(faces: Faces, x0: number, z0: number, x1: number, z1: number, cell: number, seed: number, paint: (x: number, z: number, index: number) => Color): void {
  const columns = Math.max(1, Math.round((x1 - x0) / cell));
  const rows = Math.max(1, Math.round((z1 - z0) / cell));
  const [cx, cz] = [(x1 - x0) / columns, (z1 - z0) / rows];
  const at = (column: number, row: number): Vertex => {
    const inner = column > 0 && column < columns && row > 0 && row < rows;
    return [
      x0 + column * cx + (inner ? (hash(seed + column, row) - 0.5) * 0.6 * cx : 0),
      0,
      z0 + row * cz + (inner ? (hash(column, seed + row) - 0.5) * 0.6 * cz : 0),
    ];
  };
  let index = 0;
  const tri = (a: Vertex, b: Vertex, c: Vertex): void => {
    faces.tri(a, b, c, paint((a[0] + b[0] + c[0]) / 3, (a[2] + b[2] + c[2]) / 3, index));
    index += 1;
  };
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const [a, b, c, d] = [at(column, row), at(column + 1, row), at(column + 1, row + 1), at(column, row + 1)];
      if (hash(column * 7 + seed, row) < 0.5) {
        tri(a, d, b);
        tri(b, d, c);
      } else {
        tri(a, c, b);
        tri(a, d, c);
      }
    }
  }
}

/** Hradní dlažba na vazbu: řady kamenů posunuté o půl kamene, mezi nimi spáry. */
function paving(faces: Faces, half: number, stone: Color, seam: Color, face: Color): void {
  const [w, d] = STONE;
  for (let row = 0, z0 = -half; z0 < half; row += 1, z0 += d) {
    const z1 = Math.min(half, z0 + d);
    const top = z1 < half ? z1 - SEAM : z1;
    rect(faces, -half, top, half, z1, seam);
    for (let k = 0, x0 = -half - (row % 2) * (w / 2); x0 < half; k += 1, x0 += w) {
      const x1 = x0 + w;
      const edge = x1 < half ? x1 - SEAM : half;
      const tone = hash(row * 97 + k, 5);
      face.copy(stone).multiplyScalar(0.86 + 0.2 * hash(row, k));
      // Tu a tam tmavší kámen, ať dlažba není vzorník.
      if (tone < 0.08) face.lerp(seam, 0.35);
      rect(faces, Math.max(-half, x0), z0, Math.min(half, edge), top, face);
      if (x1 < half) rect(faces, x1 - SEAM, z0, x1, top, seam);
    }
  }
}

const CORNERS = [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const;
const CORNERS_ACROSS = [[-1, -1], [-1, 1], [1, 1], [1, -1]] as const;

/**
 * Hranol mezi spodním a horním obdélníkem kolem středu (x, z): `w` podél stěny,
 * `d` napříč. `along` = stěna běží po ose x (jinak po z). `rough` posune rohy –
 * 0 = tesaný kvádr, víc = balvan. Spodek je pod podlahou, nekreslí se.
 */
function block(faces: Faces, x: number, z: number, w: number, d: number, from: number, to: number, along: boolean, rough: number, seed: number, paint: (up: number) => Color): void {
  // Rohy (podél, napříč) v pořadí, které ve scéně dá kladnou plochu (`ccw`) pro obě osy stěny.
  const order = along ? CORNERS : CORNERS_ACROSS;
  const corners = (y: number, inset: number, salt: number): Vertex[] =>
    order.map(([u, v], i): Vertex => {
      const du = u * (w / 2) * (1 - inset) + (hash(seed + salt, i) - 0.5) * rough * w;
      const dv = v * (d / 2) * (1 - inset) + (hash(seed + salt, i + 4) - 0.5) * rough * d;
      const lift = y > from ? (hash(seed + salt, i + 8) - 0.5) * rough * (to - from) : 0;
      return along ? [x + du, y + lift, z + dv] : [x + dv, y + lift, z + du];
    });
  const bottom = corners(from, 0, 1);
  const top = corners(to, rough * 1.6, 2);
  faces.band(top, bottom, seed, (_, up) => paint(up));
  const [cx, cz] = [top.reduce((s, v) => s + v[0], 0) / 4, top.reduce((s, v) => s + v[2], 0) / 4];
  capOf(faces, [cx, Math.max(...top.map((v) => v[1])), cz], top, () => paint(1));
}

export interface ArenaFloor {
  /** Hrací plocha a zem za ní až do mlhy, celá v y = 0. */
  readonly floor: BufferGeometry;
  /** Prstenec stěn za hranou arény. */
  readonly walls: BufferGeometry;
  /** Odkud za stěnami stojí kulisy (m od středu, `Scenery` po stranách). */
  readonly sceneryInner: number;
  /** Výška podlahy, kterou síť kreslí (m) – všude zem jádra. */
  heightAt(x: number, z: number): number;
}

export interface ArenaFloorOptions {
  readonly look: Look;
  /** Půl strany čtvercové hrací plochy (m). */
  readonly half: number;
}

export function buildArenaFloor({ look, half }: ArenaFloorOptions): ArenaFloor {
  const palette = arenaPalette(look);
  const [floor, seam, land, wall, wallTop] = [palette.floor, palette.seam, palette.land, palette.wall, palette.wallTop].map((hex) => new Color(hex)) as [Color, Color, Color, Color, Color];
  const face = new Color();
  const shade = (color: Color, scale: number): Color => face.copy(color).multiplyScalar(scale);

  // --- Podlaha ---
  const ground = new Faces();
  if (look.cover === 'paving') paving(ground, half, floor, seam, face);
  else {
    const cell = look.cover === 'snow' ? 2.4 : 1.6;
    grid(ground, -half, -half, half, half, cell, 11, (x, z, index) => {
      const tone = 0.93 + 0.1 * hash(index, 3);
      if (look.cover === 'snow') {
        // Ledové kry dvou odstínů, bílé praskliny a u hrany závěj sněhu.
        shade(floor, tone);
        if (noise(x * 0.12 + 3, z * 0.12) > 0.62) face.lerp(seam, 0.4);
        if (hash(index, 7) < 0.03) face.copy(seam);
        const edge = half - Math.max(Math.abs(x), Math.abs(z));
        return edge < 1.6 ? face.lerp(land, 1 - edge / 1.6) : face;
      }
      if (look.cover === 'sand') {
        // Čeřiny: pruhy napříč, zvlněné šumem.
        const ripple = Math.sin(x * 1.1 + z * 0.4 + noise(x * 0.08, z * 0.08) * 7);
        return ripple > 0.75 ? shade(seam, tone) : shade(floor, ripple < -0.75 ? tone * 0.93 : tone);
      }
      // Tráva a skála: skvrny světlejší a tmavší plochy, u skály i praskliny.
      const patch = noise(x * 0.2 + 9, z * 0.2);
      if (look.cover === 'rock' && hash(index, 7) < 0.05) return shade(seam, 1);
      if (patch < 0.32) return shade(floor, tone).lerp(seam, 0.45);
      return shade(floor, patch > 0.68 ? tone * 1.08 : tone);
    });
  }
  // Zem za hranou: čtyři pásy kolem hrací plochy, hrubší mřížka.
  const outer = half + BEYOND;
  const paintLand = (_x: number, _z: number, index: number): Color => shade(land, 0.92 + 0.12 * hash(index, 13));
  grid(ground, -outer, half, outer, outer, 3, 21, paintLand);
  grid(ground, -outer, -outer, outer, -half, 3, 22, paintLand);
  grid(ground, -outer, -half, -half, half, 3, 23, paintLand);
  grid(ground, half, -half, outer, half, 3, 24, paintLand);

  // --- Stěny ---
  const walls = new Faces();
  const inner = half + WALL_GAP;
  const middle = inner + WALL_DEPTH / 2;
  const castle = look.cover === 'paving';
  const rough = castle ? 0.015 : 0.14;
  const [low, high] = castle ? [2, 2] : look.cover === 'rock' ? [1.3, 2.4] : [0.9, 1.7];
  const paintWall = (seed: number) => (up: number) => (up > 0.7 ? shade(wallTop, 0.95 + 0.1 * hash(seed, 1)) : shade(wall, 0.85 + 0.2 * hash(seed, 2)));
  let seed = 100;
  for (const [sign, along] of [[1, true], [-1, true], [1, false], [-1, false]] as const) {
    // Stěna jde po straně od rohu k rohu; rohy drží věže nebo největší balvany.
    let t = -inner;
    while (t < inner - 0.2) {
      seed += 1;
      const length = Math.min(inner - t, castle ? 2 : 1.3 + hash(seed, 3));
      const height = low + (high - low) * hash(seed, 4);
      const [x, z] = along ? [t + length / 2, sign * middle] : [sign * middle, t + length / 2];
      block(walls, x, z, length - (castle ? 0.04 : 0), WALL_DEPTH, -0.15, height, along, rough, seed, paintWall(seed));
      // Cimbuří: zub na každém druhém kvádru hradby.
      if (castle && seed % 2 === 0) block(walls, x, z, length * 0.45, WALL_DEPTH * 0.8, height - 0.02, height + 0.55, along, rough, seed + 5000, paintWall(seed));
      t += length;
    }
  }
  const size = castle ? 2.6 : 2;
  // Věž v rohu sahá za roh stěn, ne do rohu arény.
  const corner = inner + size / 2 - 0.3;
  for (const [sx, sz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]] as const) {
    seed += 1;
    block(walls, sx * corner, sz * corner, size, size, -0.15, castle ? 3.2 : high + 0.4, true, rough, seed, paintWall(seed));
  }

  return { floor: ground.geometry(), walls: walls.geometry(), sceneryInner: inner + WALL_DEPTH + SCENERY_GAP, heightAt: () => 0 };
}
