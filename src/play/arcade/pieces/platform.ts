/**
 * Plošinovka (P25C, T2): ovládání, generátor úrovně a pravidla.
 *
 * Boční pohled: úroveň běží po +z (vpravo), `x` je hloubka a zůstává 0.
 * Vlevo/vpravo (osa nebo tlačítka) = zrychlení a tření, ťuk/nahoru = skok
 * ze země, volitelně jeden dvojskok ve vzduchu. Generátor staví řadu plošin
 * nad propastí a zná konstanty ovládání, takže úroveň je **hratelná
 * z konstrukce**: každá mezera je v dosahu jednoho skoku i se zpožděním
 * reakce, výškový rozdíl jde vyskočit a hrot má před sebou i za sebou místo
 * na rozběh a dopad. `checkPlatformLevel` to samé tvrzení přepočítá nad
 * hotovou úrovní – test i ověření ho čtou.
 */

import { z } from 'zod';

import { createCompileRng } from '@/play/compile/rng';

import { ARCADE_LIMITS, type ArcadeLevel, AXIS_MAX, BODY, BUTTON, type BodyInit, type ControlPiece, FLAG, type GeneratorPiece, type PieceRef, UNIT, bodyBase } from '../contract';
import { GRAVITY } from '../kernel';

export const PLATFORM_DIFFICULTIES = ['easy', 'normal', 'hard'] as const;
export type PlatformDifficulty = (typeof PLATFORM_DIFFICULTIES)[number];

export const PLATFORM = {
  /** Nejvyšší rychlost do strany (6,6 m/s). */
  maxRun: 110,
  groundAccel: 12,
  airAccel: 8,
  groundFriction: 14,
  airDrag: 3,
  jumpVy: 180,
  doubleJumpVy: 160,
  playerW: 600,
  playerH: 1600,
  playerD: 500,
  /** Tloušťka a hloubka desky plošiny. */
  slabH: 800,
  slabW: 3000,
  /** Horní hrana startovní plošiny; ostatní se od ní liší o nejvýš `maxRise` na krok. */
  baseTop: 4000,
  minTop: 2500,
  maxTop: 6500,
  maxRise: 1000,
  /** Spodní stěna hráče pod touhle výškou = spadl do propasti. */
  fallBelowY: 1000,
  spikeH: 500,
  spikeD: 800,
  /** Volno před hrotem i za ním (rozběh a dopad). */
  spikeMargin: 1800,
  /** Kolik z dosahu skoku smí mezera využít – zbytek je rezerva na pozdní odraz. */
  jumpSafety: 0.65,
} as const;

/** Výška spodní stěny po `k` ticích skoku z rovné země (jádro: nejdřív `vy −= g`, pak `y += vy`). */
const jumpY = (k: number): number => PLATFORM.jumpVy * k - (GRAVITY * k * (k + 1)) / 2;

/** Nejvýš dosažená výška skoku. */
export const PLATFORM_JUMP_PEAK = (() => {
  let peak = 0;
  for (let k = 1; jumpY(k) > peak; k += 1) peak = jumpY(k);
  return peak;
})();

/** Poslední tik skoku, kdy je hráč ještě aspoň ve výšce `dh` (na sestupu). */
function airTicks(dh: number): number {
  let last = 0;
  for (let k = 1; k < 200; k += 1) if (jumpY(k) >= dh) last = k;
  return last;
}

/** První tik skoku, kdy hráč dosáhne výšky `dh` (na výstupu). */
export function riseTicks(dh: number): number {
  for (let k = 1; k < 200; k += 1) if (jumpY(k) >= dh) return k;
  return Number.POSITIVE_INFINITY;
}

/**
 * Nejširší mezera (hrana–hrana), kterou úroveň smí mít při výškovém rozdílu
 * `dh` (nahoru kladně): podíl dosahu jednoho skoku plnou rychlostí plus půl
 * hráče, o kterou smí přečnívat hranu při odrazu.
 */
export function maxGap(dh: number): number {
  return Math.floor(PLATFORM.jumpSafety * PLATFORM.maxRun * airTicks(dh)) + PLATFORM.playerD / 2;
}

const toward = (value: number, target: number, step: number): number => (value < target ? Math.min(target, value + step) : Math.max(target, value - step));

