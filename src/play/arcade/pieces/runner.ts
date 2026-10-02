/**
 * Běžec (P25A, T3): ovládání a generátor trati.
 *
 * Postava běží sama po +z, ťuk/nahoru = skok, vlevo/vpravo = pruh (3 pruhy),
 * dolů = skluz (nižší obrys). Generátor staví trať po řadách překážek a zná
 * konstanty ovládání, takže úroveň je **hratelná z konstrukce**: řady jsou od
 * sebe aspoň na dopad skoku, reakci a přesun o dva pruhy, a žádná řada nemá
 * všechny tři pruhy zablokované překážkou, kterou nejde přeskočit ani
 * podklouznout. `checkRunnerLevel` to samé tvrzení přepočítá nad hotovou
 * úrovní – test i ověření ho čtou.
 *
 * S `feel: 2` (P36A T6, výchozí v žánru Běžec) skok odpouští jako skákačka:
 * ještě 100 ms po sběhnutí z hrany a stisk až 120 ms před dopadem skočí při
 * dopadu. Ťuk ze země skočí přesně jako dřív, takže odstupy řad platí dál.
 */

import { z } from 'zod';

import { createCompileRng } from '@/play/compile/rng';

import { ARCADE_LIMITS, type ArcadeLevel, BODY, BUTTON, type BodyInit, type ControlPiece, FLAG, type GeneratorPiece, UNIT, bodyBase, rampMarks, rampedSpeed } from '../contract';
import { GRAVITY } from '../kernel';
import { PLATFORM_FEEL } from './platform';

export const RUNNER_SPEEDS = ['slow', 'normal', 'fast'] as const;
export const RUNNER_DENSITIES = ['low', 'normal', 'high'] as const;
export const OBSTACLE_KINDS = ['hurdle', 'slide-bar', 'cone', 'crate'] as const;
export type RunnerSpeed = (typeof RUNNER_SPEEDS)[number];
export type RunnerDensity = (typeof RUNNER_DENSITIES)[number];
export type ObstacleKind = (typeof OBSTACLE_KINDS)[number];

/** Rychlost běhu v jednotkách za tik (7, 9, 11 m/s). */
export const SPEED: Readonly<Record<RunnerSpeed, number>> = { slow: 117, normal: 150, fast: 183 };

export const RUNNER = {
  lanes: 3,
  laneWidth: 2 * UNIT,
  /** Boční rychlost při změně pruhu – pruh za 8 tiků. */
  laneSpeed: 250,
  jumpVy: 150,
  slideTicks: 40,
  runH: 1600,
  slideH: 700,
  playerW: 600,
  playerD: 500,
} as const;

/** Tiků ve vzduchu po skoku z rovné země (stoupání + pád). */
export const JUMP_AIR_TICKS = Math.floor((2 * RUNNER.jumpVy) / GRAVITY);
/** Nejvyšší výška spodní stěny hráče při skoku. */
export const JUMP_PEAK = (() => {
  let y = 0;
  let vy = RUNNER.jumpVy;
  let peak = 0;
  for (let t = 0; t < JUMP_AIR_TICKS; t += 1) {
    vy -= GRAVITY;
    y += vy;
    peak = Math.max(peak, y);
  }
  return peak;
})();

/** Jak se překážka míjí: přeskočit, podklouznout, nebo jen jiným pruhem. */
export type PassBy = 'jump' | 'slide' | 'lane';

export interface ObstacleShape {
  readonly passBy: PassBy;
  /** Spodní stěna nad zemí. */
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly d: number;
  readonly solid: boolean;
}

export const OBSTACLES: Readonly<Record<ObstacleKind, ObstacleShape>> = {
  hurdle: { passBy: 'jump', y: 0, w: 1600, h: 600, d: 300, solid: true },
  'slide-bar': { passBy: 'slide', y: 1000, w: 1600, h: 400, d: 300, solid: false },
  cone: { passBy: 'lane', y: 0, w: 900, h: 1500, d: 700, solid: true },
  crate: { passBy: 'lane', y: 0, w: 1400, h: 1500, d: 1400, solid: true },
};

const aux = (state: Int32Array, base: number, slot: 'aux0' | 'aux1'): number => state[base + BODY[slot]] as number;

