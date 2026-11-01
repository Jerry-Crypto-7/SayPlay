/**
 * Trať závodu s triky (P68V T2): konstanty, generátor a kontrola hratelnosti.
 *
 * **Trať** je okruh řízení ze vzorů (`steerPatternTrack`, import) bez soupeřů a turba, prodloužený o rovné **úseky
 * s triky**: za vybranou rovinkou (spoj, rovinka s turbem, rozjezd) se trať rozřízne a vloží se úsek se středem
 * a šířkou té rovinky – s rampou a dojezdem, nebo s hromadou věcí z věty. Všechno za řezem se posune o délku úseku,
 * takže zatáčky zůstávají, jak je řízení postavilo (jejich průjezd i boční dosah se vložením jen zlepší), a cíl je
 * dál na konci. Kde úseky leží, kam se rampa a hromada posunou do strany a tabulka rozptylu trosek se losují ze
 * streamu `stunt` (`stuntRng`), ne ze streamu trati – řízení losuje totéž, co bez triků.
 *
 * **Hratelné z konstrukce:** dojezd za rampou je delší než nejdelší skok při nejvyšší rychlosti (`stuntReach`,
 * celočíselná simulace téže balistiky, jakou počítá jádro) a boční drift ve vzduchu nedosáhne na mantinel; hromada
 * nechá vždy volný pruh širší než auto s rezervou. `checkStuntLevel` totéž přepočítá nad hotovou tratí.
 *
 * Determinismus: celá čísla, náhoda jen při stavbě (`pure-rand`, stream `stunt`), jádro žádnou nespotřebuje.
 */

import { z } from 'zod';

import { createStreams, nextInt } from '@/sim/rng';

import { P68_MAX_TICKS, STUNT_DEBRIS_MAX } from '../../genre/p68-contract';
import {
  ARCADE_HZ,
  ARCADE_LIMITS,
  type ArcadeLevel,
  type ArcadeState,
  BODY,
  type BodyInit,
  COUNTER,
  FLAG,
  HEADER,
  type ModeParts,
  type PieceRef,
  START_LIVES,
  UNIT,
  bodyBase,
} from '../contract';
import { GRAVITY } from '../kernel';
import { STEER, STEER_DIFFICULTIES, type SteerCourse, checkSteerLevel, idealTicks, steerPatternTrack, steerRoute, steerSegments, steerTrack } from './steer';

// ---------------------------------------------------------------------------
// Konstanty

