/**
 * Robot závodu s triky (P68V T3) – věrohodný hráč pro ověření `stunt`.
 *
 * Jede jako robot řízení (`steer-bot.ts`, import): svět vidí `STEER.reactionTicks` starý, vlastní jízdu si dopočítá
 * ze vstupů, které od té doby vydal, a míří na osu trati kus před sebou. Navíc ví, kde jsou triky, a míří na ně
 * schválně (`aimedCourse`):
 * - **rampa** – od rovinky před ní až po konec úseku s dojezdem míří na osu rampy, najede na ni středem a skočí;
 * - **hromada** – dokud z ní stojí aspoň jedna krabice, míří na bod rozsahu krabic nejblíž ose a projede jí.
 * A **brzdí před ostrou zatáčkou** (`cornerAhead`): schod osy trati ≥ `STUNT_BOT.sharp` blízko před přídí a rychlost
 * nad `corner` – vedle brzdy robota řízení, který brzdí jen tam, kde by zatáčku jinak nestihl.
 *
 * Předpověď „teď“ počítá jako ovládání `stunt`: na rampě drží auto na ploše klínu, ve vzduchu letí gravitací jádra se
 * ztlumeným řízením a bez plynu, po nárazu je omráčené. Robot řízení pak dostane stav s touto předpovědí (a prázdné
 * `recent`) a osu trati s cíli místo os úseků – osu, řízení a jeho brzdu rozhodne on. Ve vzduchu robot nebrzdí
 * (ovládání brzdu nečte).
 *
 * **Slabý robot** (`weak`, `STUNT_WEAK`): týž robot se zpožděním reakce navíc (předpověď nezapočítá posledních
 * `lagTicks` vlastních vstupů, takže jedná podle starší polohy) a s chybou osy (pevný posun, který po `period` tikách
 * mění znaménko). V úzkých schodech zatáček naráží a prohrává.
 */

import { z } from 'zod';

import { ARCADE_LIMITS, AXIS_MAX, type ArcadeInput, type ArcadeState, BODY, BUTTON, type BotPiece, FLAG, UNIT, bodyBase, graceOf } from '../contract';
import { GRAVITY } from '../kernel';
import { STEER, type SteerCourse, courseSchema } from './steer';
import { steerBot } from './steer-bot';
import { STUNT, type StuntRamp, rampClimb, rampHeightAt, rampUnder } from './stunt-track';

/**
 * Na rampu a hromadu míří nejdřív `approach` před nimi, po rovince se stejnou osou trati a ne v jejích prvních `lead`.
 * Před schodem zatáčky aspoň `sharp` napříč, který přijde do `brakeTicks` tiků jízdy, zpomalí na `corner`.
 */
export const STUNT_BOT = { approach: 40 * UNIT, lead: 9 * UNIT, sharp: 1000, brakeTicks: 24, corner: 240 } as const;

/**
 * Slabý robot: kolik vlastních posledních vstupů v předpovědi nezapočítá (zpoždění reakce navíc; víc než
 * `STEER.reactionTicks` nejde – starší stav robot nevidí), o kolik ‰ osy se jeho řízení liší od toho, co chce,
 * a po kolika tikách chyba mění stranu. Na výchozí trati (340 m okruhu) prohraje 29/30 (10 semínek × 3 obtížnosti).
 */
export const STUNT_WEAK = { lagTicks: STEER.reactionTicks, axisError: 350, period: 50 } as const;

const index = z.int().min(0).max(ARCADE_LIMITS.maxBodies - 1);
const rampSchema = z.object({ x: z.int(), z0: z.int(), z1: z.int(), w: z.int().min(1), h: z.int().min(1) }).strict();

const botParams = z
  .object({
    topSpeed: z.int().min(150).max(360).default(STUNT.topSpeed),
    /** Osa trati po trase rozcestí (`stunt_track`, jako `steer_bot`). */
    course: courseSchema,
    ramps: z.array(rampSchema).max(STUNT.ramps.max),
    /** Krabice hromad: první a počty po sobě (jako ovládání `stunt`). */
    firstBox: index,
    piles: z.array(z.int().min(1).max(STUNT.boxes.max)).max(STUNT.piles.max),
    keeper: index,
    /** Slabý robot (`STUNT_WEAK`). */
    weak: z.boolean().optional(),
  })
  .strict();
export type StuntBotParams = z.infer<typeof botParams>;

const toward = (value: number, target: number, step: number): number => (value < target ? Math.min(target, value + step) : Math.max(target, value - step));
const clamp = (value: number, limit: number): number => Math.max(-limit, Math.min(limit, value));

interface Car {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
}

