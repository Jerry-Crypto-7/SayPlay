/**
 * Řízení (P25F, T2): ovládání vozidla, generátor trati se zatáčkami a pravidla.
 *
 * Pohled za vozidlem: trať běží po +z, `x` je do stran (vpravo = +x, scéna
 * ho zrcadlí jako u běžce). Plyn je automatický, osa (tah, šipky, náklon)
 * řídí boční rychlost se setrvačností a bez vstupu boční rychlost dojíždí
 * podle přilnavosti – s `drift` pomalu (smyk). Dolů = brzda. Sebrané turbo
 * na chvíli zvedne nejvyšší rychlost.
 *
 * Trať je z dílků: rovinky a zatáčky z krátkých úseků, každý úsek zatáčky je
 * posunutý do strany proti předchozímu. Mantinely jsou pevná tělesa (boční
 * kolize jádra v2), náraz zastaví. Každá zatáčka posune trať o víc než její
 * šířku, takže kdo neřídí, narazí. **Hratelné z konstrukce:** posun úseku je
 * menší než boční dosah vozidla na délce předchozího úseku při nejvyšší
 * rychlosti (s turbem, zpožděním reakce a nejhorší přilnavostí) a průjezd
 * mezi úseky je širší než vozidlo s rezervou. `checkSteerLevel` to samé
 * přepočítá nad hotovou tratí.
 *
 * Soupeři jsou kinematická tělesa: vpřed jedou stálou rychlostí a po trati
 * je vede ovládání – jádro jiné místo pro pohyb cizích těl nemá (Findings
 * P25F). Kdo z nich projede cílem dřív než hráč, vyhrál: `rival_finish`.
 *
 * Plavba (P32F T1) jede na týchž kusech, protože knihovna se nemění: závod
 * `voyage_race` je trať mezi ostrovy s branami, dělovými koulemi a pokladem
 * v cíli; přistání `voyage_land` přepne ovládání parametrem `land` na tah a
 * náklon a `rival_finish` s parametrem `land` soudí dotyk. Světy bez nových
 * polí jedou jako dřív a jejich hash se nepohne.
 */

import { z } from 'zod';

import { createCompileRng } from '@/play/compile/rng';

import {
  ARCADE_HZ,
  ARCADE_LIMITS,
  type ArcadeInput,
  type ArcadeLevel,
  AXIS_MAX,
  BODY,
  BUTTON,
  type BodyInit,
  COUNTER,
  type ControlPiece,
  FLAG,
  type GeneratorPiece,
  HEADER,
  HIT_GRACE,
  type ModeGeneratorPiece,
  type PieceRef,
  ROLE,
  type RulePiece,
  UNIT,
  bodyBase,
  rampMarks,
  rampedSpeed,
} from '../contract';
import { GRAVITY } from '../kernel';

export const STEER_DIFFICULTIES = ['easy', 'normal', 'hard'] as const;
export type SteerDifficulty = (typeof STEER_DIFFICULTIES)[number];

export const STEER = {
  /** Nejvyšší rychlost vpřed (18 m/s). */
  topSpeed: 300,
  accel: 4,
  brake: 12,
  /** Nejvyšší boční rychlost a její změna za tik při plném vychýlení osy. */
  latMax: 160,
  steerRate: 16,
  /** Dojezd boční rychlosti bez vstupu: běžně a se smykem (`drift`). */
  grip: 10,
  driftGrip: 4,
  /** Turbo: o kolik a na kolik tiků zvedne nejvyšší rychlost. */
  boost: 60,
  boostTicks: 120,
  carW: 1000,
  carH: 800,
  carD: 1800,
  /** Mantinel: tloušťka je větší než největší posun úseku, jinak by roh pustil hráče ven z trati. */
  wallW: 2500,
  wallH: 800,
  /** Zpoždění reakce, se kterým počítá hratelnost (= robot). */
  reactionTicks: 8,
  /** Rezerva mezi vozidlem a mantinelem v každém průjezdu. */
  clearance: 400,
  /** Soupeř míří na střed trati tolik před sebou a do strany jede nejvýš takhle rychle. */
  rivalLook: 6000,
  rivalLat: 100,
} as const;

export const STEER_TRACK = {
  minLengthM: 200,
  maxLengthM: 800,
  /** Délka úseku zatáčky. */
  segment: 10 * UNIT,
  /** Trať začíná za startem a rovinkou na rozjezd. */
  startBack: 20 * UNIT,
  runIn: 40 * UNIT,
  /** Za cílem trať pokračuje. */
  runOut: 30 * UNIT,
  /** Nejmenší rovinka před cílem. */
  finalStraight: 30 * UNIT,
  /** Střed trati se od osy vzdálí nejvýš o tolik. */
  maxCenter: 15 * UNIT,
  maxTurbos: 12,
  /** Soupeř dojede nejdřív za tolikanásobek ideálního času hráče. */
  rivalMargin: 1.3,
} as const;

interface Tier {
  readonly width: number;
  readonly straight: readonly [number, number];
  readonly shift: readonly [number, number];
  readonly rivals: number;
  /** Rychlost soupeřů v procentech `topSpeed`. */
  readonly rivalPct: number;
}

const TIERS: Readonly<Record<SteerDifficulty, Tier>> = {
  easy: { width: 11_000, straight: [50_000, 80_000], shift: [1300, 1700], rivals: 2, rivalPct: 60 },
  normal: { width: 10_000, straight: [30_000, 55_000], shift: [1500, 1800], rivals: 3, rivalPct: 64 },
  hard: { width: 9000, straight: [15_000, 30_000], shift: [1600, 1900], rivals: 4, rivalPct: 68 },
};

