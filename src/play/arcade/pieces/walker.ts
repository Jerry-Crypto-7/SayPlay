import { z } from 'zod';
import { createCompileRng } from '@/play/compile/rng';
import { AXIS_MAX, BODY, BUTTON, FLAG, HEADER, ROLE, UNIT, bodyBase, type ArcadeInput, type ArcadeLevel, type ArcadeState, type BodyInit, type ControlPiece, type ModeGeneratorPiece, type PieceRef, type RulePiece } from '../contract';

export const WALKER_CELL = 4 * UNIT;
export const walkerParamsSchema = z.object({
  size: z.int().min(7).max(15).refine(value => value % 2 === 1, 'Maze size must be odd').default(11),
  speed: z.int().min(80).max(160).default(110),
  collect: z.boolean().optional(),
  paceBudgetPct: z.int().min(100).max(180).optional(),
  corridorRisePermille: z.int().min(0).max(200).optional(),
  /** Nová hra (P51 T3, nativní spec bez `genre`): průběh, východ v nejvzdálenější buňce a stezka jisker (`WALKER_FINALE`). */
  segments: z.literal(true).optional(),
}).strict();
export type WalkerParams = z.infer<typeof walkerParamsSchema>;

/**
 * Finále chodce (P51 T3, jen se značkou `segments`): východ leží v nejvzdálenější buňce bludiště (nejdelší
 * cesta, robot 17–29 s místo 10–22 s), na posledních `trail` buňkách cesty před ním jiskry – závěrečný spěch,
 * jehož sebrání telemetrie uzná jako `climax`. Jiskra má `spark` jednotek přes chodbu: střed hráče je v chodbě
 * nejvýš 1600 od její osy, takže cesta k východu (strom bez smyček) seberou všechny – výhru se sběrem nezdrží.
 * Hodiny mají navíc `reserve` tiků: na delší cestě začátečník ztratí 1,1–2,6 s a bez rezervy vyhrál 0/12;
 * s 51 tiky (0,85 s, okno 46–58 před zaokrouhlením na celé sekundy) vyhraje 5/12 (změřeno, 7 buněk × 12 semínek).
 */
export const WALKER_FINALE = { trail: 8, spark: 2800, reserve: 51 } as const;
/** Výška 900: scéna do těla vepíše krystal (`modelIdOf`) stejným měřítkem ve všech osách – na 150 by byl nevidět. */
const WALKER_SPARK: Omit<BodyInit, 'x' | 'z'> = { role: 'collectible', kind: 'spark', y: 0, w: WALKER_FINALE.spark, h: 900, d: WALKER_FINALE.spark, solid: false };
export const walkerMapSchema = z.object({ size: z.int().min(7).max(15), open: z.array(z.int().min(0).max(224)).max(225) }).strict();
export type WalkerMap = z.infer<typeof walkerMapSchema>;
export const walkerControlParams = walkerMapSchema.extend({ speed: z.int().min(80).max(160), chaseSpeed: z.int().min(0).max(70).default(0) }).strict();

/** Breadth-first search over traversable cell centres; no diagonal wall cuts. */
export function walkerPath(map: WalkerMap, start: number, goal: number): number[] {
  const open = new Set(map.open);
  if (!open.has(start) || !open.has(goal)) return [];
  const queue = [start];
  const parents = new Map<number, number>([[start, -1]]);
  for (let at = 0; at < queue.length; at++) {
    const cell = queue[at]!;
    if (cell === goal) break;
    for (const next of [cell - 1, cell + 1, cell - map.size, cell + map.size]) {
      if (next < 0 || next >= map.size * map.size || Math.abs(next % map.size - cell % map.size) + Math.abs(Math.floor(next / map.size) - Math.floor(cell / map.size)) !== 1 || !open.has(next) || parents.has(next)) continue;
      parents.set(next, cell); queue.push(next);
    }
  }
  if (!parents.has(goal)) return [];
  const path: number[] = [];
  for (let cell = goal; cell !== -1; cell = parents.get(cell)!) path.push(cell);
  return path.reverse();
}

