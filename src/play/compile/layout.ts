/**
 * Rozvržení rolí na mřížku (P23-A, T2).
 *
 * Vstupem je `GameSpec`, výstupem buňka pro každou instanci role (role ×
 * `count`), obdélník zóny pro role, které v runtime žijí jako zóna, pár
 * blokovaných buněk jako překážky a spawn hráče. Všechno ostatní – sokety,
 * entity, pravidla – z toho odvozují adaptéry mechanik (T3+).
 *
 * Náhoda jde jen ze seedu (`./rng`), pořadí umisťování je pevné (hráč, cíle,
 * zbytek ve pořadí specu), takže stejný spec + seed dá vždy bajtově totéž.
 * Když se překážky postaví do cesty, zkusí se to znovu s menším podílem
 * překážek; poslední pokus je bez nich a mřížka bez překážek je souvislá,
 * takže `LAYOUT_FAILED` zbývá jen pro spec, který se na mřížku nevejde.
 */

import { LAYOUT_GRID, layoutGridSize } from '../registry';
import type { GameRole, GameSpecV1, RoleKind } from '../spec';
import { type CompileRng, createCompileRng } from './rng';

export type Cell = readonly [number, number];
/** `[x, y, w, h]` – tvar, který `state.zones` v `sim` očekává. */
export type Rect = readonly [number, number, number, number];

export interface Layout {
  readonly width: number;
  readonly height: number;
  /** Instance role → buňka. Klíče viz `roleInstanceId`. */
  readonly cells: ReadonlyMap<string, Cell>;
  readonly zones: Readonly<Record<string, Rect>>;
  readonly blocked: readonly Cell[];
  readonly spawn: Cell;
}

export type LayoutResult =
  | { readonly ok: true; readonly value: Layout }
  | { readonly ok: false; readonly reason: 'LAYOUT_FAILED'; readonly issues: readonly string[] };

/** Role, které musí ležet daleko od hráče. */
export const GOAL_KINDS: readonly RoleKind[] = ['exit', 'destination'];
/** Role, které v runtime žijí jako zóna (`onEnterZone`, `inZone`). */
export const ZONE_KINDS: readonly RoleKind[] = ['exit', 'destination', 'hazard', 'checkpoint', 'zone', 'door'];

const GRID = {
  ...LAYOUT_GRID,
  /** Podíl překážek na prvním pokusu; každý další pokus ho snižuje až na nulu. */
  obstacleShare: 0.08,
  attempts: 6,
} as const;

/** `mushroom` pro `count: 1`, jinak `mushroom_1` … – bez tečky, aby prošel `SYMBOL_PATTERN` cílů mysli. */
export function roleInstanceId(role: GameRole, index: number): string {
  return role.count === 1 ? role.id : `${role.id}_${index + 1}`;
}

interface Instance {
  readonly id: string;
  readonly role: GameRole;
}

const key = ([x, y]: Cell): string => `${x},${y}`;
const manhattan = ([ax, ay]: Cell, [bx, by]: Cell): number => Math.abs(ax - bx) + Math.abs(ay - by);

/**
 * Hráč první, cíle hned po něm (potřebují volné vzdálené buňky), hazardy
 * poslední (uhýbají trase svědka, která stojí až na cílech a checkpointech),
 * zbytek v pořadí specu.
 */
function expandInstances(spec: GameSpecV1): Instance[] {
  const rank = (role: GameRole): number =>
    role.kind === 'player' ? 0 : GOAL_KINDS.includes(role.kind) ? 1 : role.kind === 'hazard' ? 3 : 2;
  const instances: Instance[] = [];
  for (const role of [...spec.roles].sort((a, b) => rank(a) - rank(b))) {
    for (let i = 0; i < role.count; i += 1) instances.push({ id: roleInstanceId(role, i), role });
  }
  return instances;
}

function gridSize(instances: number, rng: CompileRng): { width: number; height: number } {
  const dw = rng.int(0, 2);
  return layoutGridSize(instances, dw, rng.int(0, 1));
}

function rectCells([x, y, w, h]: Rect): Cell[] {
  const cells: Cell[] = [];
  for (let dx = 0; dx < w; dx += 1) for (let dy = 0; dy < h; dy += 1) cells.push([x + dx, y + dy]);
  return cells;
}

