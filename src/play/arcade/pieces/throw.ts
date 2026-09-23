/**
 * Hod (P25G, T4): ovládání tah-pusť, pravidlo odhozu, řešič hodu a generátor.
 *
 * Boční pohled po +z: hráč stojí v počátku a hází dopředu. Osa nastaví úhel
 * (−1000..1000 = 5°..85°, 0 = 45°), nahoru/dolů ho posune, držení (`HOLD`)
 * nabíjí sílu (1..`maxCharge` tiků), ťuk (`TAP`) = puštění. Ovládání mění
 * jen tělo hráče: `aux0` = úhel, `aux1` = nabití, v tiku puštění záporné
 * (−nabití). Míček vydá pravidlo `launch` efektem `spawn`; zbývající hody
 * jsou čítač `ammo`, rozestup hodů `cooldown`.
 *
 * Cíle: terč, koš na tyči, nebo věž z bloků (stohování jádra: sestřelený
 * blok zmizí, horní dopadnou). **Hratelné z konstrukce:** `solveThrow`
 * najde pro každý cíl (u věže pro každý blok shora dolů) úhel a sílu
 * v mezích, které ho v přesné simulaci letu jádra trefí jako první;
 * generátor cíl, pro který řešení není, přesune.
 */

import { z } from 'zod';

import { createCompileRng } from '@/play/compile/rng';