export function walkerMaze(seed: number, size: number): WalkerMap {
  const rng = createCompileRng(seed);
  const open = new Set<number>([size + 1]);
  const stack = [size + 1];
  while (stack.length > 0) {
    const cell = stack.at(-1)!;
    const x = cell % size, z0 = Math.floor(cell / size);
    const options = rng.shuffle([[2, 0], [-2, 0], [0, 2], [0, -2]] as const)
      .filter(([dx, dz]) => x + dx > 0 && x + dx < size - 1 && z0 + dz > 0 && z0 + dz < size - 1 && !open.has(cell + dx + dz * size));
    if (options.length === 0) { stack.pop(); continue; }
    const [dx, dz] = options[0]!;
    open.add(cell + dx / 2 + dz * size / 2);
    const next = cell + dx + dz * size;
    open.add(next); stack.push(next);
  }
  // Entrance corridor for a real patrol/pursuer, connected to the maze.
  open.add(1);
  return { size, open: [...open].sort((a, b) => a - b) };
}

/** Východ: roh naproti startu; nová hra (`segments`) nejvzdálenější buňka od startu, remíza = nižší index. Vstupní chodba (řada 0) ne. */
export function walkerExit(map: WalkerMap, segments: boolean | undefined): number {
  const start = map.size + 1;
  if (segments !== true) return (map.size - 2) * map.size + map.size - 2;
  let best = start, most = 0;
  for (const cell of map.open) {
    const steps = cell < map.size ? 0 : walkerPath(map, start, cell).length - 1;
    if (steps > most) { best = cell; most = steps; }
  }
  return best;
}

/** Tiky cesty robota plnou rychlostí od startu k východu (`goal`): postup průběhu chodce měří čas proti ní. */
export const walkerRouteTicks = (map: WalkerMap, speed: number, goal: number): number => Math.ceil((walkerPath(map, map.size + 1, goal).length - 1) * WALKER_CELL / speed);

export const walkerVelocity = (input: ArcadeInput, speed: number): { vx: number; vz: number } => {
  let x = Math.max(-AXIS_MAX, Math.min(AXIS_MAX, input.axis));
  if (input.buttons & BUTTON.LEFT) x = -AXIS_MAX;
  if (input.buttons & BUTTON.RIGHT) x = AXIS_MAX;
  const z0 = ((input.buttons & BUTTON.UP ? 1 : 0) - (input.buttons & BUTTON.DOWN ? 1 : 0)) * AXIS_MAX;
  const scale = x !== 0 && z0 !== 0 ? 707 : 1000;
  return { vx: Math.trunc(x * speed * scale / AXIS_MAX / 1000), vz: Math.trunc(z0 * speed * scale / AXIS_MAX / 1000) };
};

export function walkerCell(map: WalkerMap, x: number, z0: number): number {
  return Math.max(0, Math.min(map.size - 1, Math.round(z0 / WALKER_CELL))) * map.size + Math.max(0, Math.min(map.size - 1, Math.round(x / WALKER_CELL)));
}

/** Choose the next centre, first finishing the current crossing before turning. */
export function walkerWaypoint(map: WalkerMap, x: number, z0: number, goal: number): { x: number; z: number } | null {
  const cell = walkerCell(map, x, z0);
  const path = walkerPath(map, cell, goal);
  if (path.length === 0) return null;
  const cx = cell % map.size * WALKER_CELL, cz = Math.floor(cell / map.size) * WALKER_CELL;
  const following = path[1] ?? cell;
  const nx = following % map.size * WALKER_CELL, nz = Math.floor(following / map.size) * WALKER_CELL;
  const along = (x - cx) * (nx - cx) + (z0 - cz) * (nz - cz);
  const cross = nx === cx ? Math.abs(x - cx) : Math.abs(z0 - cz);
  const centering = Math.abs(x - cx) + Math.abs(z0 - cz) > 180 && (along < 0 || cross > 180);
  const next = centering ? cell : following;
  return { x: next % map.size * WALKER_CELL, z: Math.floor(next / map.size) * WALKER_CELL };
}