export const STUNT = {
  /** Nejvyšší rychlost vpřed = řízení (18 m/s). Turbo ani značky rampy řízení tu nejsou, takže víc auto nepojede. */
  topSpeed: STEER.topSpeed,
  /**
   * Délka okruhu řízení před vložením úseků s triky (ty přidají 100–220 m): výchozí trať ~500 m = ~30 s plným plynem.
   * Hromady leží jen v úsecích, které i po všech vloženích končí do `groundZ` (země Rapieru); rampy kdekoli.
   */
  lengthM: { min: 200, max: 360, default: 340 },
  ramps: { min: 2, max: 4, default: 3 },
  piles: { min: 2, max: 4, default: 3 },
  /** Krabic v jedné hromadě; 4 hromady × 6 = `STUNT_DEBRIS_MAX`. */
  boxes: { min: 3, max: 6, default: 5 },
  /**
   * Rampa: klín `w × h × d`, auto po něm stoupá sklonem `h / d` a na hraně vyletí svislou rychlostí `vz · h / d` (úměrně
   * rychlosti vpřed). `lead` = rovinka před rampou, `pad` = rezerva dojezdu za nejdelším skokem, `snap` = jak daleko od
   * plochy rampy ještě auto jede po ní (zboku do klínu nenajede, projede ho).
   */
  ramp: { w: 3000, h: 1500, d: 3500, lead: 6000, pad: 10_000, snap: 250 },
  /** Hromada: krabice `box`, mezera mezi krabicemi řady, rovinka před a za hromadou, odstup od mantinelu. */
  pile: { box: 900, gap: 20, lead: 12_000, exit: 8000, wallGap: 300 },
  /**
   * Ve vzduchu a na rampě: boční rychlost nejvýš `lat` (řízení ztlumené na `steerRate` za tik, plyn ani brzda nic);
   * skok se počítá od `minJumpTicks` tiků ve vzduchu, body za skok = tiky / `ticksPerPoint`.
   */
  air: { lat: 24, steerRate: 4, minJumpTicks: 6, ticksPerPoint: 2 },
  /**
   * Náraz do mantinelu: změna rychlosti nad `speed` (jednotky za tik) = −1 život s milostí `grace` tiků; prvních
   * `stunTicks` z ní je auto omráčené (bez plynu a řízení) a v prvním tiku spadne rychlost na `keepPct` %.
   */
  crash: { speed: 60, grace: 60, stunTicks: 24, keepPct: 40 },
  /** Náraz do hromady: auto zpomalí na `keepPct` %, každá rozbitá krabice dá `points`. */
  smash: { keepPct: 70, points: 10 },
  /**
   * Rychlost trosky z rychlosti auta: vpřed `forwardPct` % rychlosti vpřed, nahoru `liftPct` %, do strany od osy auta
   * `side` + polovina boční rychlosti auta; k tomu řádek tabulky rozptylu (`dx` ±, `dy` od–do, `dz` ±).
   */
  kick: { forwardPct: 80, liftPct: 25, side: 40, dx: 40, dy: [10, 60], dz: 40 },
  /** Řádků tabulky rozptylu (stream `stunt`, krabice bere řádek podle pořadí). */
  scatterSize: 16,
  /** Nejvýš tolik živých trosek naráz (pod stropem světa `STUNT_DEBRIS_MAX`). */
  debrisMax: 8,
  /** Troska zhasne po tolika tikách (2,5 s); drží je HP trosky (`debrisClock`). */
  debrisLife: 150,
  /** Odraz krabic v promile. */
  restitution: 200,
  /** Troska pod touhle výškou (propadla za okraj země Rapieru) zhasne. */
  fallY: -1500,
  /** Úsek s triky jen za rovinkou aspoň takhle dlouhou a končící aspoň takhle daleko od startu. */
  minStraight: 16 * UNIT,
  firstAt: 30 * UNIT,
  /** Země Rapieru je čtverec ±500 m; krabice hromad stojí nejdál tady. */
  groundZ: 480 * UNIT,
  /** Limit tratě: ideální čas × `pct` % + `slack` tiků, nejvýš `P68_MAX_TICKS`. */
  limit: { pct: 140, slack: 360 },
  /** Rezerva ke všem bočním výpočtům. */
  margin: 200,
  kinds: { ramp: 'gen3d-ramp', vehicle: 'car', thing: 'crate' },
} as const;

/** Tělesa hry na pevných indexech: hráč, počítadlo (`STUNT_SLOTS`), první předloha trosek. */
export const STUNT_BODIES = { player: 0, keeper: 1, firstTemplate: 2 } as const;

/**
 * Stav závodu s triky na počítadle (mrtvé tělo `STUNT_BODIES.keeper`, jako počítadlo komba). Hlavička nemá volný čítač,
 * a tak tu jsou čítače hry: `air` = tiky ve vzduchu, `smash` = rozbité krabice, `jumps` = skoky, `impacts` = trefené
 * hromady; pracovní: `streak` = tiky ve vzduchu tohoto skoku, `preVx/preVz` = rychlost auta po ovládání (soudce nárazu
 * z ní pozná změnu rychlosti), `dead` = bity krabic hromad, které ovládání už započítalo.
 */
export const STUNT_SLOTS = {
  air: BODY.x,
  smash: BODY.y,
  jumps: BODY.z,
  preVx: BODY.vx,
  streak: BODY.vy,
  preVz: BODY.vz,
  dead: BODY.aux0,
  impacts: BODY.aux1,
} as const;
export type StuntSlot = keyof typeof STUNT_SLOTS;

/** Čítač hry z počítadla. */
export const stuntCounter = (state: ArcadeState, slot: StuntSlot, keeper: number = STUNT_BODIES.keeper): number => state[bodyBase(keeper) + STUNT_SLOTS[slot]] as number;
export const stuntLivesOf = (state: ArcadeState): number => state[HEADER.counters + COUNTER.health] as number;

