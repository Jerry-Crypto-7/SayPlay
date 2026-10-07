/**
 * Střelba (P25G, T2): ovládání, zbraň, generátor střelnice a pravidla.
 *
 * Hráč stojí v počátku a dívá se po +z. Osa míří (−1000..1000 = ±45°),
 * vlevo/vpravo míření posouvá, ťuk střílí. Ovládání mění jen tělo hráče
 * (`aux0` = míření, `aux1` = spoušť v tomto tiku); střelu vydává pravidlo
 * `gun` efektem `spawn` a hlídá zásobník, rozestup ran a přebíjení v
 * čítačích `ammo` / `reserve` / `cooldown`.
 *
 * Úroveň = terče (stojí, nebo kyvadlově jezdí do strany) a vlny nepřátel,
 * kteří jdou rovně k hráči a dorazí v pevném rytmu. **Hratelné
 * z konstrukce:** každý terč je po celé své dráze v dostřelu a v úhlu
 * míření, vlny jdou od sebe aspoň o čas, za který hráč vystřílí vlnu
 * i s přebitím, a nábojů je víc než cílů. `checkShooterLevel` to samé
 * přepočítá nad hotovou úrovní.
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
  type GeneratorPiece,
  HEADER,
  HIT_GRACE,
  type PieceRef,
  type RulePiece,
  UNIT,
  bodyBase,
} from '../contract';

export const SHOOTER_DIFFICULTIES = ['easy', 'normal', 'hard'] as const;
export type ShooterDifficulty = (typeof SHOOTER_DIFFICULTIES)[number];

export const SHOOTER = {
  /** Rychlost střely (24 m/s). */
  bulletSpeed: 400,
  /** Dostřel = rychlost × život střely. */
  range: 36 * UNIT,
  /** Míření ±45°: osa 1000 = tangens 1. */
  tanMax: 1,
  /** Posun míření za tik tlačítkem vlevo/vpravo. */
  aimStep: 40,
  muzzleY: 1000,
  bulletSize: 200,
  playerW: 600,
  playerH: 1700,
  playerD: 600,
  enemyW: 800,
  enemyH: 1700,
  targetW: 1000,
  targetH: 1500,
  targetD: 200,
  /** Tiky mezi dvěma ranami. */
  fireInterval: 10,
} as const;

export const BULLET_LIFETIME = SHOOTER.range / SHOOTER.bulletSpeed;

/** Rychlost střely pro míření `aim` (−1000..1000): směr (tan, 1), délka `bulletSpeed`. */
export function aimVelocity(aim: number): { vx: number; vz: number } {
  const tan = (aim * SHOOTER.tanMax) / AXIS_MAX;
  const norm = Math.sqrt(1 + tan * tan);
  return { vx: Math.trunc((SHOOTER.bulletSpeed * tan) / norm), vz: Math.trunc(SHOOTER.bulletSpeed / norm) };
}

/** Míření na bod (x, z) před hráčem; nikdy 0, protože osa 0 = „beze změny“. */
export function aimAt(x: number, z: number): number {
  const aim = Math.round((x * AXIS_MAX) / (Math.max(1, z) * SHOOTER.tanMax));
  const clamped = Math.max(AXIS_MIN, Math.min(AXIS_MAX, aim));
  return clamped === 0 ? 1 : clamped;
}

const controlParams = z.object({}).strict();