export const walkerControl: ControlPiece<z.infer<typeof walkerControlParams>> = {
  id: 'walker', params: walkerControlParams, roles: ['player', 'chaser'], cost: () => ({ bodies: 1, rules: 0 }),
  step(state, player, input, params) {
    const p = bodyBase(player);
    const { vx, vz } = walkerVelocity(input, params.speed);
    state[p + BODY.vx] = vx; state[p + BODY.vz] = vz;
    for (let body = 0; body < state[HEADER.bodyCount]!; body++) {
      const b = bodyBase(body);
      if (state[b + BODY.role] !== ROLE.chaser || (state[b + BODY.flags]! & FLAG.alive) === 0 || params.chaseSpeed === 0) continue;
      const x = state[b + BODY.x]!, z0 = state[b + BODY.z]!;
      // The chaser also follows walls through BFS and moves by velocity, not teleportation.
      const goal = walkerCell(params, state[p + BODY.x]!, state[p + BODY.z]!);
      const target = z0 < 0 ? { x: WALKER_CELL, z: 0 } : walkerWaypoint(params, x, z0, goal);
      if (target === null) { state[b + BODY.vx] = 0; state[b + BODY.vz] = 0; continue; }
      const dx = target.x - x, dz = target.z - z0;
      state[b + BODY.vx] = Math.abs(dx) > 80 ? Math.sign(dx) * Math.min(params.chaseSpeed, Math.abs(dx)) : 0;
      state[b + BODY.vz] = Math.abs(dx) <= 80 ? Math.sign(dz) * Math.min(params.chaseSpeed, Math.abs(dz)) : 0;
    }
  },
};

const caughtParams = walkerMapSchema.extend({ body: z.int().min(1), range: z.int().min(1).default(5 * UNIT) }).strict();

/** 90-degree forward field of view, with walls blocking sight. */
export function walkerVisible(state: ArcadeState, player: number, guard: number, map: WalkerMap, range: number): boolean {
  const p = bodyBase(player), b = bodyBase(guard);
  const dx = state[p + BODY.x]! - state[b + BODY.x]!, dz = state[p + BODY.z]! - state[b + BODY.z]!;
  if (dx * dx + dz * dz > range * range) return false;
  const fx = Math.sign(state[b + BODY.vx]!), fz = Math.sign(state[b + BODY.vz]!);
  const forward = dx * fx + dz * fz;
  if (forward <= 0 || forward * forward * 2 < dx * dx + dz * dz) return false;
  const open = new Set(map.open);
  const steps = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dz)) / (WALKER_CELL / 4)));
  for (let at = 1; at < steps; at++) {
    const x = state[b + BODY.x]! + dx * at / steps, z0 = state[b + BODY.z]! + dz * at / steps;
    if (z0 < 0) continue;
    if (!open.has(walkerCell(map, x, z0))) return false;
  }
  return true;
}

export const walkerCaught: RulePiece<z.infer<typeof caughtParams>> = {
  id: 'walker_caught', params: caughtParams, roles: ['player', 'enemy'], trigger: 'tick', cost: () => ({ bodies: 0, rules: 1 }),
  fire({ state, player }, params) {
    return walkerVisible(state, player, params.body, params, params.range) ? [{ kind: 'damage', amount: 1, grace: 60 }] : [];
  },
};