/**
 * Odpuštění skoku `feel: 2` (P36A T6) v `aux1` nad tiky skluzu: bity 0–5 skluz
 * (nejvýš `slideTicks` 40), 6–8 zbývající coyote tiky, 9–12 zbývající tiky bufferu.
 */
const SLIDE_MASK = 0x3f;
const COYOTE_SHIFT = 6;
const BUFFER_SHIFT = 9;

const controlParams = z
  .object({
    speed: z.enum(RUNNER_SPEEDS).default('normal'),
    /** Značky rampy (`rampMarks`); bez nich stálá rychlost. */
    ramp: z.tuple([z.int(), z.int()]).optional(),
    /**
     * Odpuštění skoku jako skákačka (P36A T6): coyote 100 ms, buffer 120 ms
     * (`PLATFORM_FEEL`). Bez něj skok jen ze země v tiku stisku – uložený svět beze změny.
     */
    feel: z.literal(2).optional(),
  })
  .strict();

/** Ovládání běžce. `aux0` = cílový pruh (−1, 0, 1), `aux1` = zbývající tiky skluzu (s `feel: 2` i okna skoku). */
export const runnerControl: ControlPiece<z.infer<typeof controlParams>> = {
  id: 'runner',
  params: controlParams,
  roles: ['player'],
  cost: () => ({ bodies: 1, rules: 0 }),
  step: (state, player, input, params) => {
    const base = bodyBase(player);
    const flags = state[base + BODY.flags] as number;
    const grounded = (flags & FLAG.grounded) !== 0;
    state[base + BODY.vz] = rampedSpeed(SPEED[params.speed], state[base + BODY.z] as number, params.ramp);

    let lane = aux(state, base, 'aux0');
    if ((input.buttons & BUTTON.LEFT) !== 0) lane = Math.max(-1, lane - 1);
    if ((input.buttons & BUTTON.RIGHT) !== 0) lane = Math.min(1, lane + 1);
    state[base + BODY.aux0] = lane;
    const dx = lane * RUNNER.laneWidth - (state[base + BODY.x] as number);
    state[base + BODY.vx] = Math.max(-RUNNER.laneSpeed, Math.min(RUNNER.laneSpeed, dx));

    const feel = params.feel === 2;
    const packed = aux(state, base, 'aux1');
    const pressed = (input.buttons & (BUTTON.TAP | BUTTON.UP)) !== 0;
    let slide = feel ? packed & SLIDE_MASK : packed;
    // Coyote se na zemi dobije; ve vzduchu dobíhá. Stisk platí v tiku stisku a dalších `bufferTicks`.
    let coyote = !feel ? 0 : grounded ? PLATFORM_FEEL.coyoteTicks : (packed >> COYOTE_SHIFT) & 0x7;
    let buffer = !feel ? 0 : pressed ? PLATFORM_FEEL.bufferTicks + 1 : (packed >> BUFFER_SHIFT) & 0xf;
    if (feel ? buffer > 0 && (grounded || coyote > 0) : pressed && grounded) {
      state[base + BODY.vy] = RUNNER.jumpVy;
      slide = 0;
      coyote = 0;
      buffer = 0;
    } else if ((input.buttons & (BUTTON.DOWN | BUTTON.HOLD)) !== 0) {
      slide = RUNNER.slideTicks;
      // Ve vzduchu dolů = rychlý pád, skluz pokračuje po dopadu. Skluz přebije skok, který čekal na dopad.
      if (!grounded) state[base + BODY.vy] = Math.min(state[base + BODY.vy] as number, -RUNNER.jumpVy);
      buffer = 0;
    } else if (slide > 0) {
      slide -= 1;
    }
    if (buffer > 0) buffer -= 1;
    if (!grounded && coyote > 0) coyote -= 1;
    state[base + BODY.aux1] = feel ? slide | (coyote << COYOTE_SHIFT) | (buffer << BUFFER_SHIFT) : slide;
    state[base + BODY.h] = slide > 0 ? RUNNER.slideH : RUNNER.runH;
    state[base + BODY.flags] = slide > 0 ? (state[base + BODY.flags] as number) | FLAG.sliding : (state[base + BODY.flags] as number) & ~FLAG.sliding;
  },
};