/** Ovládání: hráč stojí, osa nastaví míření, vlevo/vpravo ho posune, ťuk = spoušť. */
export const shooterControl: ControlPiece<z.infer<typeof controlParams>> = {
  id: 'shooter',
  params: controlParams,
  roles: ['player'],
  cost: () => ({ bodies: 1, rules: 0 }),
  step: (state, player, input) => {
    const base = bodyBase(player);
    state[base + BODY.vx] = 0;
    state[base + BODY.vz] = 0;
    let aim = state[base + BODY.aux0] as number;
    if (input.axis !== 0) aim = input.axis;
    if ((input.buttons & BUTTON.LEFT) !== 0) aim -= SHOOTER.aimStep;
    if ((input.buttons & BUTTON.RIGHT) !== 0) aim += SHOOTER.aimStep;
    state[base + BODY.aux0] = Math.max(AXIS_MIN, Math.min(AXIS_MAX, aim));
    state[base + BODY.aux1] = (input.buttons & BUTTON.TAP) !== 0 ? 1 : 0;
  },
};

// ---------------------------------------------------------------------------
// Zbraň

export interface GunParams {
  readonly template: number;
  readonly magazine: number;
  readonly reloadTicks: number;
}

export interface GunState {
  readonly ammo: number;
  readonly reserve: number;
  readonly cooldown: number;
}

/**
 * Jeden tik zbraně: odpočet; když doběhne přebití, zásobník se doplní
 * z rezervy; při nule spoušť s nábojem vystřelí (i v tiku, kdy odpočet
 * doběhl, takže rány jdou přesně po `fireInterval`). Prázdný zásobník
 * s rezervou začne přebíjet. Čistá funkce – pravidlo `gun` i robot
 * počítají totéž.
 */
export function gunTick(gun: GunState, trigger: boolean, params: GunParams): { fired: boolean; next: GunState } {
  let { ammo, reserve, cooldown } = gun;
  if (cooldown > 0) {
    cooldown -= 1;
    if (cooldown === 0 && ammo === 0 && reserve > 0) {
      const load = Math.min(params.magazine, reserve);
      ammo = load;
      reserve -= load;
    }
  }
  if (cooldown > 0) return { fired: false, next: { ammo, reserve, cooldown } };
  if (trigger && ammo > 0) {
    ammo -= 1;
    return { fired: true, next: { ammo, reserve, cooldown: ammo === 0 && reserve > 0 ? params.reloadTicks : SHOOTER.fireInterval } };
  }
  if (ammo === 0 && reserve > 0) cooldown = params.reloadTicks;
  return { fired: false, next: { ammo, reserve, cooldown } };
}

export const gunOf = (state: Int32Array): GunState => ({
  ammo: state[HEADER.counters + COUNTER.ammo] as number,
  reserve: state[HEADER.counters + COUNTER.reserve] as number,
  cooldown: state[HEADER.counters + COUNTER.cooldown] as number,
});

const gunParams = z
  .object({
    template: z.int().min(0),
    magazine: z.int().min(1).max(50),
    reloadTicks: z.int().min(1).max(10 * ARCADE_HZ),
  })
  .strict();

/** Zbraň: spoušť z ovládání → střela z hráče ve směru míření, čítače zásobníku. */
export const gun: RulePiece<z.infer<typeof gunParams>> = {
  id: 'gun',
  params: gunParams,
  roles: ['player', 'projectile'],
  trigger: 'tick',
  cost: () => ({ bodies: 0, rules: 1 }),
  fire: ({ state, player }, params) => {
    const base = bodyBase(player);
    const before = gunOf(state);
    const { fired, next } = gunTick(before, state[base + BODY.aux1] === 1, params);
    const effects: ArcadeEffect[] = [];
    if (next.ammo !== before.ammo) effects.push({ kind: 'count', counter: 'ammo', amount: next.ammo - before.ammo });
    if (next.reserve !== before.reserve) effects.push({ kind: 'count', counter: 'reserve', amount: next.reserve - before.reserve });
    if (next.cooldown !== before.cooldown) effects.push({ kind: 'count', counter: 'cooldown', amount: next.cooldown - before.cooldown });
    if (fired) {
      const { vx, vz } = aimVelocity(state[base + BODY.aux0] as number);
      const z0 = (state[base + BODY.z] as number) + SHOOTER.playerD / 2;
      effects.push({ kind: 'spawn', template: params.template, x: state[base + BODY.x] as number, y: SHOOTER.muzzleY, z: z0, vx, vy: 0, vz });
    }
    return effects;
  },
};

