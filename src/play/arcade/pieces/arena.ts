/**
 * Aréna (P25F, T4): volný pohyb po ploše, rosteš pojídáním menších a utíkáš
 * větším. Ovládání `move_free`, generátor `arena`, pravidla.
 *
 * Pohled shora, bez gravitace (hráč stojí na zemi a jen jezdí po `x/z`). Osa
 * nese **směr** pohybu: 32 směrů po 11,25°, osa 0 = stát (`arenaAxis` převede
 * směr na osu – tah, šipky i robot jdou přes ni). Směry jsou z celočíselné
 * tabulky, ne z `Math.sin`: stejný vstup musí dát stejný tik v každém prohlížeči.
 *
 * Velikost hráče je čítač: `size = start + score × grow` (strop `maxSize`),
 * skóre jen roste, takže růst je monotónní. Menší tělo (potrava, menší
 * buňka) sníst = skóre a zmizí; větší se dotkne = prohra, nebo se životy
 * ztráta života a návrat na start. Buňky jsou kinematické a vede je
 * ovládání (jádro jiné místo pro pohyb cizích těl nemá – Findings P25F):
 * větší než hráč pronásledují, menší bloudí a před hráčem utíkají.
 *
 * **Hratelné z konstrukce:** kolem startu leží věnec potravy a větší buňky
 * startují daleko – hladová cesta po nejbližší potravě vyroste nad první
 * větší buňku dřív, než k hráči dojede. `checkArenaLevel` to přepočítá.
 */

import { z } from 'zod';

import { createCompileRng } from '@/play/compile/rng';

import {
  ARCADE_HZ,
  ARCADE_LIMITS,
  type ArcadeEffect,
  type ArcadeLevel,
  AXIS_MAX,
  BODY,
  type BodyInit,
  COUNTER,
  type ControlPiece,
  FLAG,
  type GeneratorPiece,
  HEADER,
  type PieceRef,
  ROLE,
  type RulePiece,
  UNIT,
  bodyBase,
} from '../contract';
import { modeStub } from './mode-stub';

export const ARENA_DENSITIES = ['sparse', 'normal', 'dense'] as const;
export type ArenaDensity = (typeof ARENA_DENSITIES)[number];
export const ARENA_GOALS = ['grow', 'survive'] as const;
export type ArenaGoal = (typeof ARENA_GOALS)[number];

export const ARENA = {
  /** Polovina strany čtvercové arény. */
  half: 20 * UNIT,
  /** Rychlost hráče (9 m/s) a jak rychle se rozjede a zastaví. */
  speed: 150,
  accel: 25,
  friction: 25,
  startSize: 1000,
  /** O kolik hráč vyroste za bod skóre, a nejvýš na kolik. */
  grow: 250,
  maxSize: 6000,
  height: 600,
  /** Buňky: větší pronásledují, menší bloudí a do `fleeRadius` od hráče utíkají. */
  hunterSpeed: 60,
  preySpeed: 45,
  fleeRadius: 4 * UNIT,
  /** Bloudící buňka mění směr každých tolik tiků (posunuto podle indexu). */
  wanderTicks: 90,
  /** Body za snědení. */
  pelletPoints: 1,
  preyPoints: 2,
  hunterPoints: 3,
  reactionTicks: 8,
} as const;

// ---------------------------------------------------------------------------
// Směry

/** sin(k × 11,25°) × 1000 pro k = 0..8 (čtvrtina kruhu). */
const QUARTER = [0, 195, 383, 556, 707, 831, 924, 981, 1000] as const;
const sinOf = (k: number): number => {
  const i = ((k % 32) + 32) % 32;
  return i <= 8 ? QUARTER[i]! : i <= 16 ? QUARTER[16 - i]! : i <= 24 ? -QUARTER[i - 16]! : -QUARTER[32 - i]!;
};
/** Jednotkové směry × 1000: `dx = sin`, `dz = cos`; směr 0 míří po +z. */
export const DIRECTIONS: readonly { readonly dx: number; readonly dz: number }[] = Array.from({ length: 32 }, (_, k) => ({ dx: sinOf(k), dz: sinOf(k + 8) }));