// ---------------------------------------------------------------------------
// Generátor

export const RUNNER_TRACK = {
  /** Volný rozběh před první řadou. */
  startClear: 25 * UNIT,
  /** Volno před páskou. */
  endClear: 15 * UNIT,
  minLengthM: 60,
  maxLengthM: 500,
  /** Nejkratší odstup řad v ticích běhu: dopad skoku + reakce 8 tiků + přesun o dva pruhy + rezerva. */
  minGapTicks: 60,
  maxCoins: 60,
} as const;

/** Odstup řad v ticích běhu podle hustoty (plus náhodných 0–20). */
const GAP_TICKS: Readonly<Record<RunnerDensity, number>> = { low: 110, normal: 80, high: 60 };
/** Kolik pruhů řada obsadí: [min, max]. */
const ROW_LANES: Readonly<Record<RunnerDensity, readonly [number, number]>> = { low: [1, 1], normal: [1, 2], high: [2, 3] };

const generatorParams = z
  .object({
    speed: z.enum(RUNNER_SPEEDS).default('normal'),
    density: z.enum(RUNNER_DENSITIES).default('normal'),
    lengthM: z.int().min(RUNNER_TRACK.minLengthM).max(RUNNER_TRACK.maxLengthM).default(250),
    obstacles: z.array(z.enum(OBSTACLE_KINDS)).min(1).max(OBSTACLE_KINDS.length).default([...OBSTACLE_KINDS]),
    coins: z.boolean().default(true),
    /** Přesný počet mincí a řad překážek z počtu rolí (P26D T9); bez hodnoty podle hustoty. */
    coinCount: z.int().min(1).max(RUNNER_TRACK.maxCoins).optional(),
    rows: z.int().min(1).max(60).optional(),
    /** Odpuštění skoku pro ovládání (P36A T6); jen se předá ovládání, trať nemění. */
    feel: z.literal(2).optional(),
  })
  .strict();
export type RunnerTrackParams = z.infer<typeof generatorParams>;

const laneX = (lane: number): number => lane * RUNNER.laneWidth;

function obstacleBody(kind: ObstacleKind, lane: number, z: number): BodyInit {
  const shape = OBSTACLES[kind];
  return { role: 'obstacle', kind, x: laneX(lane), y: shape.y, z, w: shape.w, h: shape.h, d: shape.d, solid: shape.solid };
}