/** Zóna kolem kotvy: 2×2, když se některá ze čtyř poloh vejde do volných buněk, jinak 1×1. */
function chooseZone(anchor: Cell, width: number, height: number, occupied: ReadonlySet<string>, rng: CompileRng): Rect {
  const [ax, ay] = anchor;
  if (rng.int(0, 2) === 0) {
    const origins = rng.shuffle<Cell>([
      [ax, ay],
      [ax - 1, ay],
      [ax, ay - 1],
      [ax - 1, ay - 1],
    ]);
    for (const [ox, oy] of origins) {
      if (ox < 0 || oy < 0 || ox + 2 > width || oy + 2 > height) continue;
      const rect: Rect = [ox, oy, 2, 2];
      const free = rectCells(rect).every(([x, y]) => (x === ax && y === ay) || !occupied.has(key([x, y])));
      if (free) return rect;
    }
  }
  return [ax, ay, 1, 1];
}

function freeCells(width: number, height: number, occupied: ReadonlySet<string>, accept: (cell: Cell) => boolean): Cell[] {
  const cells: Cell[] = [];
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const cell: Cell = [x, y];
      if (!occupied.has(key(cell)) && accept(cell)) cells.push(cell);
    }
  }
  return cells;
}

/** Buňky dosažitelné od spawnu čtyřokolím po neblokovaných buňkách. */
function reachableFrom(spawn: Cell, width: number, height: number, blocked: ReadonlySet<string>): Set<string> {
  const seen = new Set<string>([key(spawn)]);
  const queue: Cell[] = [spawn];
  for (let head = 0; head < queue.length; head += 1) {
    const [x, y] = queue[head] as Cell;
    const around: Cell[] = [
      [x + 1, y],
      [x - 1, y],
      [x, y + 1],
      [x, y - 1],
    ];
    for (const next of around) {
      const [nx, ny] = next;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const k = key(next);
      if (blocked.has(k) || seen.has(k)) continue;
      seen.add(k);
      queue.push(next);
    }
  }
  return seen;
}

/**
 * Buňky, kterými projde `moveTo` z `from` do `to`: nejdřív po x, pak po y
 * (`stepToward`, `src/sim/interpreter.ts:680`). Svědek chodí přímo, takže
 * pronásledovatel na této čáře mezi spawnem a cílem by ho zabil i zmrazený.
 */
function movePath(from: Cell, to: Cell): Cell[] {
  const cells: Cell[] = [];
  const [fx, fy] = from;
  const [tx, ty] = to;
  for (let x = fx; x !== tx; x += Math.sign(tx - fx)) cells.push([x, fy]);
  for (let y = fy; y !== ty; y += Math.sign(ty - fy)) cells.push([tx, y]);
  cells.push([tx, ty]);
  return cells;
}

/** Buňka prvního cíle, konec trasy svědka; `null` bez cíle (přežití, souboj). */
function firstGoal(instances: readonly Instance[], cells: ReadonlyMap<string, Cell>): Cell | null {
  const goal = instances.find((instance) => GOAL_KINDS.includes(instance.role.kind));
  return goal === undefined ? null : (cells.get(goal.id) as Cell);
}