/** Osa → směr 0..31, nebo −1 (stát). ±1000 = 180°. */
export function directionOfAxis(axis: number): number {
  if (axis === 0) return -1;
  const clamped = Math.max(-AXIS_MAX, Math.min(AXIS_MAX, axis));
  return (((Math.round((clamped * 16) / AXIS_MAX) % 32) + 32) % 32);
}

/** Směr (celočíselně: největší skalární součin) nejbližší vektoru `(dx, dz)`; nulový vektor = −1. */
export function directionToward(dx: number, dz: number): number {
  if (dx === 0 && dz === 0) return -1;
  let best = 0;
  let bestDot = Number.NEGATIVE_INFINITY;
  for (let k = 0; k < 32; k += 1) {
    const dir = DIRECTIONS[k]!;
    const dot = dx * dir.dx + dz * dir.dz;
    if (dot > bestDot) {
      bestDot = dot;
      best = k;
    }
  }
  return best;
}

/** Směr → osa (0 → 1, protože osa 0 znamená stát). */
export function axisOfDirection(direction: number): number {
  if (direction < 0) return 0;
  if (direction === 0) return 1;
  return direction <= 16 ? Math.round((direction * AXIS_MAX) / 16) : Math.round(((direction - 32) * AXIS_MAX) / 16);
}

/** Osa pro pohyb po vektoru `(dx, dz)` jádra – tah, šipky, robot. */
export const arenaAxis = (dx: number, dz: number): number => axisOfDirection(directionToward(dx, dz));

export const sizeOf = (score: number): number => Math.min(ARENA.maxSize, ARENA.startSize + Math.max(0, score) * ARENA.grow);

/** Kolik bodů hráč potřebuje, aby byl větší než tělo velikosti `size`. */
export const pointsToBeat = (size: number): number => Math.max(0, Math.floor((size - ARENA.startSize) / ARENA.grow) + 1);

const toward = (value: number, target: number, step: number): number => (value < target ? Math.min(target, value + step) : Math.max(target, value - step));

// ---------------------------------------------------------------------------
// Ovládání

const controlParams = z.object({ half: z.int().min(5 * UNIT).max(40 * UNIT).default(ARENA.half) }).strict();
export type ArenaControlParams = z.infer<typeof controlParams>;

/** Deterministický „náhodný“ směr bloudění z indexu a tiku (celá čísla, žádná náhoda za běhu). */
const wanderDirection = (index: number, tick: number): number => (((Math.imul(index + 1, 73_856_093) ^ Math.imul(Math.floor(tick / ARENA.wanderTicks) + 1, 19_349_663)) >>> 0) % 32);

/** Rychlost, která udrží tělo velikosti `size` v aréně (u stěny se složka otočí dovnitř). */
function bounce(position: number, velocity: number, size: number, half: number): number {
  const limit = half - Math.ceil(size / 2);
  if (position + velocity > limit) return -Math.abs(velocity);
  if (position + velocity < -limit) return Math.abs(velocity);
  return velocity;
}