/** Živá troska: fyzikální tělo od `spawnBase` (krabice hromad leží pod ním, nic jiného hra fyzikálního nespawnuje). */
export const isDebris = (state: ArcadeState, body: number): boolean =>
  body >= (state[HEADER.spawnBase] as number) && ((state[bodyBase(body) + BODY.flags] as number) & (FLAG.alive | FLAG.physics)) === (FLAG.alive | FLAG.physics);

/** Živé trosky v pořadí slotů. */
export function stuntDebrisOf(state: ArcadeState): number[] {
  const out: number[] = [];
  for (let i = state[HEADER.spawnBase] as number; i < (state[HEADER.bodyCount] as number); i += 1) if (isDebris(state, i)) out.push(i);
  return out;
}

// ---------------------------------------------------------------------------
// Rampa a skok

/** Rampa: střed `x`, začátek a konec `z0 < z1`, šířka a výška klínu. */
export interface StuntRamp {
  readonly x: number;
  readonly z0: number;
  readonly z1: number;
  readonly w: number;
  readonly h: number;
}

/** Hromada: střed spodní řady `x/z`, počet krabic a model krabic. */
export interface StuntPile {
  readonly x: number;
  readonly z: number;
  readonly count: number;
  readonly kind: string;
}

export interface StuntLayout {
  readonly ramps: readonly StuntRamp[];
  readonly piles: readonly StuntPile[];
}

/** Výška plochy rampy v místě `z` (celé číslo). */
export const rampHeightAt = (ramp: StuntRamp, z: number): number => Math.floor((ramp.h * (z - ramp.z0)) / (ramp.z1 - ramp.z0));
/** Svislá rychlost, kterou rampa dává autu jedoucímu `vz` (= rychlost na hraně). */
export const rampClimb = (ramp: StuntRamp, vz: number): number => Math.floor((Math.max(0, vz) * ramp.h) / (ramp.z1 - ramp.z0));

/** Rampa, po které auto se středem `x, z` ve výšce `y` právě jede, nebo −1. Zboku do klínu nenajede (je pod plochou). */
export function rampUnder(ramps: readonly StuntRamp[], x: number, y: number, z: number): number {
  for (let k = 0; k < ramps.length; k += 1) {
    const ramp = ramps[k] as StuntRamp;
    if (z < ramp.z0 || z >= ramp.z1 || Math.abs(x - ramp.x) * 2 >= ramp.w) continue;
    if (Math.abs(y - rampHeightAt(ramp, z)) <= STUNT.ramp.snap) return k;
  }
  return -1;
}

export interface StuntFlight {
  /** Tiky na rampě a ve vzduchu. */
  readonly rampTicks: number;
  readonly airTicks: number;
  /** Kde (z od začátku rampy) střed auta dopadne. */
  readonly landing: number;
  readonly apex: number;
}

const DEFAULT_RAMP: StuntRamp = { x: 0, z0: 0, z1: STUNT.ramp.d, w: STUNT.ramp.w, h: STUNT.ramp.h };

/**
 * Skok rychlostí `speed` přes rampu, celočíselně jako jádro a ovládání: na rampě ovládání drží auto na ploše a dá mu
 * svislou rychlost `rampClimb` (+ gravitaci, kterou jádro hned odečte), za hranou letí jen gravitací jádra stálou
 * rychlostí vpřed. `entry` = kde za začátkem rampy je střed auta v prvním tiku na ní (0..`speed`).
 */
export function stuntFlight(speed: number, entry = 0, ramp: StuntRamp = DEFAULT_RAMP): StuntFlight {
  const d = ramp.z1 - ramp.z0;
  let z = entry;
  let y = 0;
  let vy = 0;
  let rampTicks = 0;
  let airTicks = 0;
  let apex = 0;
  for (let guard = 0; guard < ARCADE_LIMITS.maxTicks; guard += 1) {
    const on = rampUnder([{ ...ramp, z0: 0, z1: d }], ramp.x, y, z) >= 0;
    if (!on && y <= 0 && z >= d) break;
    if (on) {
      y = rampHeightAt({ ...ramp, z0: 0, z1: d }, z);
      vy = GRAVITY + rampClimb(ramp, speed);
      rampTicks += 1;
    } else airTicks += 1;
    vy -= GRAVITY;
    y += vy;
    z += speed;
    if (y <= 0) {
      y = 0;
      vy = 0;
    }
    apex = Math.max(apex, y);
  }
  return { rampTicks, airTicks, landing: z, apex };
}