const controlParams = z.object({ doubleJump: z.boolean().default(false) }).strict();

/** Ovládání plošinovky. `aux0` = 1, když je dvojskok v tomhle letu spotřebovaný. */
export const platformControl: ControlPiece<z.infer<typeof controlParams>> = {
  id: 'platform',
  params: controlParams,
  roles: ['player'],
  cost: () => ({ bodies: 1, rules: 0 }),
  step: (state, player, input, params) => {
    const base = bodyBase(player);
    const grounded = ((state[base + BODY.flags] as number) & FLAG.grounded) !== 0;
    let target = Math.trunc((Math.max(-AXIS_MAX, Math.min(AXIS_MAX, input.axis)) * PLATFORM.maxRun) / AXIS_MAX);
    if ((input.buttons & BUTTON.LEFT) !== 0) target = -PLATFORM.maxRun;
    if ((input.buttons & BUTTON.RIGHT) !== 0) target = PLATFORM.maxRun;
    const vz = state[base + BODY.vz] as number;
    const rate = target !== 0 ? (grounded ? PLATFORM.groundAccel : PLATFORM.airAccel) : grounded ? PLATFORM.groundFriction : PLATFORM.airDrag;
    state[base + BODY.vz] = toward(vz, target, rate);
    state[base + BODY.vx] = 0;

    if (grounded) state[base + BODY.aux0] = 0;
    if ((input.buttons & (BUTTON.TAP | BUTTON.UP)) !== 0) {
      if (grounded) state[base + BODY.vy] = PLATFORM.jumpVy;
      else if (params.doubleJump && state[base + BODY.aux0] === 0) {
        state[base + BODY.vy] = PLATFORM.doubleJumpVy;
        state[base + BODY.aux0] = 1;
      }
    }
  },
};

// ---------------------------------------------------------------------------
// Generátor

interface Tier {
  readonly gap: readonly [number, number];
  readonly rise: number;
  readonly slab: readonly [number, number];
  /** Hrot na každé n-té plošině. */
  readonly spikeEvery: number;
}

const TIERS: Readonly<Record<PlatformDifficulty, Tier>> = {
  easy: { gap: [1500, 2000], rise: 400, slab: [5000, 8000], spikeEvery: 4 },
  normal: { gap: [1600, 2600], rise: 700, slab: [4500, 7000], spikeEvery: 2 },
  hard: { gap: [2000, 3400], rise: PLATFORM.maxRise, slab: [4500, 6500], spikeEvery: 1 },
};

export const PLATFORM_LEVEL = {
  minLengthM: 60,
  maxLengthM: 300,
  startSlab: 8000,
  finalSlab: 6000,
  /** Mezera s pohyblivou plošinou a její deska. */
  shuttleGap: [7000, 9000] as const,
  shuttleSlab: 2500,
  shuttleSpeed: 20,
  /** Nejmenší mezera mezi pohyblivou plošinou a hranou v krajní poloze. */
  shuttleClear: 250,
  maxCoins: 60,
} as const;

const generatorParams = z
  .object({
    difficulty: z.enum(PLATFORM_DIFFICULTIES).default('normal'),
    lengthM: z.int().min(PLATFORM_LEVEL.minLengthM).max(PLATFORM_LEVEL.maxLengthM).default(120),
    movingPlatforms: z.boolean().default(false),
    checkpoints: z.boolean().default(false),
    coins: z.boolean().default(true),
    doubleJump: z.boolean().default(false),
  })
  .strict();
export type PlatformLevelParams = z.infer<typeof generatorParams>;

const slab = (near: number, far: number, top: number): BodyInit => ({
  role: 'platform',
  kind: 'platform',
  x: 0,
  y: top - PLATFORM.slabH,
  z: (near + far) / 2,
  w: PLATFORM.slabW,
  h: PLATFORM.slabH,
  d: far - near,
  solid: true,
});

const coin = (z: number, y: number): BodyInit => ({ role: 'collectible', kind: 'coin', x: 0, y, z, w: 500, h: 500, d: 500, solid: false });

