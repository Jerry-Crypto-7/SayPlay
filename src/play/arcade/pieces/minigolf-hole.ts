/**
 * Jamka minigolfu (P68 T6): generátor dráhy ze streamu `minigolf` a tvrzení „řešitelná konstrukcí“.
 *
 * Dráha je z dlaždic `MINIGOLF.tile` × `tile` na mřížce (sloupec, řada): rovná (3–4 dlaždice po +z), L (3 dlaždice
 * po +z, pak 2–3 doleva nebo doprava) nebo S (3 po +z, 2 napříč, 2–3 po +z). Mantinely leží na každé hraně dlaždice,
 * za kterou už dlaždice není (spojené v jednu stěnu, ve vnějších rozích prodloužené, ať roh nemá škvíru). Odpaliště
 * je vzadu první dlaždice, jamka v poslední. 1–3 statické odrazníky leží mimo trasu robota, nejvýš jedna pohyblivá
 * překážka (kinematická, kyvadlo jádra s periodou v tikách) jezdí napříč chodbou prostřední dlaždice úseku.
 *
 * **Trasa robota** jde do parametrů světa (`MinigolfLayout.route`, ovládání, pravidlo i robot): 1–3 body, kam robot
 * míček zastaví – rohy dráhy a nakonec střed jamky. `checkMinigolfHole` ověří, že z odpaliště a z každého bodu vede
 * k dalšímu volná přímka v šířce míčku a rezervy (žádný mantinel ani odrazník), že pohyblivá překážka ji aspoň v jedné
 * krajní poloze pustí a že každý úsek ujede jedna rána.
 */

import { z } from 'zod';

import { createStreams, nextInt } from '@/sim/rng';

import { ARCADE_LIMITS, type ArcadeLevel, type BodyInit } from '../contract';
import { BALL } from './ball';
import { MINIGOLF, isqrt, minigolfDistance } from './minigolf-roll';

export const MINIGOLF_SHAPES = ['straight', 'L', 'S'] as const;
export type MinigolfShape = (typeof MINIGOLF_SHAPES)[number];
/** Par podle tvaru = počet úseků trasy + 1 (rána navíc na doražení). */
export const MINIGOLF_PAR: Readonly<Record<MinigolfShape, number>> = { straight: 2, L: 3, S: 4 };
/** Modely těl; odrazník a pohyblivá překážka berou model z věty (`bumper`, `mover`), tohle je výchozí. */
export const MINIGOLF_KINDS = { ball: 'gen3d-golf-ball', hole: 'minigolf-hole', green: 'minigolf-green', rail: 'minigolf-rail', bumper: 'tire-barrier', mover: 'crate' } as const;

const kindId = z.string().max(40).regex(/^[a-z0-9][a-z0-9-]{0,36}$/);
/** Parametry generátoru (přes `tuning` modulu žánru). Bez `shape` a `obstacles` losuje stream; pohyblivá jen na přání. */
export const minigolfParams = z
  .object({
    shape: z.enum(MINIGOLF_SHAPES).optional(),
    obstacles: z.int().min(1).max(3).optional(),
    moving: z.boolean().optional(),
    par: z.int().min(2).max(4).optional(),
    bumper: kindId.optional(),
    mover: kindId.optional(),
  })
  .strict();
export type MinigolfParams = z.infer<typeof minigolfParams>;

const index = z.int().min(0).max(ARCADE_LIMITS.maxBodies - 1);
/** Úsek těl `[první, počet]`. */
const range = z.tuple([index, z.int().min(0).max(ARCADE_LIMITS.maxBodies)]);
/**
 * Rozložení světa pro ovládání, pravidlo, robota i scénu: jamka, dlaždice, mantinely, odrazníky, pohyblivá překážka
 * (indexy těl) a trasa robota (body `[x, z]`, poslední = střed jamky).
 */
export const minigolfLayout = z
  .object({ hole: index, floor: range, rails: range, bumpers: range, mover: index.optional(), route: z.array(z.tuple([z.int(), z.int()])).min(1).max(3) })
  .strict();