const toward = (value: number, target: number, step: number): number => (value < target ? Math.min(target, value + step) : Math.max(target, value - step));

/** Závod plavby (P32F T1): trať závodu, břehy místo pneumatik, brány, střely a poklad v cíli. */
export const VOYAGE = {
  lives: 3,
  lengthM: { min: 200, max: 800, default: 350 },
  topSpeed: { min: 200, max: 360, default: 260 },
  /** Brána stojí kus za začátkem rovinky (uvnitř úseku, ne na jeho hraně). */
  gateInset: UNIT,
  gateD: 400,
  gateH: 4 * UNIT,
  /** Překážky na rovince: od začátku, před koncem (u poslední před cílem) a mezi sebou. */
  hazardFrom: 8 * UNIT,
  hazardBeforeEnd: 15 * UNIT,
  hazardGap: 20 * UNIT,
  /** Dělová koule: krychle hitboxu a rychlost přes kanál (jednotky za tik) podle obtížnosti. */
  shot: 1000,
  shotSpeed: { easy: 45, normal: 55, hard: 70 },
  /** Koule se otáčí tolik před břehem. */
  shotBank: 200,
  /** Stojící překážka (útes, vrak): 2 m, do čtvrtiny šířky od osy. */
  snag: 2 * UNIT,
  snagH: UNIT,
  /** Časový limit: ideální jízda × procenta + rezerva v sekundách. */
  timePct: 160,
  timeSlackS: 6,
  /**
   * Úseky (P36A T4): trať nové hry má `sectionLengthM` (robot ~40 s místo 23 s
   * na výchozích 350 m) a ve třetinách houstnou překážky (rozestup) a zrychlují
   * dělové koule (procenta rychlosti obtížnosti).
   */
  sectionLengthM: 620,
  sectionGaps: [20 * UNIT, 15 * UNIT, 11 * UNIT],
  sectionShotPct: [100, 115, 130],
} as const;

export const VOYAGE_TERRAINS = ['islands', 'rocks', 'buildings'] as const;
const WALL_OF: Readonly<Record<(typeof VOYAGE_TERRAINS)[number], string>> = { islands: 'island', rocks: 'rock', buildings: 'building' };

interface LandTier {
  readonly padW: number;
  readonly offset: readonly [number, number];
  readonly height: readonly [number, number];
  /** Nejvyšší rychlost sestupu a boční rychlost při dotyku (jednotky za tik) a náklon (stupně). */
  readonly softVy: number;
  readonly softVx: number;
  readonly softTilt: number;
}

/**
 * Přistání (P32F T1): 2D přistávač v rovině x–y. Gravitace planety je v
 * tisícinách jednotky za tik² (1000 = 1 jednotka/tik² ≈ 3,6 m/s², Mars),
 * tah je její násobek. Náklon ve stupních míří tah do strany.
 */
export const LAND = {
  gravity: { min: 400, max: 2800, default: 1000 },
  thrustPct: 225,
  tiltRate: 2,
  maxTilt: 30,
  craftW: 2000,
  craftH: 3000,
  craftD: 2000,
  padH: UNIT,
  padD: 6000,
  tiers: {
    easy: { padW: 16_000, offset: [12_000, 22_000], height: [40_000, 50_000], softVy: 60, softVx: 60, softTilt: 12 },
    normal: { padW: 12_000, offset: [20_000, 32_000], height: [45_000, 60_000], softVy: 50, softVx: 50, softTilt: 10 },
    hard: { padW: 9000, offset: [28_000, 42_000], height: [55_000, 70_000], softVy: 40, softVx: 40, softTilt: 8 },
  } satisfies Readonly<Record<SteerDifficulty, LandTier>>,
} as const;

// ---------------------------------------------------------------------------
// Trať pro soupeře a robota

/** Osa trati: úsek `i` končí v `ends[i]` a jeho střed je `centers[i]`. */
export const courseSchema = z
  .object({
    ends: z.array(z.int()).max(ARCADE_LIMITS.maxBodies),
    centers: z.array(z.int()).max(ARCADE_LIMITS.maxBodies),
    halfWidth: z.int().min(0),
  })
  .strict();
export type SteerCourse = z.infer<typeof courseSchema>;

/** Střed trati v místě `z` (za koncem poslední úsek). */
export function centerAt(course: SteerCourse, at: number): number {
  const { ends, centers } = course;
  for (let i = 0; i < ends.length; i += 1) if (at < (ends[i] as number)) return centers[i] as number;
  return centers[centers.length - 1] ?? 0;
}

/** Soupeř jede střídavě vpravo a vlevo od středu – podle indexu těla, ať se nepřekrývají. */
export const rivalOffset = (index: number, halfWidth: number): number => (index % 2 === 1 ? 1 : -1) * Math.floor(halfWidth / 2);

/** Úseky trati z mantinelů: dvojice se stejným `z` a `d`, seřazené po trati. */
export interface SteerSegment {
  readonly near: number;
  readonly far: number;
  readonly center: number;
  /** Šířka mezi vnitřními hranami mantinelů. */
  readonly width: number;
}

/** Mantinely úseků: pneumatiky závodu, u plavby břehy ostrovů, skal nebo domů. */
const WALL_KINDS: ReadonlySet<string> = new Set(['tire-barrier', 'island', 'rock', 'building']);