export const platformLevel: GeneratorPiece<PlatformLevelParams> = {
  id: 'platform_level',
  params: generatorParams,
  roles: ['player', 'platform', 'hazard', 'collectible', 'checkpoint', 'goal'],
  cost: (params) => {
    const slabs = Math.ceil((params.lengthM * UNIT) / (TIERS[params.difficulty].slab[0] + TIERS[params.difficulty].gap[0])) + 2;
    return { bodies: 2 + slabs * 3 + PLATFORM_LEVEL.maxCoins, rules: params.checkpoints ? 5 : 4 };
  },
  generate: (seed, params) => {
    const rng = createCompileRng(seed);
    const tier = TIERS[params.difficulty];
    const length = params.lengthM * UNIT;
    const { startSlab, finalSlab } = PLATFORM_LEVEL;

    const player: BodyInit = { role: 'player', kind: 'player', x: 0, y: PLATFORM.baseTop, z: 0, w: PLATFORM.playerW, h: PLATFORM.playerH, d: PLATFORM.playerD, solid: false };
    const slabs: BodyInit[] = [slab(-2000, startSlab - 2000, PLATFORM.baseTop)];
    const extras: BodyInit[] = [];
    const coinSpots: { readonly z: number; readonly y: number }[] = [];

    let far = startSlab - 2000;
    let top: number = PLATFORM.baseTop;
    for (let index = 1; far < length - finalSlab; index += 1) {
      const shuttle = params.movingPlatforms && index % 5 === 3;
      const rise = shuttle ? 0 : rng.int(-tier.rise, tier.rise);
      const nextTop = Math.max(PLATFORM.minTop, Math.min(PLATFORM.maxTop, top + rise));
      const dh = nextTop - top;

      if (shuttle) {
        // Pohyblivá plošina kyvadlem mezi hranami široké mezery.
        const gap = rng.int(PLATFORM_LEVEL.shuttleGap[0], PLATFORM_LEVEL.shuttleGap[1]);
        const half = PLATFORM_LEVEL.shuttleSlab / 2;
        const from = far + PLATFORM_LEVEL.shuttleClear + half;
        const period = Math.floor((gap - 2 * PLATFORM_LEVEL.shuttleClear - PLATFORM_LEVEL.shuttleSlab) / PLATFORM_LEVEL.shuttleSpeed);
        extras.push({ ...slab(from - half, from + half, top), kind: 'platform-moving', kinematic: true, vz: PLATFORM_LEVEL.shuttleSpeed, period });
        far += gap;
      } else {
        const gap = Math.min(rng.int(tier.gap[0], tier.gap[1]), maxGap(dh));
        far += gap;
      }

      const last = far + tier.slab[0] + finalSlab >= length;
      const len = last ? finalSlab : rng.int(tier.slab[0], tier.slab[1]);
      const near = far;
      far = near + len;
      top = nextTop;
      slabs.push(slab(near, far, top));
      if (last) break;

      const mid = Math.floor((near + far) / 2);
      if (index % tier.spikeEvery === 0) {
        extras.push({ role: 'hazard', kind: 'spikes', x: 0, y: top, z: mid, w: 1200, h: PLATFORM.spikeH, d: PLATFORM.spikeD, solid: false });
        // Mince nad hrotem odmění skok přes něj.
        coinSpots.push({ z: mid, y: top + 1400 });
      } else {
        for (let c = -1; c <= 1; c += 1) coinSpots.push({ z: mid + c * 1000, y: top + 300 });
      }
      if (params.checkpoints && index % 4 === 0) extras.push({ role: 'checkpoint', kind: 'checkpoint', x: 0, y: top, z: near + 800, w: 400, h: 2000, d: 400, solid: false });
    }

    const lastSlab = slabs[slabs.length - 1] as BodyInit;
    const goalZ = lastSlab.z + lastSlab.d / 2 - 1500;
    const goal: BodyInit = { role: 'goal', kind: 'finish', x: 0, y: top, z: goalZ, w: PLATFORM.slabW, h: 3 * UNIT, d: 400, solid: false };

    const bodies = [player, ...slabs, ...extras];
    if (params.coins) {
      const budget = Math.min(PLATFORM_LEVEL.maxCoins, ARCADE_LIMITS.maxBodies - bodies.length - 1);
      for (const spot of coinSpots.slice(0, Math.max(0, budget))) bodies.push(coin(spot.z, spot.y));
    }
    bodies.push(goal);
    return { bodies, length: goalZ };
  },
};