export type MinigolfLayout = z.infer<typeof minigolfLayout>;

export interface MinigolfBox {
  readonly x: number;
  readonly z: number;
  readonly w: number;
  readonly d: number;
}
/** Pohyblivá překážka: start kyvadla (`x/z`), rychlost za tik a perioda v tikách (po ní se rychlost otočí). */
export interface MinigolfMover extends MinigolfBox {
  readonly vx: number;
  readonly vz: number;
  readonly period: number;
}
type Point = readonly [number, number];
/** Jamka jako geometrie, než z ní vzniknou těla (`minigolfLevelOf`); ruční jamky testů a robota jdou stejnou cestou. */
export interface MinigolfCourse {
  readonly shape: MinigolfShape;
  /** Dlaždice `[sloupec, řada]`; dlaždice (c, r) má střed `(c·tile, r·tile)`. */
  readonly tiles: readonly Point[];
  readonly tee: Point;
  readonly hole: Point;
  readonly bumpers: readonly MinigolfBox[];
  readonly mover: MinigolfMover | null;
  readonly route: readonly Point[];
  readonly par: number;
  /** Kolik odrazníků věta chtěla; když se jich vešlo méně, `minigolfPartsOf` to ohlásí. */
  readonly obstacles: number;
  readonly kinds?: { readonly bumper?: string; readonly mover?: string };
}

const T = MINIGOLF.tile;
const MOVER = { across: 1000, along: 600, height: 800 } as const;
const BUMPER_SIZES = [800, 1000, 1200] as const;
const BUMPER_HEIGHT = 600;

/** Stream `minigolf`: dva skoky (`jump()`) za posledním subsystémem `rounds` – mimo všechny streamy `SUBSYSTEMS`. */
function minigolfStream(seed: number): (from: number, to: number) => number {
  const stream = createStreams(seed).rounds;
  stream.jump();
  stream.jump();
  return (from, to) => nextInt(stream, from, to);
}

interface Plan {
  readonly tiles: Point[];
  readonly corners: Point[];
  readonly last: Point;
  /** Směr posledního úseku (jednotkový). */
  readonly dir: Point;
  /** Prostřední dlaždice úseků (ne odpaliště, roh ani jamka) a osa jejich úseku – místo pro pohyblivou překážku. */
  readonly middles: { readonly tile: Point; readonly along: 'x' | 'z' }[];
}

const steps = (from: number, to: number): number[] => Array.from({ length: to - from + 1 }, (_, k) => from + k);

function planOf(shape: MinigolfShape, int: (from: number, to: number) => number): Plan {
  if (shape === 'straight') {
    const n = int(3, 4);
    return { tiles: steps(0, n - 1).map((r) => [0, r]), corners: [], last: [0, n - 1], dir: [0, 1], middles: steps(1, n - 2).map((r) => ({ tile: [0, r], along: 'z' })) };
  }
  const s = int(0, 1) === 0 ? -1 : 1;
  const first: Point[] = [[0, 0], [0, 1], [0, 2]];
  if (shape === 'L') {
    const m = int(2, 3);
    const across = steps(1, m).map((k): Point => [k * s, 2]);
    return { tiles: [...first, ...across], corners: [[0, 2]], last: [m * s, 2], dir: [s, 0], middles: [{ tile: [0, 1], along: 'z' }, ...across.slice(0, -1).map((tile) => ({ tile, along: 'x' as const }))] };
  }
  const n = int(2, 3);
  const across: Point[] = [[s, 2], [2 * s, 2]];
  const up = steps(1, n).map((k): Point => [2 * s, 2 + k]);
  return {
    tiles: [...first, ...across, ...up],
    corners: [[0, 2], [2 * s, 2]],
    last: [2 * s, 2 + n],
    dir: [0, 1],
    middles: [{ tile: [0, 1], along: 'z' }, { tile: [s, 2], along: 'x' }, ...up.slice(0, -1).map((tile) => ({ tile, along: 'z' as const }))],
  };
}