function tryPlace(
  instances: readonly Instance[],
  width: number,
  height: number,
  obstacleShare: number,
  rng: CompileRng,
): Layout | string {
  const occupied = new Set<string>();
  const cells = new Map<string, Cell>();
  const zones: Record<string, Rect> = {};
  const blocked: Cell[] = [];
  const minGoal = Math.ceil(Math.max(width, height) / 2);

  const player = instances[0] as Instance;
  const spawn: Cell = [rng.int(0, width - 1), rng.int(0, height - 1)];
  cells.set(player.id, spawn);
  occupied.add(key(spawn));

  const obstacleCount = Math.floor(width * height * obstacleShare);
  const obstacleCandidates = rng.shuffle(freeCells(width, height, occupied, () => true));
  for (const cell of obstacleCandidates.slice(0, obstacleCount)) {
    blocked.push(cell);
    occupied.add(key(cell));
  }

  const goalPaths = new Set<string>();
  // Trasa svědka: spawn → checkpointy v pořadí instancí → první cíl. Checkpoint
  // se klade tak, aby jeho úsek nevedl přes cíl (svědek by vyhrál dřív, než
  // dohraje kroky); hazard na trase by svědka zabil, i když pulzuje. Přímou
  // čáru spawn → cíl mimo trasu hazard krýt smí – právě tam hra „přejdi lávu
  // po kamenech“ vzniká.
  const goalCells = new Set<string>();
  const witnessRoute = new Set<string>([key(spawn)]);
  let routeEnd = spawn;
  const extendRoute = (to: Cell): void => {
    for (const cell of movePath(routeEnd, to)) witnessRoute.add(key(cell));
    routeEnd = to;
  };
  const crossesGoal = (from: Cell, to: Cell): boolean => movePath(from, to).slice(0, -1).some((cell) => goalCells.has(key(cell)));

  for (const instance of instances.slice(1)) {
    const kind = instance.role.kind;
    const isGoal = GOAL_KINDS.includes(kind);
    const isHazard = kind === 'hazard';
    const isCheckpoint = kind === 'checkpoint';
    const offPath = kind === 'chaser';
    // Hazardy jsou poslední v pořadí; trasa je hotová, jakmile první z nich přijde na řadu.
    if (isHazard) {
      const goal = firstGoal(instances, cells);
      if (goal !== null && routeEnd !== goal) extendRoute(goal);
    }
    const candidates = freeCells(
      width,
      height,
      occupied,
      (cell) =>
        (!isGoal || manhattan(cell, spawn) >= minGoal) &&
        (!offPath || !goalPaths.has(key(cell))) &&
        (!isCheckpoint || !crossesGoal(routeEnd, cell)) &&
        (!isHazard || !witnessRoute.has(key(cell))),
    );
    if (candidates.length === 0) return `no free cell for ${instance.id}`;
    const anchor = rng.pick(candidates);
    cells.set(instance.id, anchor);
    occupied.add(key(anchor));
    if (isGoal) for (const cell of movePath(spawn, anchor)) goalPaths.add(key(cell));
    if (isCheckpoint) extendRoute(anchor);
    if (ZONE_KINDS.includes(kind)) {
      const rect = chooseZone(anchor, width, height, isHazard ? new Set([...occupied, ...witnessRoute]) : occupied, rng);
      zones[instance.id] = rect;
      for (const cell of rectCells(rect)) occupied.add(key(cell));
      if (isGoal) for (const cell of rectCells(rect)) goalCells.add(key(cell));
    } else if (isGoal) {
      goalCells.add(key(anchor));
    }
  }

  const open = reachableFrom(spawn, width, height, new Set(blocked.map(key)));
  const cutOff = [...cells].filter(([, cell]) => !open.has(key(cell))).map(([id]) => id);
  if (cutOff.length > 0) return `unreachable from spawn: ${cutOff.join(', ')}`;

  return { width, height, cells, zones, blocked, spawn };
}

export function layoutRoles(spec: GameSpecV1, seed: number): LayoutResult {
  const rng = createCompileRng(seed);
  const instances = expandInstances(spec);
  const { width, height } = gridSize(instances.length, rng);
  if (instances.length > width * height) {
    return {
      ok: false,
      reason: 'LAYOUT_FAILED',
      issues: [`${instances.length} role instances do not fit a ${width}×${height} grid (max ${GRID.maxWidth}×${GRID.maxHeight})`],
    };
  }

  const issues: string[] = [];
  for (let attempt = 0; attempt < GRID.attempts; attempt += 1) {
    const share = GRID.obstacleShare * (1 - attempt / (GRID.attempts - 1));
    const placed = tryPlace(instances, width, height, share, rng);
    if (typeof placed !== 'string') return { ok: true, value: placed };
    issues.push(`attempt ${attempt + 1}: ${placed}`);
  }
  return { ok: false, reason: 'LAYOUT_FAILED', issues };
}

/** Prostý objekt pro hash a regresní artefakt – `Map` by `JSON.stringify` vyprázdnil. */
export function layoutJson(layout: Layout): {
  width: number;
  height: number;
  spawn: Cell;
  cells: [string, Cell][];
  zones: Record<string, Rect>;
  blocked: Cell[];
} {
  return {
    width: layout.width,
    height: layout.height,
    spawn: layout.spawn,
    cells: [...layout.cells],
    zones: { ...layout.zones },
    blocked: [...layout.blocked],
  };
}
