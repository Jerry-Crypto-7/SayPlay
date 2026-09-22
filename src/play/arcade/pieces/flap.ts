/**
 * Poletování (P25C, T4): ovládání, generátor trati s trubkami a pravidla.
 *
 * Boční pohled po +z jako plošinovka. Hráč letí sám vpřed stálou rychlostí,
 * gravitace jádra ho táhne dolů a ťuk nastaví rychlost vzhůru (vzlet).
 * Trať = dvojice trubek (dole a nahoře) s mezerou, v mezeře neviditelná
 * branka (průlet = bod), mezi trubkami mince, na konci cíl, nad vším strop.
 * **Hratelné z konstrukce:** mezera je o vzlet a rezervu vyšší než hráč
 * a sousední mezery se výškou liší nejvýš o to, co hráč mezi trubkami
 * stihne vystoupat. `checkFlapLevel` to samé přepočítá nad hotovou tratí.
 */

import { z } from 'zod';

import { createCompileRng } from '@/play/compile/rng';

import { ARCADE_LIMITS, type ArcadeLevel, BODY, BUTTON, type BodyInit, type ControlPiece, type GeneratorPiece, type PieceRef, UNIT, bodyBase } from '../contract';
import { GRAVITY } from '../kernel';

export const FLAP_DIFFICULTIES = ['easy', 'normal', 'hard'] as const;
export type FlapDifficulty = (typeof FLAP_DIFFICULTIES)[number];

export const FLAP = {
  /** Let vpřed (5,4 m/s). */
  speed: 90,
  flapVy: 110,
  size: 800,
  /** Strop letu: spodní stěna stropu. */
  ceiling: 10_000,
  startY: 4000,
  pipeD: 1200,
  pipeW: 1600,
  /** Nejnižší spodní hrana mezery a nejmenší odstup horní hrany od stropu. */
  minPipe: 1500,
  /** Kolik smí trať ze stoupání hráče mezi trubkami využít (jednotek výšky na jednotku délky). */
  climbPerUnit: 0.3,
} as const;

/** Výstup jednoho vzletu z klidu (vrchol nad místem ťuku). */
export const FLAP_RISE = (() => {
  let vy = FLAP.flapVy;
  let y = 0;
  let peak = 0;
  while (vy > 0) {
    vy -= GRAVITY;
    y += vy;
    peak = Math.max(peak, y);
  }
  return peak;
})();

const controlParams = z.object({}).strict();

/** Ovládání: stálý let vpřed, ťuk/nahoru = vzlet. */
export const flapControl: ControlPiece<z.infer<typeof controlParams>> = {
  id: 'flap',
  params: controlParams,
  roles: ['player'],
  cost: () => ({ bodies: 1, rules: 0 }),
  step: (state, player, input) => {
    const base = bodyBase(player);
    state[base + BODY.vz] = FLAP.speed;
    state[base + BODY.vx] = 0;
    if ((input.buttons & (BUTTON.TAP | BUTTON.UP)) !== 0) state[base + BODY.vy] = FLAP.flapVy;
  },
};

// ---------------------------------------------------------------------------
// Generátor

interface Tier {
  /** Výška mezery (celá, včetně hráče). */
  readonly gap: number;
  readonly spacing: readonly [number, number];
  readonly shift: number;
}

const TIERS: Readonly<Record<FlapDifficulty, Tier>> = {
  easy: { gap: 3200, spacing: [5500, 6500], shift: 700 },
  normal: { gap: 2800, spacing: [4600, 5400], shift: 1000 },
  hard: { gap: 2400, spacing: [4000, 4600], shift: 1200 },
};

export const FLAP_TRACK = {
  minLengthM: 60,
  maxLengthM: 250,
  startClear: 15 * UNIT,
  endClear: 8 * UNIT,
  maxCoins: 40,
} as const;

const generatorParams = z
  .object({
    difficulty: z.enum(FLAP_DIFFICULTIES).default('normal'),
    lengthM: z.int().min(FLAP_TRACK.minLengthM).max(FLAP_TRACK.maxLengthM).default(150),
    coins: z.boolean().default(true),
  })
  .strict();
export type FlapTrackParams = z.infer<typeof generatorParams>;

const pipe = (z: number, bottom: number, top: number): BodyInit => ({ role: 'obstacle', kind: 'pipe', x: 0, y: bottom, z, w: FLAP.pipeW, h: top - bottom, d: FLAP.pipeD, solid: false });