const centerOf = ([c, r]: Point): Point => [c * T, r * T];

interface Rect {
  readonly x0: number;
  readonly x1: number;
  readonly z0: number;
  readonly z1: number;
}
const grow = (box: MinigolfBox, margin: number): Rect => ({ x0: box.x - box.w / 2 - margin, x1: box.x + box.w / 2 + margin, z0: box.z - box.d / 2 - margin, z1: box.z + box.d / 2 + margin });
const inside = ([x, z]: Point, rect: Rect): boolean => x > rect.x0 && x < rect.x1 && z > rect.z0 && z < rect.z1;
const meets = (a: Rect, b: Rect): boolean => a.x0 < b.x1 && b.x0 < a.x1 && a.z0 < b.z1 && b.z0 < a.z1;

/** Protne úsečka `p → q` otevřený obdélník? (Metoda desek; dělení celých čísel zaokrouhlí IEEE všude stejně.) */
function crosses([px, pz]: Point, [qx, qz]: Point, rect: Rect): boolean {
  let t0 = 0;
  let t1 = 1;
  for (const [p, q, lo, hi] of [[px, qx, rect.x0, rect.x1], [pz, qz, rect.z0, rect.z1]] as const) {
    const d = q - p;
    if (d === 0) {
      if (p <= lo || p >= hi) return false;
      continue;
    }
    const a = (lo - p) / d;
    const b = (hi - p) / d;
    t0 = Math.max(t0, Math.min(a, b));
    t1 = Math.min(t1, Math.max(a, b));
    if (t0 >= t1) return false;
  }
  return true;
}

/** Pás trasy: poloměr míčku + rezerva. */
const LANE = MINIGOLF.ball / 2 + MINIGOLF.clearance;
/** Nejdelší úsek trasy: plná rána bez půlky jamky rezervy. */
const REACH = minigolfDistance(BALL.maxCharge) - MINIGOLF.holeSize / 2;

/** Pohyblivá překážka v krajní poloze `end` (0 = start kyvadla, 1 = po půl periodě). */
const moverEnd = (mover: MinigolfMover, end: 0 | 1): MinigolfBox => ({ ...mover, x: mover.x + end * mover.vx * mover.period, z: mover.z + end * mover.vz * mover.period });
/** Obal celé dráhy pohyblivé překážky. */
const sweepOf = (mover: MinigolfMover): Rect => {
  const [a, b] = [grow(moverEnd(mover, 0), 0), grow(moverEnd(mover, 1), 0)];
  return { x0: Math.min(a.x0, b.x0), x1: Math.max(a.x1, b.x1), z0: Math.min(a.z0, b.z0), z1: Math.max(a.z1, b.z1) };
};

/** Poloha pohyblivé překážky ve stavu s `HEADER.tick` = `tick` (kyvadlo jádra: po `period` tikách obrátí směr). */
export function minigolfMoverAt(mover: Pick<MinigolfMover, 'x' | 'z' | 'vx' | 'vz' | 'period'>, tick: number): Point {
  const phase = tick % (2 * mover.period);
  const leg = phase <= mover.period ? phase : 2 * mover.period - phase;
  return [mover.x + mover.vx * leg, mover.z + mover.vz * leg];
}

function moverIn(plan: Plan, int: (from: number, to: number) => number): MinigolfMover {
  const { tile, along } = plan.middles[int(0, plan.middles.length - 1)] as Plan['middles'][number];
  const [cx, cz] = centerOf(tile);
  const speed = MINIGOLF.moverSpeeds[int(0, MINIGOLF.moverSpeeds.length - 1)] as number;
  const period = MINIGOLF.moverAmplitude / speed;
  const half = MINIGOLF.moverAmplitude / 2;
  return along === 'z'
    ? { x: cx - half, z: cz, w: MOVER.across, d: MOVER.along, vx: speed, vz: 0, period }
    : { x: cx, z: cz - half, w: MOVER.along, d: MOVER.across, vx: 0, vz: speed, period };
}