export const runnerTrack: GeneratorPiece<RunnerTrackParams> = {
  id: 'runner_track',
  params: generatorParams,
  roles: ['player', 'obstacle', 'collectible', 'goal'],
  cost: (params) => ({ bodies: 2 + Math.ceil((params.lengthM * UNIT) / (RUNNER_TRACK.minGapTicks * SPEED[params.speed])) * 3 + RUNNER_TRACK.maxCoins, rules: 3 }),
  generate: (seed, params) => {
    const rng = createCompileRng(seed);
    const length = params.lengthM * UNIT;
    const speed = SPEED[params.speed];
    // Odstup řad drží reakční čas i za značkami rampy, kde běh zrychlí.
    const ramp = rampMarks(length);
    const bodies: BodyInit[] = [
      { role: 'player', kind: 'player', x: 0, y: 0, z: 0, w: RUNNER.playerW, h: RUNNER.runH, d: RUNNER.playerD, solid: false },
    ];
    const lanes = [-1, 0, 1] as const;
    const passable = params.obstacles.filter((kind) => OBSTACLES[kind].passBy !== 'lane');
    const rows: number[] = [];
    const [minLanes, maxLanes] = ROW_LANES[params.density];
    const maxRows = Math.min(params.rows ?? Infinity, Math.ceil(length / (RUNNER_TRACK.minGapTicks * speed)));
    // Daný počet řad se rozloží po celé trati, nenahrne se na začátek.
    const spread = params.rows === undefined ? null : Math.max(RUNNER_TRACK.minGapTicks * speed, Math.floor((length - RUNNER_TRACK.startClear - RUNNER_TRACK.endClear) / params.rows));

    let z = RUNNER_TRACK.startClear;
    for (let row = 0; row < maxRows && z <= length - RUNNER_TRACK.endClear; row += 1) {
      // Bez přeskočitelné překážky smí řada obsadit nejvýš dva pruhy.
      const cap = passable.length > 0 ? maxLanes : Math.min(maxLanes, RUNNER.lanes - 1);
      const taken = rng.shuffle(lanes).slice(0, rng.int(Math.min(minLanes, cap), cap));
      // První řada vždy stojí i ve startovním pruhu: nečinný hráč nesmí trať proběhnout.
      if (row === 0 && !taken.includes(0)) taken[0] = 0;
      const kinds = taken.map(() => rng.pick(params.obstacles));
      // Tři pruhy s obstrukcí „jen pruhem“ by řadu zavřely: jeden pruh dostane přeskočitelnou.
      if (kinds.length === RUNNER.lanes && kinds.every((kind) => OBSTACLES[kind].passBy === 'lane')) kinds[0] = rng.pick(passable);
      taken.forEach((lane, index) => bodies.push(obstacleBody(kinds[index] as ObstacleKind, lane, z)));
      rows.push(z);
      z += Math.max(RUNNER_TRACK.minGapTicks * rampedSpeed(speed, z, ramp), spread ?? (GAP_TICKS[params.density] + rng.int(0, 20)) * speed);
    }

    if (params.coins) {
      // Mince uprostřed mezi řadami, 3 za sebou v náhodném pruhu – daleko od překážek.
      // Strop mincí drží celý svět pod `maxBodies` i s páskou.
      const budget = Math.min(params.coinCount ?? RUNNER_TRACK.maxCoins, ARCADE_LIMITS.maxBodies - bodies.length - 1);
      let coins = 0;
      for (let i = 0; i < rows.length && coins < budget; i += 1) {
        const from = rows[i] as number;
        const to = rows[i + 1] ?? length;
        const lane = rng.pick(lanes);
        const mid = Math.floor((from + to) / 2);
        for (let c = -1; c <= 1 && coins < budget; c += 1) {
          bodies.push({ role: 'collectible', kind: 'coin', x: laneX(lane), y: 300, z: mid + c * 1500, w: 500, h: 500, d: 500, solid: false });
          coins += 1;
        }
      }
    }

    bodies.push({ role: 'goal', kind: 'finish', x: 0, y: 0, z: length, w: RUNNER.lanes * RUNNER.laneWidth + 2 * UNIT, h: 3 * UNIT, d: 400, solid: false });
    return { bodies, length };
  },
};

/**
 * Tvrzení „hratelné z konstrukce“ nad hotovou úrovní: vrací porušení, prázdné
 * pole = hratelná. Řada = překážky se stejným `z`.
 */
export function checkRunnerLevel(level: ArcadeLevel, speed: RunnerSpeed, ramp: readonly number[] | undefined = rampMarks(level.length)): string[] {
  const issues: string[] = [];
  const rows = new Map<number, BodyInit[]>();
  for (const body of level.bodies) {
    if (body.role !== 'obstacle') continue;
    rows.set(body.z, [...(rows.get(body.z) ?? []), body]);
  }
  const zs = [...rows.keys()].sort((a, b) => a - b);
  zs.forEach((z, index) => {
    const minGap = RUNNER_TRACK.minGapTicks * rampedSpeed(SPEED[speed], z, ramp);
    const row = rows.get(z) as BodyInit[];
    const closed = row.length >= RUNNER.lanes && row.every((body) => OBSTACLES[body.kind as ObstacleKind]?.passBy === 'lane');
    if (closed) issues.push(`row at ${z / UNIT} m blocks all ${RUNNER.lanes} lanes with obstacles that cannot be jumped or slid under`);
    if (index === 0 && z < RUNNER_TRACK.startClear) issues.push(`first row at ${z / UNIT} m leaves no run-up`);
    const next = zs[index + 1];
    if (next !== undefined && next - z < minGap) issues.push(`rows at ${z / UNIT} m and ${next / UNIT} m are closer than ${minGap / UNIT} m`);
  });
  if (!level.bodies.some((body) => body.role === 'goal' && body.z === level.length)) issues.push('no finish line at the end of the track');
  if (level.bodies.length > ARCADE_LIMITS.maxBodies) issues.push(`${level.bodies.length} bodies exceed the ${ARCADE_LIMITS.maxBodies} body limit`);
  return issues;
}