import {
  ARCADE_HZ,
  ARCADE_LIMITS,
  type ArcadeEffect,
  type ArcadeLevel,
  AXIS_MAX,
  AXIS_MIN,
  BODY,
  BUTTON,
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
import { GRAVITY } from '../kernel';

export const THROW_DIFFICULTIES = ['easy', 'normal', 'hard'] as const;
export type ThrowDifficulty = (typeof THROW_DIFFICULTIES)[number];
export const THROW_GOALS = ['target', 'hoop', 'tower'] as const;
export type ThrowGoal = (typeof THROW_GOALS)[number];
/** Popisek role `target` ve specu podle toho, co generátor postaví. */
export const THROW_GOAL_LABELS: Readonly<Record<ThrowGoal, string>> = { target: 'target', hoop: 'hoop', tower: 'block' };

export const THROW = {
  /** Rychlost míčku při nejslabším a nejsilnějším hodu (jednotek za tik). */
  minSpeed: 150,
  maxSpeed: 450,
  /** Tiky držení do plné síly (1 s). */
  maxCharge: ARCADE_HZ,
  /** Úhel: osa 0 = 45°, ±1000 = ±40°. */
  baseDeg: 45,
  spanDeg: 40,
  aimStep: 40,
  /** Odkud míček vyletí (spodní stěna, přední hrana hráče). */
  launchY: 1500,
  launchZ: 400,
  ballSize: 400,
  ballLifetime: 5 * ARCADE_HZ,
  /** Tiky mezi dvěma hody. */
  cooldown: 30,
  playerW: 600,
  playerH: 1700,
  playerD: 600,
  blockSize: 800,
} as const;

/** Rychlost hodu pro nabití `charge` (sevřené do 1..maxCharge). */
export function throwSpeed(charge: number): number {
  const c = Math.max(1, Math.min(THROW.maxCharge, charge));
  return THROW.minSpeed + Math.trunc(((THROW.maxSpeed - THROW.minSpeed) * c) / THROW.maxCharge);
}

const angleOf = (aim: number): number => ((THROW.baseDeg + (aim * THROW.spanDeg) / AXIS_MAX) * Math.PI) / 180;

/** Rychlost míčku (nahoru, vpřed) pro úhel `aim` a nabití `charge`. */
export function launchVelocity(aim: number, charge: number): { vy: number; vz: number } {
  const speed = throwSpeed(charge);
  const angle = angleOf(aim);
  return { vy: Math.trunc(speed * Math.sin(angle)), vz: Math.trunc(speed * Math.cos(angle)) };
}

const controlParams = z.object({}).strict();

/** Ovládání: hráč stojí, osa/nahoru/dolů = úhel, držení nabíjí, ťuk pustí. */
export const throwControl: ControlPiece<z.infer<typeof controlParams>> = {
  id: 'throw',
  params: controlParams,
  roles: ['player'],
  cost: () => ({ bodies: 1, rules: 0 }),
  step: (state, player, input) => {
    const base = bodyBase(player);
    state[base + BODY.vx] = 0;
    state[base + BODY.vz] = 0;
    let aim = state[base + BODY.aux0] as number;
    if (input.axis !== 0) aim = input.axis;
    if ((input.buttons & BUTTON.UP) !== 0) aim += THROW.aimStep;
    if ((input.buttons & BUTTON.DOWN) !== 0) aim -= THROW.aimStep;
    state[base + BODY.aux0] = Math.max(AXIS_MIN, Math.min(AXIS_MAX, aim));
    // Minulý tik byl puštění: nabíjení začíná znovu.
    let charge = Math.max(0, state[base + BODY.aux1] as number);
    if ((input.buttons & BUTTON.HOLD) !== 0) charge = Math.min(THROW.maxCharge, charge + 1);
    state[base + BODY.aux1] = (input.buttons & BUTTON.TAP) !== 0 ? -Math.max(1, charge) : charge;
  },
};

const launchParams = z.object({ template: z.int().min(0) }).strict();

/** Puštění → míček z ruky hráče, hod ubere, rozestup hodů. Puštění v rozestupu se zahodí. */
export const launch: RulePiece<z.infer<typeof launchParams>> = {
  id: 'launch',
  params: launchParams,
  roles: ['player', 'projectile'],
  trigger: 'tick',
  cost: () => ({ bodies: 0, rules: 1 }),
  fire: ({ state, player }, params) => {
    const cooldown = state[HEADER.counters + COUNTER.cooldown] as number;
    if (cooldown > 0) return [{ kind: 'count', counter: 'cooldown', amount: -1 }];
    const base = bodyBase(player);
    const released = state[base + BODY.aux1] as number;
    if (released >= 0 || (state[HEADER.counters + COUNTER.ammo] as number) <= 0) return [];
    const { vy, vz } = launchVelocity(state[base + BODY.aux0] as number, -released);
    const effects: ArcadeEffect[] = [
      { kind: 'count', counter: 'ammo', amount: -1 },
      { kind: 'count', counter: 'cooldown', amount: THROW.cooldown },
      { kind: 'spawn', template: params.template, x: state[base + BODY.x] as number, y: THROW.launchY, z: (state[base + BODY.z] as number) + THROW.launchZ, vx: 0, vy, vz },
    ];
    return effects;
  },
};

// ---------------------------------------------------------------------------
// Řešič hodu

/** Tělo, které může míček zastavit: terč, nepřítel, nebo pevné. */
export interface ThrowBox {
  readonly index: number;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly w: number;
  readonly h: number;
  readonly d: number;
}

export interface ThrowPlan {
  readonly aim: number;
  readonly charge: number;
}

/**
 * Let míčku přesně jako v jádře (gravitace, pak posun, zásah proti obalu
 * dráhy za tik v pořadí indexů, dopad na zem = konec; odraz se nepočítá).
 * Vrací index prvního zasaženého těla, nebo −1.
 */
export function simulateThrow(boxes: readonly ThrowBox[], plan: ThrowPlan): number {
  let { vy } = launchVelocity(plan.aim, plan.charge);
  const { vz } = launchVelocity(plan.aim, plan.charge);
  let y = THROW.launchY;
  let z = THROW.launchZ;
  const s = THROW.ballSize;
  for (let n = 1; n < THROW.ballLifetime; n += 1) {
    vy -= GRAVITY;
    y += vy;
    z += vz;
    const bottom = Math.min(y, y - vy);
    const top = Math.max(y, y - vy) + s;
    for (const box of boxes) {
      if (Math.abs(2 * z - vz - 2 * box.z) < s + Math.abs(vz) + box.d && Math.abs(-2 * box.x) < s + box.w && bottom < box.y + box.h && box.y < top) return box.index;
    }
    if (y <= 0) return -1;
  }
  return -1;
}

/** Nejmenší a největší osa, kterou řešič zkouší, a krok. */
const AIM_TRIES: { readonly from: number; readonly to: number; readonly step: number } = { from: -700, to: 900, step: 100 };

/**
 * Úhel a síla, které trefí tělo `target` jako první, nebo null. Pro každý
 * zkoušený úhel spočítá sílu z rovnice letu (diskrétní: y = vy·n − g·n(n+1)/2)
 * a ověří ji a dvě sousední nabití simulací – nejvýš 17 × 5 letů.
 */
export function solveThrow(boxes: readonly ThrowBox[], target: number): ThrowPlan | null {
  const box = boxes.find((b) => b.index === target);
  if (box === undefined) return null;
  const dz = box.z - THROW.launchZ;
  const dy = box.y + box.h / 2 - THROW.launchY - THROW.ballSize / 2;
  for (let aim = AIM_TRIES.from; aim <= AIM_TRIES.to; aim += AIM_TRIES.step) {
    const a = aim === 0 ? 1 : aim;
    const angle = angleOf(a);
    const rise = dz * Math.tan(angle) - dy;
    if (rise <= 0) continue;
    const ticks = (-1 + Math.sqrt(1 + (8 * rise) / GRAVITY)) / 2;
    const speed = dz / (ticks * Math.cos(angle));
    const charge = Math.round(((speed - THROW.minSpeed) * THROW.maxCharge) / (THROW.maxSpeed - THROW.minSpeed));
    for (const c of [charge, charge - 1, charge + 1, charge - 2, charge + 2]) {
      if (c < 1 || c > THROW.maxCharge) continue;
      if (simulateThrow(boxes, { aim: a, charge: c }) === target) return { aim: a, charge: c };
    }
  }
  return null;
}

/** Tělesa, která míček zastaví (pořadí = index jako v jádře). */
export function boxesOfLevel(bodies: readonly BodyInit[]): ThrowBox[] {
  const boxes: ThrowBox[] = [];
  bodies.forEach((body, index) => {
    if (index === 0 || body.template === true || body.role === 'projectile') return;
    if (body.role === 'target' || body.role === 'enemy' || body.solid) boxes.push({ index, x: body.x, y: body.y, z: body.z, w: body.w, h: body.h, d: body.d });
  });
  return boxes;
}

/** Totéž nad stavem: jen živá tělesa. */
export function boxesOfState(state: Int32Array, player: number): ThrowBox[] {
  const boxes: ThrowBox[] = [];
  const count = state[HEADER.bodyCount] as number;
  for (let i = 0; i < count; i += 1) {
    if (i === player) continue;
    const b = bodyBase(i);
    const flags = state[b + BODY.flags] as number;
    const role = state[b + BODY.role];
    if ((flags & FLAG.alive) === 0 || role === ROLE.projectile) continue;
    if (role !== ROLE.target && role !== ROLE.enemy && (flags & FLAG.solid) === 0) continue;
    boxes.push({ index: i, x: state[b + BODY.x] as number, y: state[b + BODY.y] as number, z: state[b + BODY.z] as number, w: state[b + BODY.w] as number, h: state[b + BODY.h] as number, d: state[b + BODY.d] as number });
  }
  return boxes;
}

// ---------------------------------------------------------------------------
// Generátor

interface Tier {
  readonly goals: number;
  readonly towerHeight: number;
  /** Zeď mezi hráčem a cíli, přes kterou se musí házet obloukem. */
  readonly wall: boolean;
  readonly near: number;
  readonly far: number;
  readonly spareThrows: number;
}

const TIERS: Readonly<Record<ThrowDifficulty, Tier>> = {
  easy: { goals: 2, towerHeight: 2, wall: false, near: 7 * UNIT, far: 15 * UNIT, spareThrows: 3 },
  normal: { goals: 3, towerHeight: 3, wall: false, near: 8 * UNIT, far: 19 * UNIT, spareThrows: 3 },
  hard: { goals: 3, towerHeight: 4, wall: true, near: 10 * UNIT, far: 22 * UNIT, spareThrows: 2 },
};

export const THROW_FIELD = {
  wallZ: [5 * UNIT, 7 * UNIT] as const,
  wallH: [2500, 3500] as const,
  /** Pokusů o umístění jednoho cíle, než generátor vezme nejbližší řešitelnou polohu. */
  placeTries: 12,
} as const;

const generatorParams = z
  .object({
    difficulty: z.enum(THROW_DIFFICULTIES).default('normal'),
    /** Co se trefuje; bez hodnoty podle semínka. */
    goal: z.enum(THROW_GOALS).optional(),
    /** Míček skáče (koš, míč); bez hodnoty jen u koše. */
    bounce: z.boolean().optional(),
    /** Hodů navíc nad počet cílů; bez hodnoty podle obtížnosti. */
    spareThrows: z.int().min(0).max(10).optional(),
  })
  .strict();
export type ThrowParams = z.infer<typeof generatorParams>;

const player: BodyInit = { role: 'player', kind: 'thrower', x: 0, y: 0, z: 0, w: THROW.playerW, h: THROW.playerH, d: THROW.playerD, solid: false };

/** Těla jednoho cíle na hloubce `z`: terč, koš na tyči, nebo věž. */
function goalBodies(goal: ThrowGoal, z: number, height: number, lift: number): BodyInit[] {
  if (goal === 'target') {
    const target: BodyInit = { role: 'target', kind: 'target', x: 0, y: lift, z, w: 1200, h: 1200, d: 300, solid: false };
    return lift === 0 ? [target] : [{ role: 'obstacle', kind: 'wood-block', x: 0, y: 0, z, w: 1200, h: lift, d: 1200, solid: true }, target];
  }
  if (goal === 'hoop') {
    // Obroučka na tyči; tyč stojí za ní a je pevná (odraz od desky = konec hodu).
    const rim = 2600 + lift;
    return [
      { role: 'target', kind: 'hoop', x: 0, y: rim, z, w: 900, h: 250, d: 900, solid: false },
      { role: 'obstacle', kind: 'pole', x: 0, y: 0, z: z + 700, w: 300, h: rim + 900, d: 300, solid: true },
    ];
  }
  return Array.from({ length: height }, (_, k): BodyInit => ({ role: 'target', kind: 'wood-block', x: 0, y: k * THROW.blockSize, z, w: THROW.blockSize, h: THROW.blockSize, d: THROW.blockSize, solid: true, gravity: true }));
}

/** Pořadí, ve kterém se cíl dá sestřelit: věž shora dolů, jinak cíl sám. */
function hitOrder(bodies: readonly BodyInit[], from: number, to: number): number[] {
  const targets: number[] = [];
  for (let i = from; i < to; i += 1) if (bodies[i]?.role === 'target') targets.push(i);
  return targets.sort((a, b) => (bodies[b]?.y ?? 0) - (bodies[a]?.y ?? 0));
}

/** Jde cíl (těla `from..to`) sestřelit celý, když ostatní cíle stojí? Věž shora dolů, bez dopadu. */
function solvable(bodies: readonly BodyInit[], from: number, to: number): boolean {
  const removed = new Set<number>();
  for (const target of hitOrder(bodies, from, to)) {
    const boxes = boxesOfLevel(bodies).filter((box) => !removed.has(box.index));
    if (solveThrow(boxes, target) === null) return false;
    removed.add(target);
  }
  return true;
}

export const throwField: GeneratorPiece<ThrowParams> = {
  id: 'throw_field',
  params: generatorParams,
  roles: ['player', 'projectile', 'target', 'obstacle'],
  cost: (params) => ({ bodies: 3 + TIERS[params.difficulty].goals * Math.max(2, TIERS[params.difficulty].towerHeight) + 4, rules: 4 }),
  generate: (seed, params) => {
    const rng = createCompileRng(seed);
    const tier = TIERS[params.difficulty];
    const goal = params.goal ?? rng.pick(THROW_GOALS);
    const bounce = params.bounce ?? goal === 'hoop';
    const bodies: BodyInit[] = [
      player,
      { role: 'projectile', kind: 'ball', x: 0, y: 0, z: 0, w: THROW.ballSize, h: THROW.ballSize, d: THROW.ballSize, solid: false, template: true, gravity: true, lifetime: THROW.ballLifetime, bounce: bounce ? 450 : 0 },
    ];
    if (tier.wall) {
      const wallH = rng.int(THROW_FIELD.wallH[0], THROW_FIELD.wallH[1]);
      bodies.push({ role: 'obstacle', kind: 'wall', x: 0, y: 0, z: rng.int(THROW_FIELD.wallZ[0], THROW_FIELD.wallZ[1]), w: 4000, h: wallH, d: 400, solid: true });
    }

    // Cíle od nejvzdálenějšího: bližší cíl se pak ověřuje s tím vzdálenějším na místě.
    const band = Math.floor((tier.far - tier.near) / tier.goals);
    for (let g = tier.goals - 1; g >= 0; g -= 1) {
      const from = bodies.length;
      let placed = false;
      for (let attempt = 0; attempt < THROW_FIELD.placeTries && !placed; attempt += 1) {
        const z = tier.near + g * band + rng.int(0, band - 1500);
        const lift = goal === 'tower' ? 0 : rng.int(0, 2) * 600;
        bodies.push(...goalBodies(goal, z, tier.towerHeight, lift));
        if (solvable(bodies, from, bodies.length)) placed = true;
        else bodies.length = from;
      }
      // Nic nesedlo: nejnižší cíl na začátku pásu (tam řešení je vždy, zkontroluje test).
      if (!placed) bodies.push(...goalBodies(goal, tier.near + g * band, 1, 0));
    }

    const goals = bodies.filter((body) => body.role === 'target').length;
    const throws = goals + (params.spareThrows ?? tier.spareThrows);
    return { bodies, length: 0, spawnSlots: 3, counters: { ammo: throws, reserve: 0 } };
  },
};

/** Pravidla hodu: odhoz, zásah, všechny cíle, hody došly. */
export function throwRules(): PieceRef[] {
  return [
    { id: 'launch', params: { template: 1 } },
    { id: 'shot_hit', params: {} },
    { id: 'cleared', params: {} },
    { id: 'out_of_ammo', params: {} },
  ];
}

/** Tvrzení „hratelné z konstrukce“ nad hotovým polem; prázdné pole = hratelné. */
export function checkThrowLevel(level: ArcadeLevel): string[] {
  const issues: string[] = [];
  const m = (units: number): string => `${(units / UNIT).toFixed(1)} m`;
  const { bodies } = level;
  // Každý cíl sám (ostatní stojí): věž = souvislá řada bloků na stejném z.
  const byZ = new Map<number, number[]>();
  bodies.forEach((body, index) => {
    if (body.role === 'target') byZ.set(body.z, [...(byZ.get(body.z) ?? []), index]);
  });
  for (const [z, indices] of byZ) {
    const removed = new Set<number>();
    for (const target of [...indices].sort((a, b) => (bodies[b]?.y ?? 0) - (bodies[a]?.y ?? 0))) {
      const boxes = boxesOfLevel(bodies).filter((box) => !removed.has(box.index));
      if (solveThrow(boxes, target) === null) issues.push(`target ${target} at ${m(z)} cannot be hit by any throw within the power and angle limits`);
      removed.add(target);
    }
  }
  const goals = bodies.filter((body) => body.role === 'target').length;
  if (goals === 0) issues.push('nothing to hit');
  if ((level.counters?.ammo ?? 0) < goals) issues.push(`${level.counters?.ammo ?? 0} throws for ${goals} targets`);
  const capacity = bodies.length + (level.spawnSlots ?? 0);
  if (capacity > ARCADE_LIMITS.maxBodies) issues.push(`${capacity} bodies exceed the ${ARCADE_LIMITS.maxBodies} body limit`);
  return issues;
}