// ---------------------------------------------------------------------------
// Generátor

interface Tier {
  readonly targets: number;
  readonly moving: number;
  readonly waves: number;
  readonly waveSize: number;
  /** Rychlost nepřítele (jednotek za tik). */
  readonly enemySpeed: number;
  /** Tik, kdy k hráči dojde první vlna, a rozestup vln (tiky). */
  readonly firstArrive: number;
  readonly interval: number;
  readonly magazine: number;
  readonly reloadS: number;
}

const TIERS: Readonly<Record<ShooterDifficulty, Tier>> = {
  easy: { targets: 3, moving: 0, waves: 2, waveSize: 2, enemySpeed: 24, firstArrive: 1200, interval: 480, magazine: 8, reloadS: 1 },
  normal: { targets: 4, moving: 2, waves: 3, waveSize: 3, enemySpeed: 30, firstArrive: 1080, interval: 420, magazine: 6, reloadS: 1.25 },
  hard: { targets: 5, moving: 3, waves: 4, waveSize: 4, enemySpeed: 36, firstArrive: 960, interval: 360, magazine: 5, reloadS: 1.5 },
};

export const SHOOTER_RANGE = {
  /** Terče stojí v tomhle pásu vzdálenosti a nejvýš v tomhle podílu úhlu míření. */
  targetNear: 12 * UNIT,
  targetFar: 26 * UNIT,
  targetSpread: 0.6,
  /** Nepřítel jde k hráči nejvýš pod tímhle podílem úhlu míření. */
  laneSpread: 0.7,
  /** Rozestup příchodu nepřátel jedné vlny. */
  memberGap: 20,
  /** Rezerva mezi vlnami navíc k vystřílení a přebití. */
  waveMargin: 60,
  /** Poslední nepřítel dorazí nejpozději tolik tiků před horizontem. */
  endMargin: 10 * ARCADE_HZ,
  /** Nejkratší čas mezi vstupem nepřítele do dostřelu a jeho příchodem. */
  minWarning: 5 * ARCADE_HZ,
} as const;

/** Meze vln žánru Střílečka (P36A T10): nejvíc nepřátel ve vlně a zrychlení za vlnu. */
export const SHOOTER_WAVE_SIZE_MAX = 6;
export const SHOOTER_RISE_MAX = 8;

const generatorParams = z
  .object({
    difficulty: z.enum(SHOOTER_DIFFICULTIES).default('normal'),
    targetWidthPct: z.int().min(25).max(100).optional(),
    /** Náboje v zásobníku; bez hodnoty podle obtížnosti. */
    magazine: z.int().min(2).max(30).optional(),
    /** Přebití v sekundách; bez hodnoty podle obtížnosti. */
    reloadS: z.number().min(0.5).max(4).optional(),
    /** Terče jezdí do strany (jen `normal` a `hard`). */
    moving: z.boolean().default(true),
    /** Počet vln; bez hodnoty podle obtížnosti. */
    waves: z.int().min(1).max(6).optional(),
    /** Přesný počet terčů a nepřátel z počtu rolí (P26D T9); bez hodnoty podle obtížnosti. */
    targets: z.int().min(1).max(8).optional(),
    enemies: z.int().min(1).max(24).optional(),
    /** Nepřátel v jedné vlně (žánr Střílečka, P36A T10); bez hodnoty podle obtížnosti. */
    waveSize: z.int().min(1).max(SHOOTER_WAVE_SIZE_MAX).optional(),
    /**
     * O kolik jednotek za tik jde každá další vlna rychleji (P36A T10): tlak
     * roste a nepřítel je v dostřelu kratší dobu. Střelnice s `rise` bere život
     * s milostí po zásahu; uložená bez něj hraje jako dřív.
     */
    rise: z.int().min(1).max(SHOOTER_RISE_MAX).optional(),
  })
  .strict();