export function steerSegments(level: ArcadeLevel): SteerSegment[] {
  const pairs = new Map<string, BodyInit[]>();
  for (const body of level.bodies) {
    if (body.role !== 'obstacle' || !WALL_KINDS.has(body.kind)) continue;
    const key = `${body.z}/${body.d}`;
    pairs.set(key, [...(pairs.get(key) ?? []), body]);
  }
  const segments: SteerSegment[] = [];
  for (const walls of pairs.values()) {
    if (walls.length !== 2) continue;
    const [a, b] = walls as [BodyInit, BodyInit];
    const [left, right] = a.x < b.x ? [a, b] : [b, a];
    const inner = left.x + left.w / 2;
    const outer = right.x - right.w / 2;
    segments.push({ near: a.z - a.d / 2, far: a.z + a.d / 2, center: Math.floor((inner + outer) / 2), width: outer - inner });
  }
  return segments.sort((p, q) => p.near - q.near);
}

export function courseOf(level: ArcadeLevel): SteerCourse {
  const segments = steerSegments(level);
  return { ends: segments.map((s) => s.far), centers: segments.map((s) => s.center), halfWidth: Math.floor((segments[0]?.width ?? 0) / 2) };
}

// ---------------------------------------------------------------------------
// Ovládání

const landParams = z.object({ gravity: z.int().min(LAND.gravity.min).max(LAND.gravity.max) }).strict();

const controlParams = z
  .object({
    topSpeed: z.int().min(150).max(360).default(STEER.topSpeed),
    drift: z.boolean().default(false),
    course: courseSchema.optional(),
    /** Značky rampy (`rampMarks`): za každou vyšší strop rychlosti; bez nich stálý. */
    ramp: z.tuple([z.int(), z.int()]).optional(),
    /** Přistání (P32F): tah a náklon místo plynu a volantu, gravitace planety. */
    land: landParams.optional(),
  })
  .strict();
export type SteerControlParams = z.infer<typeof controlParams>;

// ---------------------------------------------------------------------------
// Přistávač

/** sin a cos po celých stupních 0–30, × 1000. Napevno: `Math.sin` nemusí být všude bit po bitu stejný. */
const SIN = [0, 17, 35, 52, 70, 87, 105, 122, 139, 156, 174, 191, 208, 225, 242, 259, 276, 292, 309, 326, 342, 358, 375, 391, 407, 423, 438, 454, 469, 485, 500] as const;
const COS = [1000, 1000, 999, 999, 998, 996, 995, 993, 990, 988, 985, 982, 978, 974, 970, 966, 961, 956, 951, 946, 940, 934, 927, 921, 914, 906, 899, 891, 883, 875, 866] as const;

/**
 * Celá část zrychlení `milli` (tisíciny jednotky za tik²), která připadne na
 * tik `tick`. Součet přes tiky je přesný a stav nepotřebuje.
 */
const share = (milli: number, tick: number): number => Math.floor((milli * (tick + 1)) / 1000) - Math.floor((milli * tick) / 1000);

/** Přistávač: poloha, rychlost a náklon (stupně, + = tah doprava). */
export interface LandCraft {
  x: number;
  y: number;
  vx: number;
  vy: number;
  tilt: number;
}

const THRUST = BUTTON.UP | BUTTON.HOLD | BUTTON.TAP;

/**
 * Ovládání přistávače na jednom tiku, před gravitací jádra: osa nebo šipky
 * naklání (`tiltRate` za tik, nejvýš `maxTilt`), bez vstupu se loď srovná;
 * čistá gravitace je planety (jádro pak odečte svou `GRAVITY`); tah míří
 * podle náklonu. Tutéž funkci volá robot, takže svou jízdu předpoví přesně.
 */
export function landControl(craft: LandCraft, input: ArcadeInput, gravity: number, tick: number): void {
  let target = Math.trunc((Math.max(-AXIS_MAX, Math.min(AXIS_MAX, input.axis)) * LAND.maxTilt) / AXIS_MAX);
  if ((input.buttons & BUTTON.LEFT) !== 0) target = -LAND.maxTilt;
  if ((input.buttons & BUTTON.RIGHT) !== 0) target = LAND.maxTilt;
  craft.tilt = toward(craft.tilt, target, LAND.tiltRate);
  craft.vy += GRAVITY - share(gravity, tick);
  if ((input.buttons & THRUST) === 0) return;
  const thrust = Math.floor((gravity * LAND.thrustPct) / 100);
  const tilt = Math.min(LAND.maxTilt, Math.abs(craft.tilt));
  craft.vy += share(Math.floor((thrust * COS[tilt]!) / 1000), tick);
  craft.vx += Math.sign(craft.tilt) * share(Math.floor((thrust * SIN[tilt]!) / 1000), tick);
}

/** Tik přistávače ve stavu: `aux0` = náklon, `aux1` = `vy` po ovládání (soudce z ní pozná rychlost dopadu). */
function stepLander(state: Int32Array, player: number, input: ArcadeInput, gravity: number): void {
  const base = bodyBase(player);
  const craft: LandCraft = { x: 0, y: 0, vx: state[base + BODY.vx] as number, vy: state[base + BODY.vy] as number, tilt: state[base + BODY.aux0] as number };
  landControl(craft, input, gravity, state[HEADER.tick] as number);
  state[base + BODY.vx] = craft.vx;
  state[base + BODY.vy] = craft.vy;
  state[base + BODY.vz] = 0;
  state[base + BODY.aux0] = craft.tilt;
  state[base + BODY.aux1] = craft.vy;
}