const reachCache = new Map<number, { readonly landing: number; readonly ticks: number }>();

/** Nejhorší skok rychlostí `speed` přes všechna místa vjezdu: nejdelší dopad a nejvíc tiků na rampě a ve vzduchu. */
export function stuntReach(speed: number = STUNT.topSpeed): { readonly landing: number; readonly ticks: number } {
  const known = reachCache.get(speed);
  if (known !== undefined) return known;
  let landing = 0;
  let ticks = 0;
  for (let entry = 0; entry < Math.max(1, speed); entry += 1) {
    const flight = stuntFlight(speed, entry);
    landing = Math.max(landing, flight.landing);
    ticks = Math.max(ticks, flight.rampTicks + flight.airTicks);
  }
  const reach = { landing, ticks };
  reachCache.set(speed, reach);
  return reach;
}

/** Nejdál, kam auto od osy rampy uletí do strany: na rampě i ve vzduchu nejvýš `air.lat` za tik. */
export const stuntDrift = (): number => stuntReach().ticks * STUNT.air.lat;

// ---------------------------------------------------------------------------
// Hromada

/** Řady hromady odspodu: 3 → 2+1, 4 → 3+1, 5 → 3+2, 6 → 3+2+1 (horní krabice leží na spáře dvou spodních nebo na prostřední). */
const ROWS: Readonly<Record<number, readonly number[]>> = { 3: [2, 1], 4: [3, 1], 5: [3, 2], 6: [3, 2, 1] };
const rowsOf = (count: number): readonly number[] => ROWS[Math.max(3, Math.min(6, count))] as readonly number[];
const PITCH = STUNT.pile.box + STUNT.pile.gap;

/** Šířka hromady (spodní řada). */
export const pileWidth = (count: number): number => (rowsOf(count)[0] as number) * PITCH - STUNT.pile.gap;

/** Krabice hromady: fyzikální, nepevné (auto jimi projede a pravidlo nárazu je rozhodí), od tiku 0 živé. */
export function pileBodies(pile: StuntPile): BodyInit[] {
  const { box } = STUNT.pile;
  return rowsOf(pile.count).flatMap((count, row) =>
    Array.from({ length: count }, (_, k): BodyInit => ({
      role: 'target',
      kind: pile.kind,
      x: pile.x + ((2 * k - (count - 1)) * PITCH) / 2,
      y: row * box,
      z: pile.z,
      w: box,
      h: box,
      d: box,
      solid: false,
      physics: true,
      restitution: STUNT.restitution,
    })),
  );
}

// ---------------------------------------------------------------------------
// Stream `stunt`

/**
 * Stream `stunt`: o skok za posledním streamem simulace (`rounds`) – přesně stream, který by dostal podsystém `stunt`
 * připsaný na konec `SUBSYSTEMS` (`src/sim/rng.ts`, sdílený soubor; prosba v `integration.md`). `part` 1 = další skok
 * (tabulka rozptylu), takže nový los trati tabulkou nepohne a naopak.
 */
export function stuntRng(seed: number, part: 0 | 1 = 0): (from: number, to: number) => number {
  const stream = createStreams(seed).rounds.clone();
  for (let k = 0; k <= part; k += 1) stream.jump();
  return (from, to) => nextInt(stream, from, to);
}

/** Tabulka rozptylu trosek `[dx, dy, dz]` (jednotky za tik) pro semínko hry. */
export function stuntScatter(seed: number): [number, number, number][] {
  const int = stuntRng(seed, 1);
  const { dx, dy, dz } = STUNT.kick;
  return Array.from({ length: STUNT.scatterSize }, () => [int(-dx, dx), int(dy[0], dy[1]), int(-dz, dz)]);
}

function shuffle<T>(items: readonly T[], int: (from: number, to: number) => number): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = int(0, i);
    [copy[i], copy[j]] = [copy[j] as T, copy[i] as T];
  }
  return copy;
}

// ---------------------------------------------------------------------------
// Generátor

const kindSchema = z.string().min(1).max(64);