/** Úseky trasy: odpaliště → body trasy. */
const legsOf = (tee: Point, route: readonly Point[]): [Point, Point][] => route.map((point, k) => [k === 0 ? tee : (route[k - 1] as Point), point]);

/** Odrazníky po jednom: dlaždice, rozměr a místo ze streamu, dokud nějaký nestojí trase, jamce, odpališti ani jinému v cestě. */
function placeBumpers(count: number, plan: Plan, tee: Point, hole: Point, route: readonly Point[], skip: readonly Point[], int: (from: number, to: number) => number): MinigolfBox[] {
  const spots = plan.tiles.filter((tile) => !skip.some((other) => other[0] === tile[0] && other[1] === tile[1]));
  const legs = legsOf(tee, route);
  const placed: MinigolfBox[] = [];
  for (let attempt = 0; attempt < 60 * count && placed.length < count; attempt += 1) {
    const [cx, cz] = centerOf(spots[int(0, spots.length - 1)] as Point);
    const w = BUMPER_SIZES[int(0, BUMPER_SIZES.length - 1)] as number;
    const d = BUMPER_SIZES[int(0, BUMPER_SIZES.length - 1)] as number;
    const reachX = (T - w) / 2 - 100;
    const reachZ = (T - d) / 2 - 100;
    const box = { x: cx + int(-reachX, reachX), z: cz + int(-reachZ, reachZ), w, d };
    if (legs.some(([p, q]) => crosses(p, q, grow(box, LANE)))) continue;
    if (placed.some((other) => meets(grow(box, MINIGOLF.ball), grow(other, 0)))) continue;
    if (inside(hole, grow(box, MINIGOLF.holeSize / 2 + MINIGOLF.ball)) || inside(tee, grow(box, MINIGOLF.ball))) continue;
    placed.push(box);
  }
  return placed;
}

/** Jamka ze streamu `minigolf` semínka `seed`. Pořadí losů je pevné: tvar, počet odrazníků, dráha, jamka, pohyblivá, odrazníky. */
export function drawMinigolfCourse(seed: number, params: MinigolfParams): MinigolfCourse {
  const int = minigolfStream(seed);
  const shape = params.shape ?? (MINIGOLF_SHAPES[int(0, MINIGOLF_SHAPES.length - 1)] as MinigolfShape);
  const obstacles = params.obstacles ?? int(1, 3);
  const plan = planOf(shape, int);
  const tee: Point = [0, -T / 4];
  const [lx, lz] = centerOf(plan.last);
  const [dx, dz] = plan.dir;
  const along = int(-500, 500);
  const lateral = int(-1000, 1000);
  const hole: Point = [lx + along * dx + lateral * dz, lz + along * dz - lateral * dx];
  const route: Point[] = [...plan.corners.map(centerOf), hole];
  const mover = params.moving === true ? moverIn(plan, int) : null;
  // Dlaždice pohyblivé překážky zůstane volná; odpaliště a jamku hlídá `placeBumpers` vzdáleností.
  const moverTile: Point[] = mover === null ? [] : [[Math.round((mover.x + (mover.vx * mover.period) / 2) / T), Math.round((mover.z + (mover.vz * mover.period) / 2) / T)]];
  const bumpers = placeBumpers(obstacles, plan, tee, hole, route, moverTile, int);
  const kinds = { ...(params.bumper === undefined ? {} : { bumper: params.bumper }), ...(params.mover === undefined ? {} : { mover: params.mover }) };
  return { shape, tiles: plan.tiles, tee, hole, bumpers, mover, route, par: params.par ?? MINIGOLF_PAR[shape], obstacles, kinds };
}

/**
 * Mantinely kolem dlaždic: hrana bez sousední dlaždice = stěna vně dráhy (vnitřní líc na hraně dlaždice), sousední
 * hrany na téže přímce spojené v jednu, konec stěny prodloužený o tloušťku, když tím nevjede do dlaždice (vnější roh).
 */