/** Vln tolik, aby unesly daný počet nepřátel (poslední je kratší). */
const wavesOf = (params: ShooterParams, size: number): number => (params.enemies === undefined ? (params.waves ?? TIERS[params.difficulty].waves) : Math.ceil(params.enemies / size));
const waveSizeOf = (params: ShooterParams): number => params.waveSize ?? TIERS[params.difficulty].waveSize;
export type ShooterParams = z.infer<typeof generatorParams>;

/** Parametry zbraně pro úroveň (šablona střely je tělo 1). */
export function shooterGun(params: ShooterParams): GunParams {
  const tier = TIERS[params.difficulty];
  return { template: 1, magazine: params.magazine ?? tier.magazine, reloadTicks: Math.round((params.reloadS ?? tier.reloadS) * ARCADE_HZ) };
}

/** Nejkratší rozestup vln, který stihne vystřílet vlnu i s přebíjením. */
export function waveSpacing(size: number, gunParams: GunParams): number {
  return size * SHOOTER.fireInterval + Math.ceil(size / gunParams.magazine) * gunParams.reloadTicks + SHOOTER_RANGE.waveMargin;
}

const player: BodyInit = { role: 'player', kind: 'shooter', x: 0, y: 0, z: 0, w: SHOOTER.playerW, h: SHOOTER.playerH, d: SHOOTER.playerD, solid: false };
const bullet: BodyInit = { role: 'projectile', kind: 'bullet', x: 0, y: 0, z: 0, w: SHOOTER.bulletSize, h: SHOOTER.bulletSize, d: SHOOTER.bulletSize, solid: false, template: true, lifetime: BULLET_LIFETIME };