export const stuntTrackParams = z
  .object({
    difficulty: z.enum(STEER_DIFFICULTIES).default('normal'),
    lengthM: z.int().min(STUNT.lengthM.min).max(STUNT.lengthM.max).default(STUNT.lengthM.default),
    ramps: z.int().min(STUNT.ramps.min).max(STUNT.ramps.max).default(STUNT.ramps.default),
    piles: z.int().min(STUNT.piles.min).max(STUNT.piles.max).default(STUNT.piles.default),
    boxes: z.int().min(STUNT.boxes.min).max(STUNT.boxes.max).default(STUNT.boxes.default),
    /** Vozidlo z věty (model hráče). */
    vehicle: kindSchema.default(STUNT.kinds.vehicle),
    /** Věci v hromadách z věty: hromada `k` je z `things[k % length]`. */
    things: z.array(kindSchema).min(1).max(4).default([STUNT.kinds.thing]),
  })
  .strict();
export type StuntTrackParams = z.infer<typeof stuntTrackParams>;

const even = (value: number): number => value + (value & 1);

/** Délka úseku s rampou: rovinka, rampa, nejdelší skok, půlka auta a rezerva. */
export const rampSectionLength = (): number => even(STUNT.ramp.lead + stuntReach().landing + STEER.carD / 2 + STUNT.ramp.pad);
/** Délka úseku s hromadou. */
export const pileSectionLength = (): number => even(STUNT.pile.lead + STUNT.pile.box + STUNT.pile.exit);

function sectionWalls(near: number, far: number, center: number, width: number): BodyInit[] {
  const z0 = Math.floor((near + far) / 2);
  const offset = width / 2 + STEER.wallW / 2;
  const wall = (x: number): BodyInit => ({ role: 'obstacle', kind: 'tire-barrier', x, y: 0, z: z0, w: STEER.wallW, h: STEER.wallH, d: far - near, solid: true });
  return [wall(center - offset), wall(center + offset)];
}

/** `count` rovinek z `pool` (zamíchaných): různé, dokud stačí, pak znovu od začátku (víc úseků za jednou rovinkou). */
const take = (pool: readonly number[], count: number): number[] => Array.from({ length: count }, (_, j) => pool[j % pool.length] as number);

/**
 * Trať bez těles hry: okruh řízení s vloženými úseky s triky a rozmístění ramp a hromad. Úseky jdou za rovinky
 * (`minStraight`), každý na jinou, dokud rovinky stačí; jinak se na jednu rovinku vloží víc úseků za sebou. Hromada
 * jen za rovinku, za kterou i po všech vloženích skončí do `groundZ` – krabice Rapieru musí stát na jeho zemi.
 */