function moveCells(state: Int32Array, player: number, half: number): void {
  const count = state[HEADER.bodyCount] as number;
  const tick = state[HEADER.tick] as number;
  const p = bodyBase(player);
  const px = state[p + BODY.x] as number;
  const pz = state[p + BODY.z] as number;
  const psize = state[p + BODY.w] as number;
  for (let i = 0; i < count; i += 1) {
    if (i === player) continue;
    const base = bodyBase(i);
    const flags = state[base + BODY.flags] as number;
    if ((flags & (FLAG.alive | FLAG.kinematic)) !== (FLAG.alive | FLAG.kinematic) || state[base + BODY.role] !== ROLE.enemy) continue;
    const x = state[base + BODY.x] as number;
    const zz = state[base + BODY.z] as number;
    const size = state[base + BODY.w] as number;
    let direction: number;
    let speed: number;
    if (size > psize) {
      direction = directionToward(px - x, pz - zz);
      speed = ARENA.hunterSpeed;
    } else if (Math.abs(px - x) + Math.abs(pz - zz) < ARENA.fleeRadius) {
      direction = directionToward(x - px, zz - pz);
      speed = ARENA.preySpeed;
    } else {
      direction = wanderDirection(i, tick + i * 7);
      speed = ARENA.preySpeed;
    }
    const dir = direction < 0 ? { dx: 0, dz: 0 } : DIRECTIONS[direction]!;
    state[base + BODY.vx] = bounce(x, Math.trunc((dir.dx * speed) / 1000), size, half);
    state[base + BODY.vz] = bounce(zz, Math.trunc((dir.dz * speed) / 1000), size, half);
  }
}

/** Ovládání volného pohybu: osa = směr, velikost ze skóre, hráč zůstane v aréně. */
export const moveFreeControl: ControlPiece<ArenaControlParams> = {
  id: 'move_free',
  params: controlParams,
  roles: ['player', 'enemy', 'collectible'],
  cost: () => ({ bodies: 1, rules: 0 }),
  step: (state, player, input, params) => {
    const base = bodyBase(player);
    const size = sizeOf(state[HEADER.counters + COUNTER.score] as number);
    state[base + BODY.w] = size;
    state[base + BODY.d] = size;

    const direction = directionOfAxis(input.axis);
    const dir = direction < 0 ? null : DIRECTIONS[direction]!;
    const tx = dir === null ? 0 : Math.trunc((dir.dx * ARENA.speed) / 1000);
    const tz = dir === null ? 0 : Math.trunc((dir.dz * ARENA.speed) / 1000);
    const rate = dir === null ? ARENA.friction : ARENA.accel;
    const limit = params.half - Math.ceil(size / 2);
    const x = state[base + BODY.x] as number;
    const zz = state[base + BODY.z] as number;
    // Stěna arény: tělo se do ní nezaboří ani po růstu.
    const vx = toward(state[base + BODY.vx] as number, tx, rate);
    const vz = toward(state[base + BODY.vz] as number, tz, rate);
    state[base + BODY.vx] = Math.max(-limit - x, Math.min(limit - x, vx));
    state[base + BODY.vz] = Math.max(-limit - zz, Math.min(limit - zz, vz));

    moveCells(state, player, params.half);
  },
};

// ---------------------------------------------------------------------------
// Pravidla

const eatParams = z.object({ effect: z.enum(['lose', 'damage']) }).strict();

/**
 * Dotek potravy nebo buňky: menší sníst (body podle druhu, zmizí), větší buňka
 * hráče sní (prohra, se životy ztráta života a návrat na start). Stejně velké
 * se minou.
 */
export const arenaEat: RulePiece<z.infer<typeof eatParams>> = {
  id: 'arena_eat',
  params: eatParams,
  roles: ['player', 'enemy', 'collectible'],
  trigger: 'contact',
  cost: () => ({ bodies: 0, rules: 1 }),
  fire: ({ state, player, other }, params): readonly ArcadeEffect[] => {
    const role = state[bodyBase(other) + BODY.role];
    if (role !== ROLE.enemy && role !== ROLE.collectible) return [];
    const mine = state[bodyBase(player) + BODY.w] as number;
    const theirs = state[bodyBase(other) + BODY.w] as number;
    if (theirs < mine) {
      const points = role === ROLE.collectible ? ARENA.pelletPoints : theirs >= ARENA.startSize ? ARENA.hunterPoints : ARENA.preyPoints;
      return [
        { kind: 'score', amount: points },
        { kind: 'despawn', body: other },
      ];
    }
    if (theirs > mine && role === ROLE.enemy) return params.effect === 'lose' ? [{ kind: 'lose' }] : [{ kind: 'damage', amount: 1 }, { kind: 'respawn' }];
    return [];
  },
};