/** Soupeři: boční rychlost k ose trati před sebou (+ vlastní stopa). */
function steerRivals(state: Int32Array, player: number, course: SteerCourse): void {
  const count = state[HEADER.bodyCount] as number;
  for (let i = 0; i < count; i += 1) {
    if (i === player) continue;
    const base = bodyBase(i);
    const flags = state[base + BODY.flags] as number;
    if ((flags & (FLAG.alive | FLAG.kinematic)) !== (FLAG.alive | FLAG.kinematic) || state[base + BODY.role] !== ROLE.enemy) continue;
    const target = centerAt(course, (state[base + BODY.z] as number) + STEER.rivalLook) + rivalOffset(i, course.halfWidth);
    state[base + BODY.vx] = Math.max(-STEER.rivalLat, Math.min(STEER.rivalLat, target - (state[base + BODY.x] as number)));
  }
}

/**
 * Ovládání vozidla. `aux0` = zbývající tiky turba, `aux1` = skóre, při kterém
 * turbo naposledy naskočilo (sebrané turbo = skóre vyskočilo).
 */
export const steerControl: ControlPiece<SteerControlParams> = {
  id: 'steer',
  params: controlParams,
  roles: ['player', 'enemy'],
  cost: () => ({ bodies: 1, rules: 0 }),
  step: (state, player, input, params) => {
    if (params.land !== undefined) {
      stepLander(state, player, input, params.land.gravity);
      return;
    }
    const base = bodyBase(player);
    const score = state[HEADER.counters + COUNTER.score] as number;
    let boost = state[base + BODY.aux0] as number;
    if (score > (state[base + BODY.aux1] as number)) {
      boost = STEER.boostTicks;
      state[base + BODY.aux1] = score;
    } else if (boost > 0) boost -= 1;
    state[base + BODY.aux0] = boost;

    const top = rampedSpeed(params.topSpeed, state[base + BODY.z] as number, params.ramp) + (boost > 0 ? STEER.boost : 0);
    const vz = state[base + BODY.vz] as number;
    state[base + BODY.vz] = (input.buttons & BUTTON.DOWN) !== 0 ? Math.max(0, vz - STEER.brake) : toward(vz, top, vz > top ? STEER.brake : STEER.accel);

    let target = Math.trunc((Math.max(-AXIS_MAX, Math.min(AXIS_MAX, input.axis)) * STEER.latMax) / AXIS_MAX);
    if ((input.buttons & BUTTON.LEFT) !== 0) target = -STEER.latMax;
    if ((input.buttons & BUTTON.RIGHT) !== 0) target = STEER.latMax;
    const vx = state[base + BODY.vx] as number;
    state[base + BODY.vx] = target !== 0 ? toward(vx, target, STEER.steerRate) : toward(vx, 0, params.drift ? STEER.driftGrip : STEER.grip);

    if (params.course !== undefined) steerRivals(state, player, params.course);
  },
};

// ---------------------------------------------------------------------------
// Dosah řízení – z něj generátor i kontrola počítají, co je hratelné

/**
 * Boční posun, který vozidlo stihne na úseku délky `length` při rychlosti
 * `speed`: prvních `reactionTicks` tiků ještě neřídí (boční rychlost `v0`
 * dojíždí nejhorší přilnavostí), pak plné vychýlení osy.
 */
export function lateralReach(length: number, speed: number, v0 = 0): number {
  const ticks = Math.floor(length / speed);
  let vx = v0;
  let x = 0;
  for (let t = 0; t < ticks; t += 1) {
    vx = t < STEER.reactionTicks ? toward(vx, 0, STEER.driftGrip) : toward(vx, STEER.latMax, STEER.steerRate);
    x += vx;
  }
  return x;
}

/** Nejvyšší rychlost, se kterou hratelnost počítá na místě `z`: rychlejší spec po rampě + turbo. */
const fastest = (topSpeed: number, z = 0, ramp?: readonly number[]): number => rampedSpeed(topSpeed, z, ramp) + STEER.boost;

/** Tiky, za které hráč ideálně (rovně, plným plynem) ujede `distance`. */
export function idealTicks(distance: number, topSpeed: number): number {
  let v = 0;
  let z = 0;
  let ticks = 0;
  while (z < distance) {
    v = toward(v, topSpeed, STEER.accel);
    z += v;
    ticks += 1;
  }
  return ticks;
}

// ---------------------------------------------------------------------------
// Generátor

const generatorParams = z
  .object({
    difficulty: z.enum(STEER_DIFFICULTIES).default('normal'),
    lengthM: z.int().min(STEER_TRACK.minLengthM).max(STEER_TRACK.maxLengthM).default(450),
    rivals: z.boolean().default(true),
    turbo: z.boolean().default(true),
    topSpeed: z.int().min(150).max(360).default(STEER.topSpeed),
    drift: z.boolean().default(false),
  })
  .strict();
export type SteerTrackParams = z.infer<typeof generatorParams>;

function walls(near: number, far: number, center: number, width: number): BodyInit[] {
  const z0 = Math.floor((near + far) / 2);
  const offset = width / 2 + STEER.wallW / 2;
  const wall = (x: number): BodyInit => ({ role: 'obstacle', kind: 'tire-barrier', x, y: 0, z: z0, w: STEER.wallW, h: STEER.wallH, d: far - near, solid: true });
  return [wall(center - offset), wall(center + offset)];
}