export function stuntTrackOf(seed: number, params: StuntTrackParams): { readonly level: ArcadeLevel; readonly layout: StuntLayout } {
  const base = steerPatternTrack(seed, steerTrack.params.parse({ difficulty: params.difficulty, lengthM: params.lengthM, rivals: false, turbo: false, topSpeed: STUNT.topSpeed, patterns: 1 })).level;
  const int = stuntRng(seed);
  const segments = steerSegments(base);
  const total = params.ramps * rampSectionLength() + params.piles * pileSectionLength();
  const pool = shuffle(
    segments.flatMap((segment, index) => (index < segments.length - 1 && segment.far - segment.near >= STUNT.minStraight && segment.far >= STUNT.firstAt ? [index] : [])),
    int,
  );
  // Rozjezd (40 m) je kandidát vždy a vejde se i s nejdelší sadou úseků, takže hromady místo mají vždy.
  const pileSpots = take(pool.filter((index) => (segments[index] as (typeof segments)[number]).far + total <= STUNT.groundZ), params.piles);
  const free = pool.filter((index) => !pileSpots.includes(index));
  const rampSpots = take(free.length > 0 ? free : pool, params.ramps);
  // Po trati; na téže rovince pořadí úseků losem.
  const sections = [...pileSpots.map((index) => ({ index, kind: 'pile' as const })), ...rampSpots.map((index) => ({ index, kind: 'ramp' as const }))]
    .map((section) => ({ ...section, order: int(0, 1000) }))
    .sort((a, b) => a.index - b.index || a.order - b.order);

  const drift = stuntDrift();
  const walls: BodyInit[] = [];
  const ramps: StuntRamp[] = [];
  const piles: StuntPile[] = [];
  const cuts: { readonly at: number; readonly length: number }[] = [];
  let inserted = 0;
  sections.forEach(({ index, kind }) => {
    const segment = segments[index] as (typeof segments)[number];
    const start = segment.far + inserted;
    const length = kind === 'ramp' ? rampSectionLength() : pileSectionLength();
    walls.push(...sectionWalls(start, start + length, segment.center, segment.width));
    if (kind === 'ramp') {
      const room = Math.max(0, Math.floor(segment.width / 2 - STUNT.ramp.w / 2 - drift - STEER.carW / 2 - STUNT.margin));
      const z0 = start + STUNT.ramp.lead;
      ramps.push({ x: segment.center + int(-room, room), z0, z1: z0 + STUNT.ramp.d, w: STUNT.ramp.w, h: STUNT.ramp.h });
    } else {
      const count = params.boxes;
      const room = Math.max(0, Math.floor(segment.width / 2 - pileWidth(count) / 2 - STUNT.pile.wallGap));
      piles.push({ x: segment.center + int(-room, room), z: start + STUNT.pile.lead + STUNT.pile.box / 2, count, kind: params.things[piles.length % params.things.length] as string });
    }
    cuts.push({ at: segment.far, length });
    inserted += length;
  });
  const shift = (z: number): number => cuts.reduce((sum, cut) => (cut.at < z ? sum + cut.length : sum), 0);
  const [player, ...rest] = base.bodies;
  const bodies: BodyInit[] = [{ ...(player as BodyInit), kind: params.vehicle }, ...rest.map((body) => ({ ...body, z: body.z + shift(body.z) })), ...walls];
  return { level: { bodies, length: base.length + inserted }, layout: { ramps, piles } };
}

/** Osa a šířka trati po úsecích mantinelů (celá šířka; rozcestí nedělí) – pro zhasínání trosek mimo trať a robota. */
export function stuntCourseOf(level: ArcadeLevel): SteerCourse {
  const segments = steerSegments(level);
  return { ends: segments.map((s) => s.far), centers: segments.map((s) => s.center), halfWidth: Math.floor((segments[0]?.width ?? 0) / 2), halfWidths: segments.map((s) => Math.floor(s.width / 2)) };
}

/** Limit tratě v sekundách: ideální čas × `limit.pct` % + `limit.slack`, v mezích pravidla `time_limit` a `P68_MAX_TICKS`. */
export function stuntSeconds(length: number): number {
  const ticks = Math.ceil((idealTicks(length, STUNT.topSpeed) * STUNT.limit.pct) / 100) + STUNT.limit.slack;
  return Math.max(10, Math.min(Math.floor(P68_MAX_TICKS / ARCADE_HZ), Math.ceil(ticks / ARCADE_HZ)));
}

/**
 * Tělesa a pravidla hry nad tratí `base` (hráč první, mantinely, cíl) a rozmístěním `layout`: počítadlo, předlohy
 * trosek (jedna na model), rampy a krabice hromad; volné sloty spawnu = krabic dohromady (rozpočet trosek hlídá
 * pravidlo `stunt_impact`, strop `STUNT_DEBRIS_MAX` drží počet krabic). Generátor i laboratorní testy staví tudy.
 */