const growToParams = z.object({ points: z.int().min(1).max(100) }).strict();

/** Skóre (= velikost) dosáhlo cíle → výhra. */
export const growTo: RulePiece<z.infer<typeof growToParams>> = {
  id: 'grow_to',
  params: growToParams,
  roles: ['player'],
  trigger: 'counter',
  cost: () => ({ bodies: 0, rules: 1 }),
  fire: ({ state }, params) => ((state[HEADER.counters + COUNTER.score] as number) >= params.points ? [{ kind: 'win' }] : []),
};

const surviveParams = z.object({ seconds: z.int().min(10).max(90) }).strict();

/** Přežil do limitu → výhra (opak `time_limit`). */
export const surviveTime: RulePiece<z.infer<typeof surviveParams>> = {
  id: 'survive_time',
  params: surviveParams,
  roles: ['player'],
  trigger: 'tick',
  cost: () => ({ bodies: 0, rules: 1 }),
  fire: ({ state }, params) => ((state[HEADER.tick] as number) + 1 >= params.seconds * ARCADE_HZ ? [{ kind: 'win' }] : []),
};

// ---------------------------------------------------------------------------
// Generátor

interface Tier {
  readonly pellets: number;
  readonly prey: number;
  readonly hunters: number;
  readonly hunterSize: readonly [number, number];
}

const TIERS: Readonly<Record<ArenaDensity, Tier>> = {
  sparse: { pellets: 26, prey: 4, hunters: 2, hunterSize: [1400, 2200] },
  normal: { pellets: 36, prey: 6, hunters: 3, hunterSize: [1500, 2500] },
  dense: { pellets: 50, prey: 8, hunters: 4, hunterSize: [1600, 2700] },
};

export const ARENA_LEVEL = {
  /** Věnec potravy kolem startu. */
  ringRadius: [2000, 4500] as const,
  /** Větší buňky startují aspoň tak daleko od středu. */
  hunterDistance: 16 * UNIT,
  /** Menší buňky aspoň tak daleko. */
  preyDistance: 6 * UNIT,
  preySize: [500, 850] as const,
  pelletSize: 400,
  /** Hladová cesta k růstu smí trvat nejvýš tenhle podíl doby, za kterou dorazí první větší. */
  growMargin: 0.7,
  /** Cíl růstu: tolik bodů nad největší buňku. */
  targetExtra: 3,
} as const;

const generatorParams = z
  .object({
    density: z.enum(ARENA_DENSITIES).default('normal'),
    goal: z.enum(ARENA_GOALS).default('grow'),
    seconds: z.int().min(20).max(80).default(40),
  })
  .strict();
export type ArenaParams = z.infer<typeof generatorParams>;

const cell = (role: 'enemy' | 'collectible', kind: string, x: number, zz: number, size: number): BodyInit => ({
  role,
  kind,
  x,
  y: 0,
  z: zz,
  w: size,
  h: role === 'enemy' ? ARENA.height : 200,
  d: size,
  solid: false,
  ...(role === 'enemy' ? { kinematic: true } : {}),
});