export const steerTrack: GeneratorPiece<SteerTrackParams> = {
  id: 'steer_track',
  params: generatorParams,
  roles: ['player', 'obstacle', 'enemy', 'collectible', 'goal'],
  cost: (params) => {
    const tier = TIERS[params.difficulty];
    const pieces = Math.ceil((params.lengthM * UNIT) / (tier.straight[0] + STEER_TRACK.segment)) + 2;
    return { bodies: 2 + tier.rivals + pieces * 2 * 8 + STEER_TRACK.maxTurbos, rules: 3 };
  },
  generate: (seed, params) => {
    const rng = createCompileRng(seed);
    const tier = TIERS[params.difficulty];
    const length = params.lengthM * UNIT;
    const { width } = tier;
    const half = width / 2;

    const segments: { near: number; far: number; center: number }[] = [{ near: -STEER_TRACK.startBack, far: STEER_TRACK.runIn, center: 0 }];
    const straights: { near: number; far: number; center: number }[] = [];
    let z: number = STEER_TRACK.runIn;
    let center = 0;
    // Posun úseku nesmí přerůst boční dosah při nejvyšší rychlosti (rychlejší
    // spec = mírnější zatáčky); počítá se s rychlostí za poslední značkou rampy.
    const maxShift = Math.min(tier.shift[1], lateralReach(STEER_TRACK.segment, fastest(params.topSpeed, length, rampMarks(length))) - STEER.clearance);
    for (;;) {
      // Zatáčka: posun úseků do jedné strany, celkem víc než šířka trati.
      const shift = rng.int(Math.min(tier.shift[0], maxShift), maxShift);
      const count = Math.ceil((width + STEER.carW) / shift) + rng.int(0, 1);
      const total = shift * count;
      const side = Math.abs(center) + total > STEER_TRACK.maxCenter ? -Math.sign(center) : rng.int(0, 1) === 0 ? -1 : 1;
      for (let k = 0; k < count; k += 1) {
        center += side * shift;
        segments.push({ near: z, far: z + STEER_TRACK.segment, center });
        z += STEER_TRACK.segment;
      }
      // Sudá délka: mantinel stojí středem v `z` a jeho hrany musí být celá čísla.
      const straight = 2 * rng.int(tier.straight[0] / 2, tier.straight[1] / 2);
      if (z + straight + STEER_TRACK.segment * 6 + STEER_TRACK.finalStraight >= length) {
        const last = { near: z, far: Math.max(length, z + STEER_TRACK.finalStraight) + STEER_TRACK.runOut, center };
        segments.push(last);
        straights.push(last);
        break;
      }
      const piece = { near: z, far: z + straight, center };
      segments.push(piece);
      straights.push(piece);
      z += straight;
    }
    const finishZ = (segments[segments.length - 1] as { far: number }).far - STEER_TRACK.runOut;

    const bodies: BodyInit[] = [{ role: 'player', kind: 'car', x: 0, y: 0, z: 0, w: STEER.carW, h: STEER.carH, d: STEER.carD, solid: false }];
    // Soupeři hned za hráčem v poli (index 1, 2, … – podle něj jedou vpravo/vlevo od středu).
    if (params.rivals) {
      // Na krátké trati by náskok soupeřů z pole přerostl rezervu: rychlost se sníží tak, aby dojeli nejdřív za `rivalMargin` × ideál.
      const slowest = STEER_TRACK.rivalMargin * idealTicks(finishZ, params.topSpeed);
      for (let k = 0; k < tier.rivals; k += 1) {
        const index = bodies.length;
        const z0 = 6000 + 5000 * k;
        const speed = Math.min(Math.floor((params.topSpeed * tier.rivalPct) / 100), Math.floor((finishZ - z0 - STEER.carD / 2) / slowest));
        bodies.push({ role: 'enemy', kind: 'rival-car', x: rivalOffset(index, Math.floor(half)), y: 0, z: z0, w: STEER.carW, h: STEER.carH, d: STEER.carD, solid: true, kinematic: true, vz: speed });
      }
    }
    for (const segment of segments) bodies.push(...walls(segment.near, segment.far, segment.center, width));
    if (params.turbo) {
      const budget = Math.min(STEER_TRACK.maxTurbos, ARCADE_LIMITS.maxBodies - bodies.length - 1);
      const spots = straights
        .filter((piece) => piece.far - piece.near >= 30 * UNIT && piece.near < finishZ - 20 * UNIT)
        .map((piece) => ({ z: piece.near + rng.int(10 * UNIT, 20 * UNIT), x: piece.center + rng.int(-Math.floor(half / 2), Math.floor(half / 2)) }));
      for (const spot of spots.slice(0, Math.max(0, budget))) bodies.push({ role: 'collectible', kind: 'turbo', x: spot.x, y: 0, z: spot.z, w: 1500, h: 300, d: 1500, solid: false });
    }
    bodies.push({ role: 'goal', kind: 'finish', x: center, y: 0, z: finishZ, w: width, h: 3 * UNIT, d: 400, solid: false });
    return { bodies, length: finishZ };
  },
};

// ---------------------------------------------------------------------------
// Pravidla

const touchdownParams = z.object({ softVy: z.int().min(1), softVx: z.int().min(0), softTilt: z.int().min(0).max(LAND.maxTilt) }).strict();
const rivalFinishParams = z.union([
  z.object({ atZ: z.int().min(0) }).strict(),
  /** `retry` (P36A T2): tvrdý dotyk se životy ubere život a vrátí loď nahoru na start, prohra až po posledním. */
  z.object({ land: touchdownParams, retry: z.literal(true).optional() }).strict(),
]);

/**
 * Soudce přistání: hráč se právě dotkl (`grounded`). Výhra jen na horní ploše
 * cíle, pomalu, rovně a bez smyku; dotyk jinde nebo tvrdě = prohra. Rychlost
 * dopadu je `vy` po ovládání (`aux1`) minus gravitace jádra – kolize ji už vynulovala.
 */