export function stuntParts(base: ArcadeLevel, layout: StuntLayout, options: { readonly seed: number; readonly health?: number }): ModeParts {
  const [player, ...rest] = base.bodies;
  const hero = player as BodyInit;
  const { box } = STUNT.pile;
  const kinds = [...new Set(layout.piles.map((pile) => pile.kind))];
  const keeper: BodyInit = { role: 'thing', kind: hero.kind, x: 0, y: 0, z: 0, w: 1, h: 1, d: 1, solid: false, template: true };
  const templates = (kinds.length > 0 ? kinds : [STUNT.kinds.thing]).map(
    (kind): BodyInit => ({ role: 'target', kind, x: 0, y: 0, z: 0, w: box, h: box, d: box, solid: false, template: true, physics: true, restitution: STUNT.restitution, hp: STUNT.debrisLife }),
  );
  const rampBodies = layout.ramps.map((ramp): BodyInit => ({ role: 'platform', kind: STUNT.kinds.ramp, x: ramp.x, y: 0, z: (ramp.z0 + ramp.z1) / 2, w: ramp.w, h: ramp.h, d: ramp.z1 - ramp.z0, solid: false }));
  const head: BodyInit[] = [hero, keeper, ...templates];
  const firstBox = head.length + rest.length + rampBodies.length;
  let next = firstBox;
  const piles = layout.piles.map((pile) => {
    const bodies = pileBodies(pile);
    const ref = { first: next, count: bodies.length, template: STUNT_BODIES.firstTemplate + Math.max(0, kinds.indexOf(pile.kind)) };
    next += bodies.length;
    return { ref, bodies };
  });
  const boxes = piles.flatMap((pile) => pile.bodies);
  const level: ArcadeLevel = { bodies: [...head, ...rest, ...rampBodies, ...boxes], length: base.length, spawnSlots: boxes.length };
  const health = options.health ?? START_LIVES;
  const seconds = stuntSeconds(base.length);
  const keeperIndex = STUNT_BODIES.keeper;
  const course = stuntCourseOf(level);
  const rules: PieceRef[] = [
    { id: 'finish', params: {} },
    { id: 'stunt_crash', params: { keeper: keeperIndex } },
    // Náraz před zhasínáním: troska, která v tiku zhasne, svůj slot nové trosce téhož tiku nepředá (Rapier by jí nechal rotaci staré).
    { id: 'stunt_impact', params: { piles: piles.map((pile) => pile.ref), scatter: stuntScatter(options.seed), debrisMax: STUNT.debrisMax } },
    { id: 'stunt_debris', params: { track: course } },
    { id: 'out_of_health', params: {} },
    { id: 'time_limit', params: { seconds } },
    { id: 'score_bonus', params: { lives: health, limit: seconds * ARCADE_HZ, target: 0 } },
  ];
  const ramps = layout.ramps.map((ramp) => ({ ...ramp }));
  const pileSizes = piles.map((pile) => pile.ref.count);
  return {
    control: { id: 'stunt', params: { drive: { topSpeed: STUNT.topSpeed, drift: false }, keeper: keeperIndex, ramps, firstBox, piles: pileSizes } },
    // Parametry robota (T3): osa trati jako robot řízení (trasa po rozcestí), rampy, krabice hromad a počítadlo.
    bot: { id: 'stunt_bot', params: { topSpeed: STUNT.topSpeed, course: { ...course, centers: steerRoute(level).map((s) => s.center), halfWidths: steerRoute(level).map((s) => Math.floor(s.width / 2)) }, ramps, firstBox, piles: pileSizes, keeper: keeperIndex } },
    level,
    rules,
    issues: checkStuntLevel(level),
    health,
  };
}

/** Celá hra ze semínka a parametrů generátoru `stunt_track`. */
export function stuntPartsOf(seed: number, params: StuntTrackParams, health: number | undefined): ModeParts {
  const { level, layout } = stuntTrackOf(seed, params);
  return stuntParts(level, layout, { seed, ...(health === undefined ? {} : { health }) });
}

// ---------------------------------------------------------------------------
// Kontrola hratelnosti

/**
 * „Hratelné z konstrukce“ nad hotovou tratí; prázdné pole = hratelná. Přepočítá řízení (`checkSteerLevel` bez turba)
 * a navíc: 2–4 rampy, 2–4 hromady po 3–6 krabicích (nejvýš `STUNT_DEBRIS_MAX`), za každou rampou rovný dojezd delší
 * než nejdelší skok a drift ve vzduchu mezi mantinely, hromada nikdy přes celou šířku a mimo dráhu skoku, krabice na
 * zemi Rapieru a s předlohou, rampy i hromady mezi startem a cílem.
 */
