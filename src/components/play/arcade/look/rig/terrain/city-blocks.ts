/**
 * Městské domy z kvádrů s okny (P46G, doplněk 14. 10.): ve městě jsou desky
 * plošinovky střechy domů a za břehem stojí ulice. Ostrůvky ze skály tam na
 * snímku nečetly jako město („cat jumps across rooftops“ skákala po šedých
 * útesech). Fasáda v barvě z malé palety, okna v mřížce pater, část rozsvícená;
 * všechny domy jsou jedna síť s barvou ve vrcholech (jedno kreslicí volání).
 * Čistá funkce vstupu – žádná náhoda, stejná úroveň má pokaždé stejné domy.
 */

import { type BufferGeometry, Color } from 'three';

import type { Look } from '@/play/arcade/look';

import { hash } from '../../ground';
import { Faces, type Vertex } from './islands';

/** Kvádr domu ve scéně (m). */
export interface Block {
  readonly x0: number;
  readonly x1: number;
  readonly z0: number;
  readonly z1: number;
  readonly base: number;
  readonly top: number;
}

export type BlockSide = '-x' | '+x' | '-z' | '+z';

/** Sady, kde jsou desky střechy domů: dlažba a asfalt (město, továrna). */
export const urbanLook = (look: Look): boolean => look.cover === 'paving' && look.surface === 'asphalt';

/** Fasády: pískovec, cihla, šedá omítka, krémová, hnědá. */
const FACADES = ['#c9b79c', '#a4614a', '#8d96a3', '#d8cbb3', '#7f6a5a'].map((hex) => new Color(hex));
const GLASS = new Color('#2a3442');
const LIT = new Color('#f3d27a');
/** Podíl rozsvícených oken. */
const LIT_SHARE = 0.18;
/** Patro a šířka okenní osy (m), okno v ní a parapet nad podlahou patra. */
const FLOOR = 1.6;
const BAY = 1.4;
const WIN_W = 0.7;
const WIN_H = 0.85;
const SILL = 0.45;
/** Okno předsazené před fasádu (m), ať s ní nebojuje o hloubku. */
const OUT = 0.03;
/** Pod nejnižším patrem a nad nejvyšším zůstane plná zeď (m). */
const PLINTH = 0.5;
const CROWN = 0.35;

type Axis = readonly [number, number, number];
const UP: Axis = [0, 1, 0];

/** Stěna jako počátek, vodorovný směr `u` (délka `a`) a svislá výška `b`; normála je u × nahoru – ven. */
interface Wall {
  readonly o: Axis;
  readonly u: Axis;
  readonly n: Axis;
  readonly a: number;
}

const at = (o: Axis, u: Axis, s: number, v: Axis, t: number, n: Axis = UP, k = 0): Vertex => [o[0] + u[0] * s + v[0] * t + n[0] * k, o[1] + u[1] * s + v[1] * t + n[1] * k, o[2] + u[2] * s + v[2] * t + n[2] * k];

function quad(faces: Faces, o: Axis, u: Axis, v: Axis, s0: number, s1: number, t0: number, t1: number, color: Color, n: Axis = UP, k = 0): void {
  const [p0, p1, p2, p3] = [at(o, u, s0, v, t0, n, k), at(o, u, s1, v, t0, n, k), at(o, u, s1, v, t1, n, k), at(o, u, s0, v, t1, n, k)];
  faces.tri(p0, p1, p2, color);
  faces.tri(p0, p2, p3, color);
}

function wallsOf(b: Block): Record<BlockSide, Wall> {
  const [w, d] = [b.x1 - b.x0, b.z1 - b.z0];
  return {
    '-x': { o: [b.x0, b.base, b.z0], u: [0, 0, 1], n: [-1, 0, 0], a: d },
    '+x': { o: [b.x1, b.base, b.z1], u: [0, 0, -1], n: [1, 0, 0], a: d },
    '+z': { o: [b.x0, b.base, b.z1], u: [1, 0, 0], n: [0, 0, 1], a: w },
    '-z': { o: [b.x1, b.base, b.z0], u: [-1, 0, 0], n: [0, 0, -1], a: w },
  };
}

/**
 * Domy jako jedna síť. `sides` jsou stěny, které kamera může vidět; `roof` přidá
 * střechu (u desek ji kreslí ostrůvek). Okna jen tam, kde se vejde celé patro.
 */
export function buildBlocks(blocks: readonly Block[], seed: number, sides: readonly BlockSide[], roof: boolean): BufferGeometry {
  const faces = new Faces();
  const shade = new Color();
  blocks.forEach((b, index) => {
    const h = (salt: number, i = 0): number => hash(seed + index * 7919 + salt, i);
    const facade = FACADES[Math.floor(h(1) * FACADES.length)]!;
    const height = b.top - b.base;
    const floors = Math.floor((height - PLINTH - CROWN) / FLOOR);
    const walls = wallsOf(b);
    sides.forEach((side, s) => {
      const wall = walls[side];
      // Boky napříč tratí jsou z boční kamery v ostrém úhlu: o kousek tmavší, ať se dům čte jako kvádr.
      quad(faces, wall.o, wall.u, UP, 0, wall.a, 0, height, shade.copy(facade).multiplyScalar(side === '-x' ? 1 : 0.82), wall.n);
      const bays = Math.floor(wall.a / BAY);
      if (bays < 1 || floors < 1) return;
      const margin = (wall.a - bays * BAY) / 2;
      for (let f = 0; f < floors; f += 1) {
        for (let k = 0; k < bays; k += 1) {
          const s0 = margin + k * BAY + (BAY - WIN_W) / 2;
          const t0 = PLINTH + f * FLOOR + SILL;
          const glass = h(100 + s, f * 64 + k) < LIT_SHARE ? LIT : GLASS;
          quad(faces, wall.o, wall.u, UP, s0, s0 + WIN_W, t0, t0 + WIN_H, glass, wall.n, OUT);
        }
      }
    });
    if (roof) quad(faces, [b.x0, b.top, b.z0], [0, 0, 1], [1, 0, 0], 0, b.z1 - b.z0, 0, b.x1 - b.x0, shade.copy(facade).multiplyScalar(0.6));
  });
  return faces.geometry();
}

/**
 * Ulice za tratí: řada domů podél z od `from` do `to`, přední stěna v `x0`.
 * Šířka 5–9 m, hloubka 6–9 m, výška 4–16 m, mezi domy občas ulička.
 */
export function streetBlocks({ from, to, x0, base, seed }: { readonly from: number; readonly to: number; readonly x0: number; readonly base: number; readonly seed: number }): Block[] {
  const blocks: Block[] = [];
  let z = from;
  for (let i = 0; z < to; i += 1) {
    const r = (salt: number): number => hash(seed + salt, i);
    const width = 5 + 4 * r(1);
    const front = x0 + 1.5 * r(2);
    blocks.push({ x0: front, x1: front + 6 + 3 * r(3), z0: z, z1: z + width, base, top: base + 4 + 12 * r(4) * r(4) + 2 * r(5) });
    z += width + (r(6) < 0.3 ? 1.5 : 0);
  }
  return blocks;
}