function railsOf(tiles: readonly Point[]): MinigolfBox[] {
  const R = MINIGOLF.rail;
  const has = (c: number, r: number): boolean => tiles.some(([tc, tr]) => tc === c && tr === r);
  interface Edge {
    readonly horizontal: boolean;
    readonly line: number;
    readonly side: number;
    from: number;
    to: number;
  }
  const edges: Edge[] = [];
  for (const [c, r] of tiles) {
    const [x, z] = centerOf([c, r]);
    if (!has(c, r + 1)) edges.push({ horizontal: true, line: z + T / 2, side: 1, from: x - T / 2, to: x + T / 2 });
    if (!has(c, r - 1)) edges.push({ horizontal: true, line: z - T / 2, side: -1, from: x - T / 2, to: x + T / 2 });
    if (!has(c + 1, r)) edges.push({ horizontal: false, line: x + T / 2, side: 1, from: z - T / 2, to: z + T / 2 });
    if (!has(c - 1, r)) edges.push({ horizontal: false, line: x - T / 2, side: -1, from: z - T / 2, to: z + T / 2 });
  }
  edges.sort((a, b) => Number(a.horizontal) - Number(b.horizontal) || a.line - b.line || a.side - b.side || a.from - b.from);
  const merged: Edge[] = [];
  for (const edge of edges) {
    const prev = merged.at(-1);
    if (prev !== undefined && prev.horizontal === edge.horizontal && prev.line === edge.line && prev.side === edge.side && prev.to === edge.from) prev.to = edge.to;
    else merged.push({ ...edge });
  }
  const floor = tiles.map((tile) => grow({ x: centerOf(tile)[0], z: centerOf(tile)[1], w: T, d: T }, 0));
  return merged.map((edge) => {
    const [n0, n1] = edge.side > 0 ? [edge.line, edge.line + R] : [edge.line - R, edge.line];
    const rect = (a: number, b: number): Rect => (edge.horizontal ? { x0: a, x1: b, z0: n0, z1: n1 } : { x0: n0, x1: n1, z0: a, z1: b });
    const free = (a: number, b: number): boolean => !floor.some((tile) => meets(rect(a, b), tile));
    const from = free(edge.from - R, edge.from) ? edge.from - R : edge.from;
    const to = free(edge.to, edge.to + R) ? edge.to + R : edge.to;
    const across = (n0 + n1) / 2;
    const middle = (from + to) / 2;
    return edge.horizontal ? { x: middle, z: across, w: to - from, d: R } : { x: across, z: middle, w: R, d: to - from };
  });
}

/** Těla a rozložení jamky: míček (hráč) na odpališti, jamka, dlaždice, mantinely, odrazníky, pohyblivá překážka. */
export function minigolfLevelOf(course: MinigolfCourse): { readonly level: ArcadeLevel; readonly layout: MinigolfLayout } {
  const B = MINIGOLF.ball;
  const ball: BodyInit = { role: 'player', kind: MINIGOLF_KINDS.ball, x: course.tee[0], y: 0, z: course.tee[1], w: B, h: B, d: B, solid: false };
  const hole: BodyInit = { role: 'goal', kind: MINIGOLF_KINDS.hole, x: course.hole[0], y: -200, z: course.hole[1], w: MINIGOLF.holeSize, h: 200, d: MINIGOLF.holeSize, solid: false };
  // Dlaždice pod zemí a celá hřiště nepevná: kolize míčku řeší jen kutálení (`minigolfRoll`), jádro žádnou nepřidá.
  const floor = course.tiles.map((tile): BodyInit => ({ role: 'platform', kind: MINIGOLF_KINDS.green, x: centerOf(tile)[0], y: -100, z: centerOf(tile)[1], w: T, h: 100, d: T, solid: false }));
  const rails = railsOf(course.tiles).map((box): BodyInit => ({ role: 'obstacle', kind: MINIGOLF_KINDS.rail, ...box, y: 0, h: MINIGOLF.railHeight, solid: false }));
  const bumpers = course.bumpers.map((box): BodyInit => ({ role: 'obstacle', kind: course.kinds?.bumper ?? MINIGOLF_KINDS.bumper, ...box, y: 0, h: BUMPER_HEIGHT, solid: false }));
  const { mover } = course;
  const moving: BodyInit[] =
    mover === null
      ? []
      : [{ role: 'obstacle', kind: course.kinds?.mover ?? MINIGOLF_KINDS.mover, x: mover.x, y: 0, z: mover.z, w: mover.w, h: MOVER.height, d: mover.d, solid: false, kinematic: true, vx: mover.vx, vz: mover.vz, period: mover.period }];
  const first = 2;
  const layout: MinigolfLayout = {
    hole: 1,
    floor: [first, floor.length],
    rails: [first + floor.length, rails.length],
    bumpers: [first + floor.length + rails.length, bumpers.length],
    ...(mover === null ? {} : { mover: first + floor.length + rails.length + bumpers.length }),
    route: course.route.map(([x, z]): [number, number] => [x, z]),
  };
  return { level: { bodies: [ball, hole, ...floor, ...rails, ...bumpers, ...moving], length: 0, counters: { reserve: course.par } }, layout };
}