export const shooterRange: GeneratorPiece<ShooterParams> = {
  id: 'shooter_range',
  params: generatorParams,
  roles: ['player', 'projectile', 'target', 'enemy'],
  cost: (params) => {
    const tier = TIERS[params.difficulty];
    const size = waveSizeOf(params);
    return { bodies: 2 + (params.targets ?? tier.targets) + wavesOf(params, size) * size + BULLET_LIFETIME / SHOOTER.fireInterval + 2, rules: 5 };
  },
  generate: (seed, params) => {
    const rng = createCompileRng(seed);
    const tier = TIERS[params.difficulty];
    const gunParams = shooterGun(params);
    const bodies: BodyInit[] = [player, bullet];

    // Terče: každý ve svém pásu vzdálenosti, aby se nepřekrývaly.
    const targets = params.targets ?? tier.targets;
    const band = Math.floor((SHOOTER_RANGE.targetFar - SHOOTER_RANGE.targetNear) / targets);
    const moving = params.moving ? Math.min(tier.moving, targets) : 0;
    for (let i = 0; i < targets; i += 1) {
      const z = SHOOTER_RANGE.targetNear + i * band + rng.int(0, Math.floor(band / 2));
      const reach = Math.floor(SHOOTER_RANGE.targetSpread * SHOOTER.tanMax * z);
      const base = { role: 'target' as const, kind: 'target', y: 0, z, w: SHOOTER.targetW, h: SHOOTER.targetH, d: SHOOTER.targetD, solid: false };
      if (i < moving) {
        // Kyvadlo: od x0 do x0 + vx·period, celé uvnitř ±reach.
        const period = rng.int(60, 120);
        const speed = rng.int(8, 16);
        const span = speed * period;
        const x0 = rng.int(-reach, reach - span);
        const vx = rng.int(0, 1) === 0 ? speed : -speed;
        bodies.push({ ...base, x: vx > 0 ? x0 : x0 + span, vx, kinematic: true, period });
      } else bodies.push({ ...base, x: rng.int(-reach, reach) });
    }

    // Vlny: nepřítel jde po přímce k hráči a dorazí přesně v tiku `arrive`; s `rise` každá další vlna rychleji.
    const size = waveSizeOf(params);
    const interval = Math.max(tier.interval, waveSpacing(size, gunParams));
    const lastAllowed = ARCADE_LIMITS.maxTicks - SHOOTER_RANGE.endMargin;
    const maxWaves = Math.max(1, 1 + Math.floor((lastAllowed - tier.firstArrive - (size - 1) * SHOOTER_RANGE.memberGap) / interval));
    const waves = Math.min(wavesOf(params, size), maxWaves);
    for (let k = 0; k < waves; k += 1) {
      const speed = tier.enemySpeed + k * (params.rise ?? 0);
      const lane = Math.floor(SHOOTER_RANGE.laneSpread * SHOOTER.tanMax * speed);
      const lanes = rng.shuffle(Array.from({ length: size }, (_, j) => (size === 1 ? 0 : Math.round(-lane + (2 * lane * j) / (size - 1)))));
      lanes.forEach((vx, j) => {
        if (params.enemies !== undefined && k * size + j >= params.enemies) return;
        const arrive = tier.firstArrive + k * interval + j * SHOOTER_RANGE.memberGap;
        bodies.push({ role: 'enemy', kind: 'enemy', x: -vx * arrive, y: 0, z: speed * arrive, w: SHOOTER.enemyW, h: SHOOTER.enemyH, d: SHOOTER.enemyW, solid: false, vx, vz: -speed, kinematic: true });
      });
    }

    if (params.targetWidthPct !== undefined) for (let i = 2; i < bodies.length; i++) {
      const body = bodies[i]!;
      bodies[i] = { ...body, w: Math.round(body.w * params.targetWidthPct / 100) };
    }
    const foes = bodies.length - 2;
    const rounds = foes * 2 + gunParams.magazine;
    return {
      bodies,
      length: 0,
      spawnSlots: BULLET_LIFETIME / SHOOTER.fireInterval + 2,
      counters: { ammo: gunParams.magazine, reserve: rounds - gunParams.magazine },
    };
  },
};

/**
 * Pravidla střelnice: zbraň, zásah, nepřítel u hráče, vyčištěno, munice došla.
 * Střelnice žánru (s `rise`) bere život s milostí: jinak tři nepřátelé jedné
 * vlny vezmou tři životy během třetiny sekundy.
 */
export function shooterRules(params: ShooterParams, health?: number): PieceRef[] {
  const gunParams = shooterGun(params);
  const damage = params.rise === undefined ? { effect: 'damage' } : { effect: 'damage', grace: HIT_GRACE };
  const rules: PieceRef[] = [
    { id: 'gun', params: { ...gunParams } },
    { id: 'shot_hit', params: {} },
    { id: 'hit', params: { role: 'enemy', ...(health === undefined ? { effect: 'lose' } : damage) } },
    { id: 'cleared', params: {} },
    { id: 'out_of_ammo', params: {} },
  ];
  if (health !== undefined) rules.push({ id: 'out_of_health', params: {} });
  return rules;
}

/** Robot střelce se zbraní úrovně. */
export function shooterBotRef(params: ShooterParams): PieceRef {
  const { magazine, reloadTicks } = shooterGun(params);
  return { id: 'shooter_bot', params: { magazine, reloadTicks } };
}

/** Kdy nepřítel dorazí k hráči (tik), nebo null, když k němu nejde. */
export function arrivalOf(body: BodyInit): number | null {
  const vz = body.vz ?? 0;
  if (vz >= 0 || body.z % -vz !== 0) return null;
  const arrive = body.z / -vz;
  return body.x + (body.vx ?? 0) * arrive === 0 ? arrive : null;
}