function judgeTouchdown(state: Int32Array, player: number, soft: z.infer<typeof touchdownParams>): 'win' | 'lose' | null {
  const p = bodyBase(player);
  if (((state[p + BODY.flags] as number) & FLAG.grounded) === 0) return null;
  const descent = GRAVITY - (state[p + BODY.aux1] as number);
  const px = state[p + BODY.x] as number;
  const py = state[p + BODY.y] as number;
  const count = state[HEADER.bodyCount] as number;
  let onPad = false;
  for (let i = 0; i < count && !onPad; i += 1) {
    const base = bodyBase(i);
    if (i === player || ((state[base + BODY.flags] as number) & FLAG.alive) === 0 || state[base + BODY.role] !== ROLE.goal) continue;
    onPad = py === (state[base + BODY.y] as number) + (state[base + BODY.h] as number) && Math.abs(px - (state[base + BODY.x] as number)) * 2 < (state[base + BODY.w] as number) + (state[p + BODY.w] as number);
  }
  const gentle = descent <= soft.softVy && Math.abs(state[p + BODY.vx] as number) <= soft.softVx && Math.abs(state[p + BODY.aux0] as number) <= soft.softTilt;
  return onPad && gentle ? 'win' : 'lose';
}

/**
 * Soupeř projel cílem (jeho přední hrana za `atZ`) dřív než hráč → prohra.
 * S parametrem `land` (P32F) místo toho soudí přistání (`judgeTouchdown`).
 */
export const rivalFinish: RulePiece<z.infer<typeof rivalFinishParams>> = {
  id: 'rival_finish',
  params: rivalFinishParams,
  roles: ['enemy', 'goal'],
  trigger: 'tick',
  cost: () => ({ bodies: 0, rules: 1 }),
  fire: ({ state, player }, params) => {
    if ('land' in params) {
      const verdict = judgeTouchdown(state, player, params.land);
      if (verdict === 'lose' && params.retry === true) return [{ kind: 'damage', amount: 1 }, { kind: 'respawn' }];
      return verdict === null ? [] : [{ kind: verdict }];
    }
    const count = state[HEADER.bodyCount] as number;
    for (let i = 0; i < count; i += 1) {
      const base = bodyBase(i);
      if (((state[base + BODY.flags] as number) & FLAG.alive) === 0 || state[base + BODY.role] !== ROLE.enemy) continue;
      if ((state[base + BODY.z] as number) + (state[base + BODY.d] as number) / 2 >= params.atZ) return [{ kind: 'lose' }];
    }
    return [];
  },
};

/** Ovládání závodu i s osou trati pro soupeře. */
export function steerControlRef(level: ArcadeLevel, params: Pick<SteerTrackParams, 'topSpeed' | 'drift'>): PieceRef {
  return { id: 'steer', params: { topSpeed: params.topSpeed, drift: params.drift, course: courseOf(level), ramp: rampMarks(level.length) } };
}

/** Robot řidiče (`steer-bot.ts`) s tou samou osou trati a rampou. */
export function steerBotRef(level: ArcadeLevel, params: Pick<SteerTrackParams, 'topSpeed' | 'drift'>): PieceRef {
  return { id: 'steer_bot', params: { topSpeed: params.topSpeed, drift: params.drift, course: courseOf(level), ramp: rampMarks(level.length) } };
}

/** Pravidla závodu: turbo, cíl, soupeř v cíli. */
export function steerRules(level: ArcadeLevel): PieceRef[] {
  const rules: PieceRef[] = [
    { id: 'pickup', params: {} },
    { id: 'finish', params: {} },
  ];
  if (level.bodies.some((body) => body.role === 'enemy')) rules.push({ id: 'rival_finish', params: { atZ: level.length } });
  return rules;
}

// ---------------------------------------------------------------------------
// Kontrola hratelnosti

/**
 * Tvrzení „hratelné z konstrukce“ nad hotovou tratí: vrací porušení, prázdné
 * pole = hratelná. Rychlost je nejvyšší možná (spec + turbo).
 */