export const arenaLevel: GeneratorPiece<ArenaParams> = {
  id: 'arena',
  params: generatorParams,
  roles: ['player', 'enemy', 'collectible'],
  cost: (params) => {
    const tier = TIERS[params.density];
    return { bodies: 1 + tier.pellets + tier.prey + tier.hunters, rules: 3 };
  },
  generate: (seed, params) => {
    const rng = createCompileRng(seed);
    const tier = TIERS[params.density];
    const { half } = ARENA;
    const bodies: BodyInit[] = [{ role: 'player', kind: 'player', x: 0, y: 0, z: 0, w: ARENA.startSize, h: ARENA.height, d: ARENA.startSize, solid: false }];

    const hunterSizes = Array.from({ length: tier.hunters }, () => 2 * rng.int(tier.hunterSize[0] / 2, tier.hunterSize[1] / 2));
    // Věnec: tolik potravy, kolik je potřeba přerůst největší buňku, + rezerva.
    const ring = pointsToBeat(Math.max(...hunterSizes)) + 2;
    for (let k = 0; k < ring; k += 1) {
      const angle = (k * 32) / ring;
      const dir = DIRECTIONS[Math.floor(angle) % 32]!;
      const radius = rng.int(ARENA_LEVEL.ringRadius[0], ARENA_LEVEL.ringRadius[1]);
      bodies.push(cell('collectible', 'food', Math.trunc((dir.dx * radius) / 1000), Math.trunc((dir.dz * radius) / 1000), ARENA_LEVEL.pelletSize));
    }
    // Menší buňky (index hned za věncem) a zbytek potravy po celé aréně.
    for (let k = 0; k < tier.prey; k += 1) {
      const size = 2 * rng.int(ARENA_LEVEL.preySize[0] / 2, ARENA_LEVEL.preySize[1] / 2);
      const edge = half - size;
      for (;;) {
        const x = rng.int(-edge, edge);
        const zz = rng.int(-edge, edge);
        if (x * x + zz * zz >= ARENA_LEVEL.preyDistance ** 2) {
          bodies.push(cell('enemy', 'cell', x, zz, size));
          break;
        }
      }
    }
    const edge = half - ARENA_LEVEL.pelletSize;
    for (let k = ring; k < tier.pellets; k += 1) bodies.push(cell('collectible', 'food', rng.int(-edge, edge), rng.int(-edge, edge), ARENA_LEVEL.pelletSize));

    // Větší buňky až nad hotovou potravou: tak daleko, aby hladová cesta vyrostla
    // nad každou dřív, než dojede (`checkArenaLevel`); nejde-li to náhodně, roh.
    const pending: ArcadeLevel = { bodies, length: 0 };
    for (const size of hunterSizes) {
      const far = half - size;
      const grow = greedyGrowTicks(pending, pointsToBeat(size));
      const reach = Math.max(ARENA_LEVEL.hunterDistance, Math.ceil((grow / ARENA_LEVEL.growMargin + 1) * ARENA.hunterSpeed + (size + ARENA.startSize) / 2));
      let placed: BodyInit | null = null;
      for (let attempt = 0; attempt < 64 && placed === null; attempt += 1) {
        const x = rng.int(-far, far);
        const zz = rng.int(-far, far);
        if (x * x + zz * zz >= reach * reach) placed = cell('enemy', 'cell', x, zz, size);
      }
      bodies.push(placed ?? cell('enemy', 'cell', rng.int(0, 1) === 0 ? -far : far, rng.int(0, 1) === 0 ? -far : far, size));
    }
    return { bodies, length: 0 };
  },
};

/** Cíl růstu: větší než největší buňka a ještě `targetExtra` bodů. */
export function arenaTarget(level: ArcadeLevel): number {
  const largest = Math.max(ARENA.startSize, ...level.bodies.filter((b) => b.role === 'enemy').map((b) => b.w));
  return Math.min(pointsToBeat(ARENA.maxSize - 1), pointsToBeat(largest) + ARENA_LEVEL.targetExtra);
}

export function arenaControlRef(): PieceRef {
  return { id: 'move_free', params: { half: ARENA.half } };
}

export function arenaBotRef(): PieceRef {
  return { id: 'arena_bot', params: { half: ARENA.half } };
}

/** Pravidla arény: jíst a být sněden, výhra růstem nebo přežitím; se životy prohra až po posledním. */
export function arenaRules(level: ArcadeLevel, params: Pick<ArenaParams, 'goal' | 'seconds'>, health?: number): PieceRef[] {
  const rules: PieceRef[] = [{ id: 'arena_eat', params: { effect: health === undefined ? 'lose' : 'damage' } }];
  rules.push(params.goal === 'grow' ? { id: 'grow_to', params: { points: arenaTarget(level) } } : { id: 'survive_time', params: { seconds: params.seconds } });
  if (health !== undefined) rules.push({ id: 'out_of_health', params: {} });
  return rules;
}