/** Tvrzení „hratelné z konstrukce“ nad hotovou střelnicí; prázdné pole = hratelná. */
export function checkShooterLevel(level: ArcadeLevel, gunParams: GunParams): string[] {
  const issues: string[] = [];
  const m = (units: number): string => `${(units / UNIT).toFixed(1)} m`;
  const inCone = (x: number, z: number): boolean => z > 0 && Math.abs(x) <= SHOOTER.tanMax * z;
  const inRange = (x: number, z: number): boolean => Math.hypot(x, z) + SHOOTER.targetW <= SHOOTER.range;

  level.bodies.forEach((body, index) => {
    if (body.role !== 'target') return;
    // Kyvadlo projde obě krajní polohy; stojící terč jen svou.
    const ends = body.kinematic === true ? [body.x, body.x + (body.vx ?? 0) * (body.period ?? 0)] : [body.x];
    for (const x of ends) {
      if (!inRange(x, body.z)) issues.push(`target ${index} at ${m(Math.hypot(x, body.z))} is out of range (${m(SHOOTER.range)})`);
      else if (!inCone(x, body.z)) issues.push(`target ${index} at ${m(x)} to the side is outside the aim cone`);
    }
    if (body.kinematic === true && (body.period ?? 0) === 0 && (body.vx ?? 0) !== 0) issues.push(`target ${index} drifts away and never comes back`);
  });

  const arrivals: number[] = [];
  level.bodies.forEach((body, index) => {
    if (body.role !== 'enemy') return;
    const arrive = arrivalOf(body);
    if (arrive === null) {
      issues.push(`enemy ${index} does not walk straight at the player`);
      return;
    }
    if (Math.abs(body.vx ?? 0) > SHOOTER.tanMax * -(body.vz ?? 0)) issues.push(`enemy ${index} comes from outside the aim cone`);
    const warning = Math.floor(Math.min(SHOOTER.range, body.z) / -(body.vz ?? 1));
    if (warning < SHOOTER_RANGE.minWarning) issues.push(`enemy ${index} is in range only ${(warning / ARCADE_HZ).toFixed(1)} s before it arrives`);
    if (arrive > ARCADE_LIMITS.maxTicks - SHOOTER_RANGE.endMargin) issues.push(`enemy ${index} arrives at ${(arrive / ARCADE_HZ).toFixed(0)} s – too late to finish`);
    arrivals.push(arrive);
  });

  // Vlna = nepřátelé, kteří dorazí do `memberGap` jeden po druhém.
  arrivals.sort((a, b) => a - b);
  const waves: { start: number; size: number }[] = [];
  for (const arrive of arrivals) {
    const last = waves[waves.length - 1];
    if (last !== undefined && arrive - (last.start + (last.size - 1) * SHOOTER_RANGE.memberGap) <= SHOOTER_RANGE.memberGap) last.size += 1;
    else waves.push({ start: arrive, size: 1 });
  }
  waves.forEach((wave, index) => {
    const prev = waves[index - 1];
    if (prev !== undefined && wave.start - prev.start < waveSpacing(prev.size, gunParams)) {
      issues.push(`wave ${index + 1} arrives ${((wave.start - prev.start) / ARCADE_HZ).toFixed(1)} s after the last – no time to shoot it and reload`);
    }
  });

  const foes = level.bodies.filter((body) => body.role === 'target' || body.role === 'enemy').length;
  const rounds = (level.counters?.ammo ?? 0) + (level.counters?.reserve ?? 0);
  if (foes === 0) issues.push('nothing to shoot');
  if (rounds < foes) issues.push(`${rounds} rounds for ${foes} targets`);
  if (!level.bodies.some((body) => body.role === 'enemy')) issues.push('no enemy wave – a player who does nothing would never lose');
  const capacity = level.bodies.length + (level.spawnSlots ?? 0);
  if (capacity > ARCADE_LIMITS.maxBodies) issues.push(`${capacity} bodies exceed the ${ARCADE_LIMITS.maxBodies} body limit`);
  return issues;
}
