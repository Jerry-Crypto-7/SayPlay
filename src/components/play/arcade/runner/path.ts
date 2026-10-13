/**
 * Tvar trati běžce ve scéně (P46D T3): zatáčky a kopce jako čistá funkce semínka
 * světa a `z`. Jen kresba – jádro dál běží v rovných pruzích, takže hash, robot ani
 * uložené hry se nehnou. Scéna každý bod jádra (x, y, z) kreslí posunutý o
 * `pathAt(seed, z)`: hrdinu, překážky, terén, kulisy i kameru (`placeRunner`).
 *
 * Křivka se počítá jen ze semínka, nikdy z hodin nebo náhody, takže se mezi snímky
 * nehne. Start je rovný (úvodní průlet), most a tunel vedou po rovině (`levelSpansOf`).
 */

import type { BufferGeometry, BufferAttribute } from 'three';

import { BODY, HEADER, type ArcadeWorld, UNIT, bodyBase } from '@/play/arcade/contract';
import { baseControlOf } from '@/play/arcade/addons';

/** Posun bodu trati ve scéně (m): `x` do strany (x scény), `y` nahoru. */
export interface PathPoint {
  readonly x: number;
  readonly y: number;
}

/** Úsek, kde trať vede po rovině (most, tunel): od–do v metrech osy z. */
export interface PathSpan {
  readonly from: number;
  readonly to: number;
}

export type Path = (z: number) => PathPoint;

/** Do kolika metrů je trať rovná a na kolika metrech se zatáčky a kopce rozjedou. */
const STRAIGHT_M = 6;
const EASE_M = 40;
/** Na kolika metrech před mostem či tunelem a za ním se kopec srovná. */
const LEVEL_EASE_M = 12;

const smooth = (t: number): number => {
  const c = Math.min(1, Math.max(0, t));
  return c * c * (3 - 2 * c);
};

/** Celočíselný hash semínka a pořadí parametru do [0, 1) – stejný na serveru i v prohlížeči. */
function unit(seed: number, index: number): number {
  let h = Math.imul(seed ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(index + 1, 0xc2b2ae35);
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

interface Wave {
  readonly amp: number;
  /** Úhlová frekvence (rad/m). */
  readonly k: number;
  readonly phase: number;
}

/**
 * Vlny zatáček a kopců. Nejprudší součet sklonů (A·k) drží pod 0,3 v bok a 0,12
 * nahoru, takže na metr trati se bod nehne o víc než ~0,5 m ani v náběhu.
 */
function wavesOf(seed: number): { readonly side: readonly Wave[]; readonly lift: readonly Wave[] } {
  const wave = (at: number, amp: readonly [number, number], length: readonly [number, number]): Wave => ({
    amp: amp[0] + (amp[1] - amp[0]) * unit(seed, at),
    k: (2 * Math.PI) / (length[0] + (length[1] - length[0]) * unit(seed, at + 1)),
    phase: 2 * Math.PI * unit(seed, at + 2),
  });
  return {
    side: [wave(0, [2, 3.5], [120, 170]), wave(3, [0.5, 1], [60, 85])],
    lift: [wave(6, [0.6, 1.5], [80, 130])],
  };
}

/** Součet vln od konce rovného startu, kde je nula. */
const sumOf = (waves: readonly Wave[], z: number): number =>
  waves.reduce((sum, { amp, k, phase }) => sum + amp * (Math.sin(phase + k * (z - STRAIGHT_M)) - Math.sin(phase)), 0);

/** Křivka trati jednoho semínka; `level` = úseky, kde trať vede po rovině. */
export function pathOf(seed: number, level: readonly PathSpan[] = []): Path {
  const { side, lift } = wavesOf(seed);
  const ease = (z: number): number => smooth((z - STRAIGHT_M) / EASE_M);
  const hill = (z: number): number => ease(z) * sumOf(lift, z);
  const spans = [...level].sort((a, b) => a.from - b.from).map((span) => ({ ...span, y: hill((span.from + span.to) / 2) }));
  return (z) => {
    let y = hill(z);
    // Úseky po sobě: každý srovná výšku ke své rovině, takže se sousední náběhy navážou bez skoku.
    for (const span of spans) {
      const toward = z < span.from ? smooth(1 - (span.from - z) / LEVEL_EASE_M) : z > span.to ? smooth(1 - (z - span.to) / LEVEL_EASE_M) : 1;
      y += (span.y - y) * toward;
    }
    return { x: ease(z) * sumOf(side, z), y };
  };
}

/** Bod křivky semínka `seed` ve vzdálenosti `z` (m). */
export function pathAt(seed: number, z: number, level: readonly PathSpan[] = []): PathPoint {
  return pathOf(seed, level)(z);
}

/** Most vede přes propast místo vody – u třetiny semínek, ať se tratě liší i tím. */
export const bridgesOverChasm = (seed: number): boolean => unit(seed, 9) < 0.35;

/** Sklon křivky v `z` (m posunu na metr trati) – kamera a natočení těl jdou po tečně. */
export function slopeAt(path: Path, z: number): PathPoint {
  const ahead = path(z + 0.5);
  const behind = path(z - 0.5);
  return { x: ahead.x - behind.x, y: ahead.y - behind.y };
}

/** Druhy těl stavby (`runner-sections.ts`), které vedou trať po rovině: voda pod mostem a strop tunelu. */
const LEVEL_KINDS: ReadonlySet<string> = new Set(['water', 'ceiling']);

/** Úseky mostů a tunelů z počátečního stavu světa (m). */
export function levelSpansOf(world: Pick<ArcadeWorld, 'kinds' | 'initial'>): PathSpan[] {
  const spans = new Map<string, PathSpan>();
  const count = world.initial[HEADER.bodyCount] as number;
  for (let index = 0; index < count; index += 1) {
    const base = bodyBase(index);
    if (!LEVEL_KINDS.has(world.kinds[world.initial[base + BODY.kind] as number] ?? '')) continue;
    const z = (world.initial[base + BODY.z] as number) / UNIT;
    const half = (world.initial[base + BODY.d] as number) / UNIT / 2;
    // Most má vodu ve dvou pruzích: dvě těla, jeden úsek.
    spans.set(`${z - half}:${z + half}`, { from: z - half, to: z + half });
  }
  return [...spans.values()];
}

const paths = new WeakMap<object, Path | null>();

/** Křivka světa běžce (mosty a tunely po rovině); jiný žánr `null` – kreslí se rovně. */
export function runnerPathOf(world: ArcadeWorld): Path | null {
  let path = paths.get(world);
  if (path === undefined) {
    path = baseControlOf(world.control).id === 'runner' ? pathOf(world.seed, levelSpansOf(world)) : null;
    paths.set(world, path);
  }
  return path;
}

/**
 * Ohne síť po křivce: každý vrchol posune o rozdíl křivky v jeho `z` proti `z0`,
 * kde stojí skupina sítě. Údolí (`z0` = 0) i dlouhá stavba tak sedí na zatáčce celé.
 */
export function bendGeometry(geometry: BufferGeometry, path: Path, z0 = 0): BufferGeometry {
  const position = geometry.getAttribute('position') as BufferAttribute;
  const origin = path(z0);
  for (let index = 0; index < position.count; index += 1) {
    const at = path(z0 + position.getZ(index));
    position.setXY(index, position.getX(index) + at.x - origin.x, position.getY(index) + at.y - origin.y);
  }
  position.needsUpdate = true;
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  geometry.computeBoundingBox();
  return geometry;
}