export function checkStuntLevel(level: ArcadeLevel): string[] {
  const issues: string[] = [];
  const m = (units: number): string => `${(units / UNIT).toFixed(1)} m`;
  const segments = steerSegments(level);
  // Řízení bez turba a značek rampy (závod s triky je nemá): `fastest` počítá jen s rezervou turba navíc.
  issues.push(...checkSteerLevel(level, STUNT.topSpeed, undefined));
  const ramps = level.bodies.filter((body) => body.role === 'platform' && body.kind === STUNT.kinds.ramp);
  const boxes = level.bodies.filter((body) => body.physics === true && body.template !== true);
  const pileZs = [...new Set(boxes.map((body) => body.z))].sort((a, b) => a - b);
  if (ramps.length < STUNT.ramps.min || ramps.length > STUNT.ramps.max) issues.push(`the track has ${ramps.length} ramps, not ${STUNT.ramps.min}–${STUNT.ramps.max}`);
  if (pileZs.length < STUNT.piles.min || pileZs.length > STUNT.piles.max) issues.push(`the track has ${pileZs.length} piles, not ${STUNT.piles.min}–${STUNT.piles.max}`);
  if (boxes.length > STUNT_DEBRIS_MAX) issues.push(`${boxes.length} crates exceed the debris ceiling ${STUNT_DEBRIS_MAX}`);
  const player = level.bodies[0];
  const start = (player?.z ?? 0) + STEER.carD;
  const minPass = STEER.carW + 2 * STEER.clearance;
  const reach = stuntReach();
  const drift = stuntDrift();
  const covering = (near: number, far: number): typeof segments => segments.filter((s) => s.far > near && s.near < far);
  const zones: [number, number][] = [];

  for (const ramp of ramps) {
    const z0 = ramp.z - ramp.d / 2;
    const end = z0 + reach.landing + STEER.carD / 2;
    zones.push([z0 - STEER.carD, end]);
    if (z0 < start || end >= level.length) issues.push(`the ramp at ${m(z0)} lies outside the start and the finish`);
    const run = covering(z0 - STEER.carD, end);
    const host = run[0];
    if (host === undefined || run[run.length - 1]?.far === undefined || (run[run.length - 1] as (typeof segments)[number]).far < end || run.some((s) => s.center !== host.center)) {
      issues.push(`the ramp at ${m(z0)} has no straight landing for the longest jump (${m(reach.landing)})`);
      continue;
    }
    const half = Math.min(...run.map((s) => s.width)) / 2;
    if (Math.abs(ramp.x - host.center) + ramp.w / 2 + drift + STEER.carW / 2 > half) issues.push(`a jump from the ramp at ${m(z0)} can drift ${m(drift)} into the barrier`);
    if (ramp.h !== STUNT.ramp.h || ramp.d !== STUNT.ramp.d) issues.push(`the ramp at ${m(z0)} is not the standard ramp the jump was computed for`);
  }

  for (const z of pileZs) {
    const pile = boxes.filter((body) => body.z === z);
    const left = Math.min(...pile.map((body) => body.x - body.w / 2));
    const right = Math.max(...pile.map((body) => body.x + body.w / 2));
    const depth = Math.max(...pile.map((body) => body.d));
    if (pile.length < STUNT.boxes.min || pile.length > STUNT.boxes.max) issues.push(`the pile at ${m(z)} has ${pile.length} crates, not ${STUNT.boxes.min}–${STUNT.boxes.max}`);
    if (z < start || z >= level.length || Math.abs(z) > STUNT.groundZ || pile.some((body) => Math.abs(body.x) > STUNT.groundZ)) issues.push(`the pile at ${m(z)} lies outside the track or the physics ground`);
    for (const s of covering(z - depth / 2, z + depth / 2)) {
      const gap = Math.max(left - (s.center - s.width / 2), s.center + s.width / 2 - right);
      if (gap < minPass) issues.push(`the pile at ${m(z)} blocks the road – the widest gap is ${m(gap)}`);
    }
    if (zones.some(([near, far]) => z + depth / 2 > near && z - depth / 2 < far)) issues.push(`the pile at ${m(z)} lies on a ramp or its landing`);
    if (!level.bodies.some((body) => body.template === true && body.physics === true && body.kind === pile[0]?.kind)) issues.push(`the pile at ${m(z)} has no debris template`);
  }
  if (level.bodies.length + (level.spawnSlots ?? 0) > ARCADE_LIMITS.maxBodies) issues.push(`${level.bodies.length} bodies and ${level.spawnSlots ?? 0} spawn slots exceed ${ARCADE_LIMITS.maxBodies}`);
  return [...new Set(issues)];
}