/** Boční rychlost, kterou vstup chce (jako ovládání). */
function lateral(input: ArcadeInput): number {
  if ((input.buttons & BUTTON.LEFT) !== 0) return -STEER.latMax;
  if ((input.buttons & BUTTON.RIGHT) !== 0) return STEER.latMax;
  return Math.trunc((clamp(input.axis, AXIS_MAX) * STEER.latMax) / AXIS_MAX);
}

/**
 * Jízda „teď“: viděný stav + vstupy, které v něm ještě nejsou – rampa, vzduch a omráčení jako ovládání `stunt`,
 * gravitace a dopad jako jádro. Nárazy do mantinelu a zpomalení hromadou nepředpovídá (ukáže je až další viděný stav).
 */
function predict(state: ArcadeState, player: number, recent: readonly ArcadeInput[], params: StuntBotParams): Car {
  const p = bodyBase(player);
  const car: Car = { x: state[p + BODY.x] as number, y: state[p + BODY.y] as number, z: state[p + BODY.z] as number, vx: state[p + BODY.vx] as number, vy: state[p + BODY.vy] as number, vz: state[p + BODY.vz] as number };
  let grace = graceOf(state, player);
  for (const input of recent) {
    grace = Math.max(0, grace - 1);
    const ramp = rampUnder(params.ramps, car.x, car.y, car.z);
    const target = lateral(input);
    if (grace === STUNT.crash.grace - 1) car.vz = Math.trunc((car.vz * STUNT.crash.keepPct) / 100);
    if (car.y > 0 && ramp < 0) {
      car.vx = clamp(toward(car.vx, Math.trunc((target * STUNT.air.lat) / STEER.latMax), STUNT.air.steerRate), STUNT.air.lat);
    } else if (grace > STUNT.crash.grace - STUNT.crash.stunTicks) {
      car.vx = toward(car.vx, 0, STEER.grip);
    } else {
      car.vz = (input.buttons & BUTTON.DOWN) !== 0 ? Math.max(0, car.vz - STEER.brake) : toward(car.vz, params.topSpeed, car.vz > params.topSpeed ? STEER.brake : STEER.accel);
      car.vx = target !== 0 ? toward(car.vx, target, STEER.steerRate) : toward(car.vx, 0, STEER.grip);
    }
    if (ramp >= 0) {
      const on = params.ramps[ramp] as StuntRamp;
      car.vx = clamp(car.vx, STUNT.air.lat);
      car.y = rampHeightAt(on, car.z);
      car.vy = GRAVITY + rampClimb(on, car.vz);
    }
    car.vy -= GRAVITY;
    car.x += car.vx;
    car.y += car.vy;
    car.z += car.vz;
    if (car.y <= 0) {
      car.y = 0;
      car.vy = 0;
    }
  }
  return car;
}

/** Cíl robota: rampa (střed klínu) nebo hromada (rozsah středů krabic napříč) v místě `z`. */
interface Aim {
  readonly z: number;
  readonly left: number;
  readonly right: number;
}

/** Rampy a hromady, ze kterých ve viděném stavu ještě stojí aspoň jedna krabice. */
function aimsOf(state: ArcadeState, params: StuntBotParams): Aim[] {
  const aims: Aim[] = params.ramps.map((ramp) => ({ z: ramp.z0, left: ramp.x, right: ramp.x }));
  let first = params.firstBox;
  for (const count of params.piles) {
    let left = Number.POSITIVE_INFINITY;
    let right = Number.NEGATIVE_INFINITY;
    let z = 0;
    for (let k = 0; k < count; k += 1) {
      const base = bodyBase(first + k);
      if (((state[base + BODY.flags] as number) & FLAG.alive) === 0) continue;
      left = Math.min(left, state[base + BODY.x] as number);
      right = Math.max(right, state[base + BODY.x] as number);
      z = state[base + BODY.z] as number;
    }
    if (left <= right) aims.push({ z, left, right });
    first += count;
  }
  return aims.sort((a, b) => a.z - b.z);
}

/**
 * Osa trati s cíli. Cíl leží v úseku s trikem; před ním je rovinka se stejnou osou i šířkou (generátor úsek vkládá
 * za rovinku a dává mu její osu a šířku). Od `lead` za začátkem té rovinky (nejdýl `approach` před cílem) do konce
 * úseku s trikem je osou `x` cíle: u rampy její střed, u hromady bod rozsahu krabic nejblíž ose (stačí trefit jednu).
 * Prvních `lead` rovinky zůstává skutečná osa – robot míří `look` před sebe, a dokud je ještě v užším schodu zatáčky
 * před rovinkou, cíl stranou by ho vedl do rohu mantinelu. Cíl, který by se do úseku nevešel, se do něj ořízne.
 */