/** Tvrzení „řešitelná konstrukcí“ nad tělesy úrovně; prázdný seznam = jamka drží. */
export function checkMinigolfHole(level: ArcadeLevel, layout: MinigolfLayout): string[] {
  const issues: string[] = [];
  const bodies = level.bodies;
  const slice = ([first, count]: readonly [number, number]): BodyInit[] => bodies.slice(first, first + count);
  const floor = slice(layout.floor);
  const walls = [...slice(layout.rails), ...slice(layout.bumpers)];
  const body = layout.mover === undefined ? undefined : bodies[layout.mover];
  const mover: MinigolfMover | null = body === undefined ? null : { x: body.x, z: body.z, w: body.w, d: body.d, vx: body.vx ?? 0, vz: body.vz ?? 0, period: body.period ?? 0 };
  const tee = bodies[0] as BodyInit;
  const hole = bodies[layout.hole] as BodyInit;
  const onFloor = ([x, z]: Point): boolean => floor.some((tile) => Math.abs(2 * (x - tile.x)) <= tile.w && Math.abs(2 * (z - tile.z)) <= tile.d);
  const end = layout.route.at(-1) as Point;
  if (end[0] !== hole.x || end[1] !== hole.z) issues.push('minigolf: the robot route does not end in the hole');
  const par = level.counters?.reserve ?? 0;
  if (par < 2 || par > 4 || par < layout.route.length) issues.push(`minigolf: par ${String(par)} is outside 2–4 or below ${String(layout.route.length)} route legs`);
  const points: Point[] = [[tee.x, tee.z], ...layout.route];
  points.forEach((point, k) => {
    if (!onFloor(point)) issues.push(`minigolf: route point ${String(k)} is off the course`);
  });
  legsOf(points[0] as Point, layout.route).forEach(([p, q], k) => {
    const length = isqrt((q[0] - p[0]) ** 2 + (q[1] - p[1]) ** 2);
    if (length > REACH) issues.push(`minigolf: leg ${String(k)} (${String(length)}) is longer than one stroke rolls (${String(REACH)})`);
    if (walls.some((wall) => crosses(p, q, grow(wall, LANE)))) issues.push(`minigolf: leg ${String(k)} is blocked by a rail or an obstacle`);
    if (mover !== null && crosses(p, q, grow(moverEnd(mover, 0), LANE)) && crosses(p, q, grow(moverEnd(mover, 1), LANE))) issues.push(`minigolf: leg ${String(k)} never clears the moving obstacle`);
  });
  const cup = grow(hole, 0);
  if (slice(layout.bumpers).some((bumper) => meets(grow(bumper, 0), cup))) issues.push('minigolf: an obstacle covers the hole');
  if (mover !== null && meets(sweepOf(mover), cup)) issues.push('minigolf: the moving obstacle sweeps over the hole');
  return issues;
}