// ---------------------------------------------------------------------------
// Kontrola hratelnosti

const distance = (a: { readonly x: number; readonly z: number }, b: { readonly x: number; readonly z: number }): number => Math.hypot(a.x - b.x, a.z - b.z);

/**
 * Hladová cesta od startu po nejbližší potravě: kolik tiků trvá sníst `points`
 * bodů (plnou rychlostí, s reakcí na každé sousto). Nekonečno, když potrava nestačí.
 */
export function greedyGrowTicks(level: ArcadeLevel, points: number): number {
  const player = level.bodies[0]!;
  const food = level.bodies.filter((b) => b.role === 'collectible');
  let at = { x: player.x, z: player.z };
  let ticks = 0;
  for (let eaten = 0; eaten < points; eaten += 1) {
    let best = -1;
    for (let i = 0; i < food.length; i += 1) if (best < 0 || distance(at, food[i]!) < distance(at, food[best]!)) best = i;
    if (best < 0) return Number.POSITIVE_INFINITY;
    const next = food.splice(best, 1)[0]!;
    ticks += Math.ceil(distance(at, next) / ARENA.speed) + ARENA.reactionTicks;
    at = { x: next.x, z: next.z };
  }
  return ticks;
}

/** Za kolik tiků dojede větší buňka ke startu (vzdálenost okrajů / její rychlost). */
export const hunterArrivalTicks = (level: ArcadeLevel, hunter: BodyInit): number => {
  const player = level.bodies[0]!;
  return Math.floor((distance(player, hunter) - (hunter.w + player.w) / 2) / ARENA.hunterSpeed);
};

/** Tvrzení „hratelné z konstrukce“ nad hotovou arénou; prázdné pole = hratelná. */
export function checkArenaLevel(level: ArcadeLevel, half: number = ARENA.half): string[] {
  const issues: string[] = [];
  const m = (units: number): string => `${(units / UNIT).toFixed(1)} m`;
  const player = level.bodies[0];
  if (player === undefined || player.role !== 'player') return ['no player'];
  for (const body of level.bodies) {
    if (Math.abs(body.x) + body.w / 2 > half || Math.abs(body.z) + body.d / 2 > half) issues.push(`a ${body.kind} at ${m(body.x)}, ${m(body.z)} sits outside the arena`);
  }
  const cells = level.bodies.filter((b) => b.role === 'enemy');
  const hunters = cells.filter((b) => b.w > player.w);
  if (hunters.length === 0) issues.push('no bigger cell – nothing to run from');
  for (const prey of cells.filter((b) => b.w <= player.w)) if (distance(prey, player) < ARENA_LEVEL.preyDistance) issues.push(`a smaller cell starts ${m(distance(prey, player))} from the player`);

  // Vyrůst nad první větší buňku dřív, než dojede.
  const first = [...hunters].sort((a, b) => hunterArrivalTicks(level, a) - hunterArrivalTicks(level, b))[0];
  if (first !== undefined) {
    const grow = greedyGrowTicks(level, pointsToBeat(first.w));
    const arrive = hunterArrivalTicks(level, first);
    if (grow > ARENA_LEVEL.growMargin * arrive) issues.push(`growing past the first hunter takes ${grow} ticks but it arrives in ${arrive}`);
  }
  // Na výhru růstem musí potrava (bez buněk) stačit.
  const food = level.bodies.filter((b) => b.role === 'collectible').length * ARENA.pelletPoints;
  if (food < arenaTarget(level)) issues.push(`only ${food} points of food for a target of ${arenaTarget(level)}`);
  if (level.bodies.length > ARCADE_LIMITS.maxBodies) issues.push(`${level.bodies.length} bodies exceed the ${ARCADE_LIMITS.maxBodies} body limit`);
  return issues;
}

/** Režimy `arena.escape` a `arena.collect` (pahýly P32-0 T4, naplní P32E T1). */
export const arenaEscape = modeStub('arena_escape');
export const arenaCollect = modeStub('arena_collect');