export function aimedCourse(course: SteerCourse, aims: readonly Aim[]): SteerCourse {
  const half = (k: number): number => course.halfWidths?.[k] ?? course.halfWidth;
  const room = (k: number): number => half(k) - STEER.carW / 2 - STEER.clearance;
  const zones: { readonly from: number; readonly to: number; readonly x: number }[] = [];
  let floor = 0;
  for (const aim of aims) {
    const at = course.ends.findIndex((end) => aim.z < end);
    if (at < 0) continue;
    const center = course.centers[at] as number;
    const x = Math.max(center - room(at), Math.min(center + room(at), Math.max(aim.left, Math.min(aim.right, center))));
    let from = at;
    while (from - 1 >= floor && course.centers[from - 1] === center && half(from - 1) === half(at) && aim.z - (course.ends[from - 2] ?? 0) <= STUNT_BOT.approach) from -= 1;
    const near = from === 0 ? Number.NEGATIVE_INFINITY : (course.ends[from - 1] as number);
    zones.push({ from: from < at ? near + STUNT_BOT.lead : near, to: course.ends[at] as number, x });
    floor = at + 1;
  }
  const ends: number[] = [];
  const centers: number[] = [];
  const halfWidths: number[] = [];
  const push = (end: number, center: number, width: number): void => {
    ends.push(end);
    centers.push(center);
    halfWidths.push(width);
  };
  course.ends.forEach((end, k) => {
    const near = k === 0 ? Number.NEGATIVE_INFINITY : (course.ends[k - 1] as number);
    const zone = zones.find((candidate) => near < candidate.to && end > candidate.from);
    if (zone === undefined) push(end, course.centers[k] as number, half(k));
    else {
      if (zone.from > near) push(zone.from, course.centers[k] as number, half(k));
      push(end, zone.x, half(k));
    }
  });
  return { ...course, ends, centers, halfWidths };
}

/**
 * Brzda před ostrou zatáčkou: osa trati se do `brakeTicks` tiků jízdy před přídí posune o víc než `sharp` (schod
 * zatáčky) a auto jede rychleji než `corner` – zpomalí, aby schod projelo s rezervou bočního dosahu.
 */
function cornerAhead(course: SteerCourse, now: Car): boolean {
  if (now.vz <= STUNT_BOT.corner) return false;
  const front = now.z + STEER.carD / 2;
  const reach = front + now.vz * STUNT_BOT.brakeTicks;
  const at = course.ends.findIndex((end) => front < end);
  for (let k = Math.max(0, at); k < course.ends.length - 1 && (course.ends[k] as number) < reach; k += 1) {
    if (Math.abs((course.centers[k + 1] as number) - (course.centers[k] as number)) >= STUNT_BOT.sharp) return true;
  }
  return false;
}

export const stuntBot: BotPiece<StuntBotParams> = {
  id: 'stunt_bot',
  params: botParams,
  roles: ['player', 'obstacle', 'platform', 'target', 'goal'],
  reactionTicks: STEER.reactionTicks,
  cost: () => ({ bodies: 0, rules: 0 }),
  decide: ({ state, player, tick, recent }, params): ArcadeInput => {
    const weak = params.weak === true;
    const known = weak ? recent.slice(0, Math.max(0, recent.length - STUNT_WEAK.lagTicks)) : recent;
    const now = predict(state, player, known, params);
    // Robot řízení dostane stav s předpovědí a osu s cíli; vlastní předpověď už nepočítá (`recent` prázdné).
    const view = state.slice();
    const p = bodyBase(player);
    view[p + BODY.x] = now.x;
    view[p + BODY.z] = now.z;
    view[p + BODY.vx] = now.vx;
    view[p + BODY.vz] = now.vz;
    const course = aimedCourse(params.course, aimsOf(state, params));
    const steered = steerBot.decide({ state: view, player, tick, recent: [] }, steerBot.params.parse({ topSpeed: params.topSpeed, drift: false, course }));
    // Ve vzduchu brzda nic nedělá (ovládání ji nečte): robot ji nemačká.
    const grounded = now.y <= 0 || rampUnder(params.ramps, now.x, now.y, now.z) >= 0;
    const buttons = grounded && ((steered.buttons & BUTTON.DOWN) !== 0 || cornerAhead(params.course, now)) ? BUTTON.DOWN : 0;
    if (!weak) return { buttons, axis: steered.axis };
    const error = Math.floor(tick / STUNT_WEAK.period) % 2 === 0 ? STUNT_WEAK.axisError : -STUNT_WEAK.axisError;
    return { buttons, axis: clamp(steered.axis + error, AXIS_MAX) };
  },
};