type Mode = 'labyrinth' | 'stealth' | 'escape';
function levelOf(seed: number, params: WalkerParams, mode: Mode): ArcadeLevel {
  const map = walkerMaze(seed, params.size), open = new Set(map.open);
  const exit = walkerExit(map, params.segments);
  const route = params.corridorRisePermille === undefined ? [] : walkerPath(map, params.size + 1, exit);
  const wallSize = (cell: number): number => {
    if (route.length === 0) return WALKER_CELL;
    let nearest = 0, distance = Infinity;
    route.forEach((step, index) => { const d = Math.abs(step % params.size - cell % params.size) + Math.abs(Math.floor(step / params.size) - Math.floor(cell / params.size)); if (d < distance) { nearest = index; distance = d; } });
    const section = Math.min(2, Math.floor(nearest * 3 / route.length));
    return WALKER_CELL + Math.round(WALKER_CELL * (params.corridorRisePermille ?? 0) * section / 2000);
  };
  const bodies: BodyInit[] = [{ role: 'player', kind: 'player', x: WALKER_CELL, y: 0, z: WALKER_CELL, w: 800, h: 1200, d: 800, solid: false }];
  for (let cell = 0; cell < params.size * params.size; cell++) if (!open.has(cell)) bodies.push({ role: 'obstacle', kind: 'wall', x: cell % params.size * WALKER_CELL, y: 0, z: Math.floor(cell / params.size) * WALKER_CELL, w: wallSize(cell), h: 3 * UNIT, d: wallSize(cell), solid: true });
  bodies.push({ role: 'goal', kind: 'finish', x: exit % params.size * WALKER_CELL, y: 0, z: Math.floor(exit / params.size) * WALKER_CELL, w: 1600, h: 1800, d: 1600, solid: false });
  const path = walkerPath(map, params.size + 1, exit);
  if (params.collect) {
    const cell = path.at(-2)!;
    bodies.push({ role: 'collectible', kind: 'coin', x: cell % params.size * WALKER_CELL, y: 0, z: Math.floor(cell / params.size) * WALKER_CELL, w: 1000, h: 1000, d: 1000, solid: false });
  }
  // Stezka finále před strážným či pronásledovatelem: `walker_caught` čte strážného jako poslední tělo úrovně.
  if (params.segments === true) {
    const trail = path.slice(1, params.collect ? -2 : -1).slice(-WALKER_FINALE.trail);
    for (const cell of trail) bodies.push({ ...WALKER_SPARK, x: cell % params.size * WALKER_CELL, z: Math.floor(cell / params.size) * WALKER_CELL });
  }
  if (mode === 'stealth') bodies.push({ role: 'enemy', kind: 'guard', x: WALKER_CELL, y: 0, z: -2 * UNIT, w: 800, h: 1400, d: 800, solid: false, kinematic: true, vz: 40, period: 200 });
  if (mode === 'escape') bodies.push({ role: 'chaser', kind: 'chaser', x: WALKER_CELL, y: 0, z: -2 * UNIT, w: 800, h: 1400, d: 800, solid: false, kinematic: true });
  return { bodies, length: (params.size - 2) * WALKER_CELL };
}

function generator(mode: Mode): ModeGeneratorPiece<WalkerParams> {
  return {
    id: `walker_${mode}`, params: walkerParamsSchema, roles: ['player', 'obstacle', 'goal', 'enemy', 'chaser'],
    cost: params => ({ bodies: params.size * params.size + 3 + (params.segments === true ? WALKER_FINALE.trail : 0), rules: 4 }),
    generate: (seed, params) => levelOf(seed, params, mode),
    parts(seed, params, health) {
      const map = walkerMaze(seed, params.size), level = levelOf(seed, params, mode);
      const goal = walkerExit(map, params.segments);
      const path = walkerPath(map, params.size + 1, goal);
      const rules: PieceRef[] = [
        ...(params.collect || params.segments === true ? [{ id: 'pickup', params: {} }] : []),
        { id: 'finish', params: params.collect ? { allItems: true } : {} },
        { id: 'time_limit', params: { seconds: params.paceBudgetPct === undefined ? 80 : Math.max(10, Math.min(90, Math.ceil(((path.length - 1) * WALKER_CELL / params.speed * params.paceBudgetPct / 100 + (params.segments === true ? WALKER_FINALE.reserve : 0)) / 60))) } }, { id: 'out_of_health', params: {} },
      ];
      if (mode === 'stealth') rules.push({ id: 'walker_caught', params: { ...map, body: level.bodies.length - 1, range: 5 * UNIT } });
      if (mode === 'escape') rules.push({ id: 'hit', params: { role: 'chaser', effect: 'damage', grace: 60, after: 'respawn' } });
      return {
        level, rules, health: health ?? 3,
        control: { id: 'walker', params: { ...map, speed: params.speed, chaseSpeed: mode === 'escape' ? 55 : 0 } },
        bot: { id: 'walker_bot', params: { ...map, speed: params.speed, goal } },
        issues: path.length === 0 ? ['Walker maze has no route to the exit'] : [],
      };
    },
  };
}

export const walkerLabyrinth = generator('labyrinth');
export const walkerStealth = generator('stealth');
export const walkerEscape = generator('escape');