export const flapTrack: GeneratorPiece<FlapTrackParams> = {
  id: 'flap_track',
  params: generatorParams,
  roles: ['player', 'obstacle', 'collectible', 'platform', 'goal'],
  cost: (params) => ({ bodies: 3 + Math.ceil((params.lengthM * UNIT) / TIERS[params.difficulty].spacing[0]) * 3 + FLAP_TRACK.maxCoins, rules: 4 }),
  generate: (seed, params) => {
    const rng = createCompileRng(seed);
    const tier = TIERS[params.difficulty];
    const length = params.lengthM * UNIT;
    const lowest = FLAP.minPipe;
    const highest = FLAP.ceiling - FLAP.minPipe - tier.gap;

    const bodies: BodyInit[] = [
      { role: 'player', kind: 'bird', x: 0, y: FLAP.startY, z: 0, w: FLAP.size, h: FLAP.size, d: FLAP.size, solid: false },
      // Strop přes celou trať: přes trubky se přeletět nedá.
      { role: 'platform', kind: 'ceiling', x: 0, y: FLAP.ceiling, z: length / 2, w: FLAP.pipeW, h: 500, d: length + 20 * UNIT, solid: true },
    ];
    const coinSpots: { z: number; y: number }[] = [];
    let bottom = Math.max(lowest, Math.min(highest, FLAP.startY - tier.gap / 2 + rng.int(-300, 300)));
    let z = FLAP_TRACK.startClear;
    let prev: { z: number; bottom: number } | null = null;
    while (z <= length - FLAP_TRACK.endClear) {
      bodies.push(pipe(z, 0, bottom), pipe(z, bottom + tier.gap, FLAP.ceiling));
      // Branka v mezeře: průlet = bod.
      bodies.push({ role: 'collectible', kind: 'gate', x: 0, y: bottom, z, w: FLAP.pipeW, h: tier.gap, d: 200, solid: false });
      if (prev !== null) coinSpots.push({ z: Math.floor((prev.z + z) / 2), y: Math.floor((prev.bottom + bottom + tier.gap - FLAP.size) / 2) });
      prev = { z, bottom };
      const spacing = rng.int(tier.spacing[0], tier.spacing[1]);
      const reach = Math.min(tier.shift, Math.floor(FLAP.climbPerUnit * spacing));
      bottom = Math.max(lowest, Math.min(highest, bottom + rng.int(-reach, reach)));
      z += spacing;
    }
    if (params.coins) {
      const budget = Math.min(FLAP_TRACK.maxCoins, ARCADE_LIMITS.maxBodies - bodies.length - 1);
      for (const spot of coinSpots.slice(0, Math.max(0, budget))) bodies.push({ role: 'collectible', kind: 'coin', x: 0, y: spot.y, z: spot.z, w: 500, h: 500, d: 500, solid: false });
    }
    bodies.push({ role: 'goal', kind: 'finish', x: 0, y: 0, z: length, w: FLAP.pipeW, h: FLAP.ceiling, d: 400, solid: false });
    return { bodies, length };
  },
};

/** Pravidla poletování: trubka, branka/mince, cíl, dotek země. */
export function flapRules(health?: number): PieceRef[] {
  const rules: PieceRef[] = [
    { id: 'hit', params: { role: 'obstacle', effect: health === undefined ? 'lose' : 'damage' } },
    { id: 'pickup', params: {} },
    { id: 'finish', params: {} },
    // Země drží hráče na y = 0: dotek země = spodní stěna pod 1.
    { id: 'fall_out', params: { belowY: 1, effect: 'lose' } },
  ];
  if (health !== undefined) rules.push({ id: 'out_of_health', params: {} });
  return rules;
}

/** Mezery trati podle z: spodní a horní hrana (z dvojice trubek se stejným z). */
export function flapGaps(level: ArcadeLevel): { z: number; bottom: number; top: number }[] {
  const byZ = new Map<number, BodyInit[]>();
  for (const body of level.bodies) if (body.role === 'obstacle') byZ.set(body.z, [...(byZ.get(body.z) ?? []), body]);
  return [...byZ.entries()]
    .sort(([a], [b]) => a - b)
    .map(([z, pipes]) => {
      const low = pipes.filter((p) => p.y === 0);
      const high = pipes.filter((p) => p.y > 0);
      return { z, bottom: Math.max(0, ...low.map((p) => p.h)), top: Math.min(FLAP.ceiling, ...high.map((p) => p.y)) };
    });
}

/** Tvrzení „hratelné z konstrukce“ nad hotovou tratí; prázdné pole = hratelná. */
export function checkFlapLevel(level: ArcadeLevel): string[] {
  const issues: string[] = [];
  const m = (units: number): string => `${(units / UNIT).toFixed(1)} m`;
  const gaps = flapGaps(level);
  gaps.forEach((gap, index) => {
    if (gap.top - gap.bottom < FLAP.size + FLAP_RISE + 600) issues.push(`gap at ${m(gap.z)} is ${m(gap.top - gap.bottom)} high – too tight to fly through`);
    const prev = gaps[index - 1];
    if (prev !== undefined && Math.abs(gap.bottom - prev.bottom) > FLAP.climbPerUnit * (gap.z - prev.z)) issues.push(`gap at ${m(gap.z)} moves ${m(gap.bottom - prev.bottom)} over ${m(gap.z - prev.z)} – too far to follow`);
    if (index === 0 && gap.z < FLAP_TRACK.startClear) issues.push(`first pipes at ${m(gap.z)} leave no run-in`);
  });
  if (!level.bodies.some((body) => body.role === 'goal' && body.z === level.length)) issues.push('no finish at the end of the track');
  if (level.bodies.length > ARCADE_LIMITS.maxBodies) issues.push(`${level.bodies.length} bodies exceed the ${ARCADE_LIMITS.maxBodies} body limit`);
  return issues;
}