export function checkSteerLevel(level: ArcadeLevel, topSpeed: number = STEER.topSpeed, ramp: readonly number[] | undefined = rampMarks(level.length)): string[] {
  const issues: string[] = [];
  const m = (units: number): string => `${(units / UNIT).toFixed(1)} m`;
  const segments = steerSegments(level);
  const minPass = STEER.carW + 2 * STEER.clearance;
  if (segments.length === 0) return ['the track has no barriers'];

  segments.forEach((segment, index) => {
    if (segment.width < minPass) issues.push(`track at ${m(segment.near)} is ${m(segment.width)} wide – narrower than the car`);
    const prev = segments[index - 1];
    if (prev === undefined) return;
    if (prev.far !== segment.near) issues.push(`barriers leave a hole between ${m(prev.far)} and ${m(segment.near)}`);
    const shift = segment.center - prev.center;
    // Průjezd: překryv šířek sousedních úseků.
    const pass = Math.min(prev.center + prev.width / 2, segment.center + segment.width / 2) - Math.max(prev.center - prev.width / 2, segment.center - segment.width / 2);
    if (pass < minPass) issues.push(`the bend at ${m(segment.near)} leaves a ${m(pass)} gap – too tight for the car`);
    if (Math.abs(shift) >= STEER.wallW) issues.push(`the bend at ${m(segment.near)} moves ${m(shift)}, past the barrier thickness – the car could leave the track`);
    // Obrat směru: boční rychlost míří na opačnou stranu a musí se nejdřív zrušit.
    const before = segments[index - 2];
    const reverse = before !== undefined && Math.sign(prev.center - before.center) === -Math.sign(shift) && shift !== 0;
    const reach = lateralReach(prev.far - prev.near, fastest(topSpeed, segment.near, ramp), reverse ? -STEER.latMax : 0) - STEER.clearance;
    if (Math.abs(shift) > reach) issues.push(`the bend at ${m(segment.near)} moves ${m(shift)} but the car can steer only ${m(reach)} at full speed`);
  });

  const player = level.bodies[0];
  const first = segments[0] as SteerSegment;
  if (player === undefined || player.z <= first.near || player.z >= first.far || Math.abs(player.x - first.center) * 2 > first.width - STEER.carW) issues.push('the car does not start on the track');
  const goal = level.bodies.find((body) => body.role === 'goal');
  const host = goal === undefined ? undefined : segments.find((s) => goal.z > s.near && goal.z < s.far);
  if (goal === undefined || host === undefined || goal.z !== level.length || goal.w < host.width) issues.push('no finish across the track at its end');

  // Kdo neřídí, narazí: rovná čára ze startu musí skončit v mantinelu.
  if (player !== undefined && !segments.some((s) => s.far > player.z && s.near < level.length && Math.abs(s.center - player.x) * 2 > s.width - STEER.carW)) issues.push('a car that never steers reaches the finish');

  const ideal = idealTicks(level.length, topSpeed);
  for (const rival of level.bodies.filter((body) => body.role === 'enemy')) {
    const ticks = Math.ceil((level.length - rival.z - rival.d / 2) / Math.max(1, rival.vz ?? 0));
    if (ticks < STEER_TRACK.rivalMargin * ideal) issues.push(`a rival at ${m(rival.z)} finishes in ${ticks} ticks – too close to the ideal ${ideal}`);
    const lane = segments.find((s) => rival.z > s.near && rival.z < s.far);
    if (lane === undefined || Math.abs(rival.x - lane.center) * 2 > lane.width - STEER.carW) issues.push(`a rival at ${m(rival.z)} starts off the track`);
  }
  if (level.bodies.length > ARCADE_LIMITS.maxBodies) issues.push(`${level.bodies.length} bodies exceed the ${ARCADE_LIMITS.maxBodies} body limit`);
  return issues;
}

// ---------------------------------------------------------------------------
// Plavba (P32F T1)

const voyageRaceParams = z
  .object({
    difficulty: z.enum(STEER_DIFFICULTIES).default('normal'),
    lengthM: z.int().min(VOYAGE.lengthM.min).max(VOYAGE.lengthM.max).default(VOYAGE.lengthM.default),
    topSpeed: z.int().min(VOYAGE.topSpeed.min).max(VOYAGE.topSpeed.max).default(VOYAGE.topSpeed.default),
    terrain: z.enum(VOYAGE_TERRAINS).default('islands'),
    /** Úseky (P36A T4, píše je žánr): ve třetinách trati hustší překážky a rychlejší koule; bez nich jako dřív. */
    sections: z.literal(3).optional(),
  })
  .strict();
export type VoyageRaceParams = z.infer<typeof voyageRaceParams>;

/** Třetina trati (0..2), ve které leží `z`. */
const thirdOf = (z: number, length: number): number => Math.min(2, Math.floor((3 * z) / Math.max(1, length)));

const raceTrack = (params: VoyageRaceParams): SteerTrackParams => ({ difficulty: params.difficulty, lengthM: params.lengthM, rivals: false, turbo: false, topSpeed: params.topSpeed, drift: false });

/** Dělová koule kyvadlem od břehu k břehu: začne u jednoho, otočí se u druhého. */
function shotAcross(lane: SteerSegment, z0: number, speed: number, side: number): BodyInit {
  const period = Math.floor((lane.width - VOYAGE.shot - 2 * VOYAGE.shotBank) / speed);
  const x = lane.center - side * Math.floor((period * speed) / 2);
  return { role: 'hazard', kind: 'shot', x, y: 0, z: z0, w: VOYAGE.shot, h: VOYAGE.shot, d: VOYAGE.shot, solid: false, kinematic: true, vx: side * speed, period };
}

/** Časový limit závodu v sekundách: ideální jízda × `timePct` + rezerva. */
const voyageSeconds = (length: number, topSpeed: number): number =>
  Math.min(ARCADE_LIMITS.maxTicks / ARCADE_HZ, Math.max(10, Math.ceil((idealTicks(length, topSpeed) * VOYAGE.timePct) / 100 / ARCADE_HZ) + VOYAGE.timeSlackS));

/**
 * Režim `voyage.race`: trať závodu (`steerTrack`, bez soupeřů a turba), ze
 * které se mantinely stanou břehy, na začátku každé rovinky kromě rozjezdu
 * je brána přes celou šířku, na rovinkách střídavě dělová koule a stojící
 * útes a v cíli poklad. Hratelnost trati hlídá `checkSteerLevel`, koule a
 * útesy leží v kanálu z konstrukce.
 */