/** Pravidla plošinovky: hrot, mince, cíl, pád; s checkpointy pád vrací místo prohry. */
export function platformRules(params: Pick<PlatformLevelParams, 'checkpoints'>, health?: number): PieceRef[] {
  const rules: PieceRef[] = [
    { id: 'hit', params: { role: 'hazard', effect: health === undefined ? 'lose' : 'damage' } },
    { id: 'pickup', params: {} },
    { id: 'finish', params: {} },
    { id: 'fall_out', params: { belowY: PLATFORM.fallBelowY, effect: params.checkpoints ? 'respawn' : 'lose' } },
  ];
  if (params.checkpoints) rules.push({ id: 'checkpoint', params: {} });
  if (health !== undefined) rules.push({ id: 'out_of_health', params: {} });
  return rules;
}

// ---------------------------------------------------------------------------
// Kontrola hratelnosti

interface Span {
  readonly near: number;
  readonly far: number;
  readonly top: number;
}

/** Kam až deska sahá po trati – u pohyblivé obě krajní polohy. */
function spanOf(body: BodyInit): Span {
  const shift = body.kinematic === true ? (body.vz ?? 0) * (body.period ?? 0) : 0;
  const lo = body.z + Math.min(0, shift);
  const hi = body.z + Math.max(0, shift);
  return { near: lo - body.d / 2, far: hi + body.d / 2, top: body.y + body.h };
}

/**
 * Tvrzení „hratelné z konstrukce“ nad hotovou úrovní: vrací porušení, prázdné
 * pole = hratelná. U pohyblivé plošiny se mezera měří k její bližší krajní
 * poloze (hráč na ni počká).
 */
export function checkPlatformLevel(level: ArcadeLevel): string[] {
  const issues: string[] = [];
  const m = (units: number): string => `${(units / UNIT).toFixed(1)} m`;
  const platforms = level.bodies.filter((body) => body.role === 'platform');
  const path = platforms.map((body) => ({ body, span: spanOf(body) })).sort((a, b) => a.span.near - b.span.near);

  path.forEach(({ body, span }, index) => {
    const next = path[index + 1];
    if (next === undefined) return;
    // Z pohyblivé plošiny se skáče, když je u další hrany; na ni, když je u předchozí.
    const from = span.far;
    const to = next.span.near;
    const gap = to - from;
    const dh = next.span.top - span.top;
    if (Math.abs(dh) > PLATFORM.maxRise) issues.push(`step of ${m(dh)} at ${m(to)} is higher than a jump allows`);
    if (gap > maxGap(dh)) issues.push(`gap of ${m(gap)} at ${m(from)} is wider than a jump (${m(maxGap(dh))})`);
    if (dh > 0 && gap >= PLATFORM.playerD && riseTicks(dh) * PLATFORM.maxRun > gap - PLATFORM.playerD) issues.push(`ledge at ${m(to)} is too high to clear over a ${m(gap)} gap`);
  });

  for (const spike of level.bodies.filter((body) => body.role === 'hazard')) {
    const host = path.find(({ span }) => spike.z > span.near && spike.z < span.far && spike.y === span.top);
    if (host === undefined) {
      issues.push(`spikes at ${m(spike.z)} do not sit on a platform`);
      continue;
    }
    if (spike.h > PLATFORM_JUMP_PEAK / 2) issues.push(`spikes at ${m(spike.z)} are too tall to jump`);
    const before = spike.z - spike.d / 2 - host.span.near;
    const after = host.span.far - (spike.z + spike.d / 2);
    if (before < PLATFORM.spikeMargin || after < PLATFORM.spikeMargin) issues.push(`spikes at ${m(spike.z)} leave no room to run up or land`);
  }

  const player = level.bodies[0];
  const first = path[0];
  if (player === undefined || first === undefined || player.z <= first.span.near || player.z >= first.span.far || player.y !== first.span.top) issues.push('the player does not start on the first platform');
  const goal = level.bodies.find((body) => body.role === 'goal');
  const last = path[path.length - 1];
  if (goal === undefined || last === undefined || goal.z <= last.span.near || goal.z >= last.span.far || goal.y !== last.span.top) issues.push('no goal on the last platform');
  if (level.bodies.length > ARCADE_LIMITS.maxBodies) issues.push(`${level.bodies.length} bodies exceed the ${ARCADE_LIMITS.maxBodies} body limit`);
  return issues;
}