export const voyageRace: ModeGeneratorPiece<VoyageRaceParams> = {
  id: 'voyage_race',
  params: voyageRaceParams,
  roles: ['player', 'obstacle', 'checkpoint', 'hazard', 'goal'],
  cost: (params) => ({
    bodies: steerTrack.cost(raceTrack(params)).bodies + 2 * Math.ceil((params.lengthM * UNIT) / (params.sections === undefined ? VOYAGE.hazardGap : Math.min(...VOYAGE.sectionGaps))),
    rules: 5,
  }),
  generate: (seed, params) => {
    const track = steerTrack.generate(seed, raceTrack(params));
    const rng = createCompileRng(seed ^ 0x5eed);
    const wall = WALL_OF[params.terrain];
    const speed = VOYAGE.shotSpeed[params.difficulty];
    const bodies: BodyInit[] = [];
    let goal: BodyInit | undefined;
    for (const body of track.bodies) {
      if (body.role === 'player') bodies.unshift({ ...body, kind: 'player' });
      else if (body.role === 'obstacle') bodies.push({ ...body, kind: wall });
      else if (body.role === 'goal') goal = { ...body, kind: 'goal' };
    }
    const gates: BodyInit[] = [];
    const hazards: BodyInit[] = [];
    // Rovinky: úseky delší než kus zatáčky; první je rozjezd za startem.
    for (const lane of steerSegments(track).filter((s) => s.far - s.near > STEER_TRACK.segment && s.near > 0)) {
      gates.push({ role: 'checkpoint', kind: 'gate', x: lane.center, y: 0, z: lane.near + VOYAGE.gateInset, w: lane.width, h: VOYAGE.gateH, d: VOYAGE.gateD, solid: false });
      const end = Math.min(lane.far, track.length) - VOYAGE.hazardBeforeEnd;
      // S úseky ke konci hustší překážky a rychlejší koule (P36A T4).
      const third = (z0: number): number => (params.sections === undefined ? 0 : thirdOf(z0, track.length));
      for (let z0 = lane.near + VOYAGE.hazardFrom; z0 <= end; z0 += params.sections === undefined ? VOYAGE.hazardGap : VOYAGE.sectionGaps[third(z0)]!) {
        const quarter = Math.floor(lane.width / 4);
        hazards.push(
          hazards.length % 2 === 0
            ? shotAcross(lane, z0, Math.floor((speed * VOYAGE.sectionShotPct[third(z0)]!) / 100), rng.int(0, 1) === 0 ? -1 : 1)
            : { role: 'hazard', kind: 'snag', x: lane.center + rng.int(-quarter, quarter), y: 0, z: z0, w: VOYAGE.snag, h: VOYAGE.snagH, d: VOYAGE.snag, solid: false },
        );
      }
    }
    bodies.push(...gates, ...hazards);
    if (goal !== undefined) bodies.push(goal);
    return { bodies, length: track.length };
  },
  parts: (seed, params, health) => {
    const level = voyageRace.generate(seed, params);
    return {
      control: { id: 'steer', params: { topSpeed: params.topSpeed } },
      bot: { id: 'steer_bot', params: { topSpeed: params.topSpeed, course: courseOf(level), dodge: true } },
      level,
      rules: [
        // Koule nebo útes ubere život a zmizí; vteřinu milosti další nic nebere (P36A T2).
        { id: 'hit', params: { role: 'hazard', effect: 'damage', grace: HIT_GRACE } },
        { id: 'out_of_health', params: {} },
        { id: 'finish', params: {} },
        { id: 'checkpoint', params: {} },
        { id: 'time_limit', params: { seconds: voyageSeconds(level.length, params.topSpeed) } },
      ],
      issues: checkSteerLevel(level, params.topSpeed),
      health: health ?? VOYAGE.lives,
    };
  },
};

const voyageLandParams = z
  .object({
    difficulty: z.enum(STEER_DIFFICULTIES).default('normal'),
    gravity: z.int().min(LAND.gravity.min).max(LAND.gravity.max).default(LAND.gravity.default),
  })
  .strict();
export type VoyageLandParams = z.infer<typeof voyageLandParams>;

/**
 * Režim `voyage.land`: loď visí nad zemí, plocha (pevné těleso role `goal`)
 * stojí stranou. Volný pád skončí na zemi vedle plochy – prohra; výhra je
 * jen měkký, rovný dotyk na ploše (`rival_finish` s `land`).
 */
export const voyageLand: ModeGeneratorPiece<VoyageLandParams> = {
  id: 'voyage_land',
  params: voyageLandParams,
  roles: ['player', 'goal'],
  cost: () => ({ bodies: 2, rules: 1 }),
  generate: (seed, params) => {
    const rng = createCompileRng(seed);
    const tier = LAND.tiers[params.difficulty];
    const side = rng.int(0, 1) === 0 ? -1 : 1;
    const offset = rng.int(tier.offset[0], tier.offset[1]);
    const height = rng.int(tier.height[0], tier.height[1]);
    return {
      bodies: [
        { role: 'player', kind: 'player', x: 0, y: height, z: 0, w: LAND.craftW, h: LAND.craftH, d: LAND.craftD, solid: false },
        { role: 'goal', kind: 'pad', x: side * offset, y: 0, z: 0, w: tier.padW, h: LAND.padH, d: LAND.padD, solid: true },
      ],
      length: 0,
    };
  },
  parts: (seed, params, health) => {
    const tier = LAND.tiers[params.difficulty];
    const land = { softVy: tier.softVy, softVx: tier.softVx, softTilt: tier.softTilt };
    // Se životy (P36A T2) tvrdý dotyk ubere život a loď začne znovu nahoře; bez nich jeden pokus jako dřív.
    const rules: PieceRef[] =
      health === undefined
        ? [{ id: 'rival_finish', params: { land } }]
        : [
            { id: 'rival_finish', params: { land, retry: true } },
            { id: 'out_of_health', params: {} },
          ];
    return {
      control: { id: 'steer', params: { land: { gravity: params.gravity } } },
      bot: { id: 'steer_bot', params: { land: { gravity: params.gravity } } },
      level: voyageLand.generate(seed, params),
      rules,
      health,
    };
  },
};
