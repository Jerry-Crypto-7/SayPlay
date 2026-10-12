/**
 * Robot řidiče (P25F, T3) – věrohodný hráč pro ověření závodu.
 *
 * Svět vidí 8 tiků starý (`reactionTicks`), vlastní jízdu si dopočítá z toho,
 * co od té doby zmáčkl (ví, kam točil volantem). Drží ideální stopu: míří na
 * střed trati kus před sebou, takže schody zatáčky projíždí šikmo. Soupeře
 * před sebou objede stranou, kde je víc místa. Před zatáčkou, kterou by při
 * dnešní rychlosti nestihl, brzdí. Trať zná z osy (`course`, tatáž, po které
 * ovládání vede soupeře), soupeře čte z geometrie (role `enemy`).
 *
 * Plavba (P32F T1): s `dodge` uhýbá nejbližší překážce role `hazard` – kouli
 * dopočte kyvadlem jádra na dobu, kdy se s ní v `z` překryje, a vyhne se pásu,
 * kudy za tu dobu proletí. S `land` přistává: svou jízdu předpoví přesně
 * (`landControl`), nad plochu doletí ve výšce a pak sestupuje čím dál pomaleji.
 */

import { z } from 'zod';

import { AXIS_MAX, type ArcadeInput, BODY, BUTTON, type BotPiece, FLAG, HEADER, NO_INPUT, ROLE, UNIT, bodyBase, rampedSpeed } from '../contract';
import { GRAVITY } from '../kernel';
import { LAND, type LandCraft, STEER, type SteerCourse, centerAt, halfWidthAt, courseSchema, landControl, landParams, landGravityAt, type LandProgression } from './steer';

const REACTION = 8;
/** Kolik tiků jízdy dopředu míří na střed trati (+ délka vozidla). */
const LOOK_TICKS = 18;
/** Za kolik tiků chce srovnat boční odchylku. */
const SETTLE_TICKS = 6;
/** Soupeř je v cestě, když je do tolika před námi a bokem blíž než šířka auta s rezervou. */
const RIVAL_AHEAD = 22_000;
const RIVAL_SIDE = STEER.carW + 700;
/** Objíždí s bočním odstupem. */
const PASS_GAP = STEER.carW + 900;
/** Brzdí, když chybí víc než tolik bočního dosahu na cestu k cíli pohledu. */
const BRAKE_SLACK = 600;

const toward = (value: number, target: number, step: number): number => (value < target ? Math.min(target, value + step) : Math.max(target, value - step));

/** Jízda „teď“: viděný stav + vstupy, které v něm ještě nejsou (jako ovládání, bez turba a kolizí). */
function predict(state: Int32Array, player: number, recent: readonly ArcadeInput[], topSpeed: number, grip: number, brakeDrift: number, ramp: readonly number[] | undefined): { x: number; z: number; vx: number; vz: number } {
  const p = bodyBase(player);
  let x = state[p + BODY.x] as number;
  let z = state[p + BODY.z] as number;
  let vx = state[p + BODY.vx] as number;
  let vz = state[p + BODY.vz] as number;
  const top = rampedSpeed(topSpeed, z, ramp) + ((state[p + BODY.aux0] as number) > 0 ? STEER.boost : 0);
  for (const input of recent) {
    vz = (input.buttons & BUTTON.DOWN) !== 0 ? Math.max(0, vz - STEER.brake) : toward(vz, top, vz > top ? STEER.brake : STEER.accel);
    const target = Math.trunc((input.axis * STEER.latMax) / AXIS_MAX);
    vx = target !== 0 ? toward(vx, target, STEER.steerRate) : toward(vx, 0, (input.buttons & BUTTON.DOWN) !== 0 ? brakeDrift : grip);
    x += vx;
    z += vz;
  }
  return { x, z, vx, vz };
}

/** Kam mířit do strany: střed trati před sebou, nebo vedle soupeře, který je v cestě. */
function aimX(state: Int32Array, player: number, course: SteerCourse, x: number, z: number, look: number): number {
  const center = centerAt(course, z + look);
  // Místo do strany podle užšího z obou míst: objíždění ještě v zúžení nesmí vést do mantinelu.
  const room = Math.min(halfWidthAt(course, z), halfWidthAt(course, z + look)) - STEER.carW / 2 - STEER.clearance;
  let aim = center;
  const count = state[HEADER.bodyCount] as number;
  let nearest = Number.POSITIVE_INFINITY;
  for (let i = 0; i < count; i += 1) {
    if (i === player) continue;
    const base = bodyBase(i);
    if (((state[base + BODY.flags] as number) & FLAG.alive) === 0 || state[base + BODY.role] !== ROLE.enemy) continue;
    const ahead = (state[base + BODY.z] as number) - z;
    if (ahead <= -STEER.carD || ahead > RIVAL_AHEAD || ahead >= nearest) continue;
    const rx = state[base + BODY.x] as number;
    if (Math.abs(rx - aim) >= RIVAL_SIDE && Math.abs(rx - x) >= RIVAL_SIDE) continue;
    nearest = ahead;
    // Objet stranou, kde je u středu trati víc místa.
    const local = centerAt(course, state[base + BODY.z] as number);
    const left = rx - PASS_GAP;
    const right = rx + PASS_GAP;
    const leftOk = left >= local - room;
    const rightOk = right <= local + room;
    aim = leftOk && (!rightOk || rx - local >= 0) ? left : rightOk ? right : aim;
  }
  return Math.max(center - room, Math.min(center + room, aim));
}

// ---------------------------------------------------------------------------
// Uhýbání (plavba)

/** Překážku řeší do tolika před přídí; od ní drží bokem tolik navíc; okno překryvu rozšíří o tolik tiků. */
const DODGE_LOOK = 30 * UNIT;
const DODGE_GAP = 350;
const DODGE_TICKS = 2;

/**
 * Kam uhnout před nejbližší živou překážkou role `hazard`: okno tiků, kdy se
 * loď s ní překryje v `z`, poloha koule v něm dopočtená kyvadlem jádra
 * (`lead` tiků od viděného stavu dál) a zakázaný pás, kudy za tu dobu projde.
 * Míří na bližší volnou stranu pásu; když volná strana v kanálu není, brzdí.
 */
function dodgeAim(state: Int32Array, player: number, course: SteerCourse, now: { readonly x: number; readonly z: number; readonly vz: number }, lead: number, aim: number): { aim: number; brake: boolean } {
  const count = state[HEADER.bodyCount] as number;
  let hazard = -1;
  let nearest = Number.POSITIVE_INFINITY;
  for (let i = 0; i < count; i += 1) {
    const base = bodyBase(i);
    if (i === player || ((state[base + BODY.flags] as number) & FLAG.alive) === 0 || state[base + BODY.role] !== ROLE.hazard) continue;
    const hz = state[base + BODY.z] as number;
    const half = (state[base + BODY.d] as number) / 2;
    if (hz + half <= now.z - STEER.carD / 2 || hz - half - (now.z + STEER.carD / 2) > DODGE_LOOK || hz >= nearest) continue;
    nearest = hz;
    hazard = i;
  }
  if (hazard < 0) return { aim, brake: false };
  const base = bodyBase(hazard);
  const halfD = (state[base + BODY.d] as number) / 2;
  const vz = Math.max(1, now.vz);
  const t0 = Math.max(0, Math.floor((nearest - halfD - (now.z + STEER.carD / 2)) / vz) - DODGE_TICKS);
  const t1 = Math.ceil((nearest + halfD - (now.z - STEER.carD / 2)) / vz) + DODGE_TICKS;
  // Kyvadlo jako v jádře: posun, pak po `aux1` ticích úseku obrat.
  let x = state[base + BODY.x] as number;
  let vx = state[base + BODY.vx] as number;
  let leg = state[base + BODY.aux0] as number;
  const period = ((state[base + BODY.flags] as number) & FLAG.kinematic) !== 0 ? (state[base + BODY.aux1] as number) : 0;
  let lo = Number.POSITIVE_INFINITY;
  let hi = Number.NEGATIVE_INFINITY;
  for (let t = 1; t <= lead + t1; t += 1) {
    x += vx;
    if (period > 0) {
      leg += 1;
      if (leg >= period) {
        leg = 0;
        vx = -vx;
      }
    }
    if (t >= lead + t0) {
      lo = Math.min(lo, x);
      hi = Math.max(hi, x);
    }
  }
  if (lead + t1 < 1) lo = hi = x;
  const band = (state[base + BODY.w] as number) / 2 + STEER.carW / 2 + DODGE_GAP;
  lo -= band;
  hi += band;
  if (aim <= lo || aim >= hi) return { aim, brake: false };
  const center = centerAt(course, nearest);
  const room = course.halfWidth - STEER.carW / 2 - STEER.clearance;
  const sides = [lo, hi].filter((side) => side >= center - room && side <= center + room);
  if (sides.length === 0) return { aim, brake: true };
  return { aim: sides.reduce((best, side) => (Math.abs(side - now.x) < Math.abs(best - now.x) ? side : best)), brake: false };
}

// ---------------------------------------------------------------------------
// Přistání

/** Výška nad plochou, ve které letí, dokud nad ní není; sestup nejvýš a nakonec; boční rychlost nejvýš a u země. */
const LAND_BOT = {
  cruise: 14 * UNIT,
  maxDescent: 110,
  finalDescent: 18,
  maxVx: 150,
  lowVx: 30,
  low: 4 * UNIT,
  lowTilt: 4,
  /** Nad plochou = střed lodi aspoň tolik od hrany plochy. */
  padMargin: 1500,
} as const;

function landDecide(state: Int32Array, player: number, tick: number, recent: readonly ArcadeInput[], gravity: number, progression?: LandProgression): ArcadeInput {
  const p = bodyBase(player);
  const craft: LandCraft = { x: state[p + BODY.x] as number, y: state[p + BODY.y] as number, vx: state[p + BODY.vx] as number, vy: state[p + BODY.vy] as number, tilt: state[p + BODY.aux0] as number };
  recent.forEach((input, i) => {
    landControl(craft, input, gravity, tick + i, progression);
    craft.vy -= GRAVITY;
    craft.x += craft.vx;
    craft.y += craft.vy;
  });
  gravity = landGravityAt(gravity, craft.y, progression);
  const count = state[HEADER.bodyCount] as number;
  let pad = -1;
  for (let i = 0; i < count && pad < 0; i += 1) if (i !== player && state[bodyBase(i) + BODY.role] === ROLE.goal) pad = bodyBase(i);
  if (pad < 0) return NO_INPUT;
  const height = craft.y - ((state[pad + BODY.y] as number) + (state[pad + BODY.h] as number));
  const dx = (state[pad + BODY.x] as number) - craft.x;
  const over = Math.abs(dx) <= ((state[pad + BODY.w] as number) - LAND.craftW) / 2 - LAND_BOT.padMargin && Math.abs(craft.vx) <= LAND_BOT.lowVx;

  // Do strany: rychlost, kterou ještě ubrzdí (zhruba půl tahu na plném náklonu), náklon úměrný chybě.
  const thrust = Math.floor((gravity * LAND.thrustPct) / 100);
  const side = Math.floor((thrust * 500) / 1000);
  const low = height < LAND_BOT.low;
  const vxWant = Math.sign(dx) * Math.min(low ? LAND_BOT.lowVx : LAND_BOT.maxVx, Math.floor(Math.sqrt((side * Math.abs(dx)) / 2000)));
  const maxTilt = low ? LAND_BOT.lowTilt : LAND.maxTilt;
  const tilt = Math.max(-maxTilt, Math.min(maxTilt, vxWant - craft.vx));

  // Nahoru a dolů: k z rezervy tahu na plném náklonu, ať sestup ubrzdí s rezervou.
  const reserve = Math.floor((thrust * 866) / 1000) - gravity;
  const k = Math.ceil((LAND_BOT.maxDescent * 1500) / reserve);
  const above = over ? height : height - LAND_BOT.cruise;
  const vyWant = above > 0 ? -Math.min(LAND_BOT.maxDescent, LAND_BOT.finalDescent + Math.floor(above / k)) : Math.min(LAND_BOT.maxDescent, Math.floor(-above / k) + 1);
  const axis = Math.sign(tilt) * Math.ceil((Math.abs(tilt) * AXIS_MAX) / LAND.maxTilt);
  return { buttons: craft.vy < vyWant ? BUTTON.HOLD : 0, axis };
}

// ---------------------------------------------------------------------------

const botParams = z
  .object({
    topSpeed: z.int().min(150).max(360).default(STEER.topSpeed),
    drift: z.boolean().default(false),
    grip: z.int().min(4).max(20).optional(),
    brakeDrift: z.int().min(4).max(20).optional(),
    course: courseSchema.optional(),
    ramp: z.tuple([z.int(), z.int()]).optional(),
    /** Plavba (P32F): uhýbat překážkám role `hazard`. */
    dodge: z.boolean().optional(),
    /** Přistání (P32F): gravitace planety jako v ovládání. */
    land: landParams.optional(),
  })
  .strict();

export const steerBot: BotPiece<z.infer<typeof botParams>> = {
  id: 'steer_bot',
  params: botParams,
  roles: ['player', 'obstacle', 'enemy', 'collectible', 'goal', 'hazard'],
  reactionTicks: REACTION,
  cost: () => ({ bodies: 0, rules: 0 }),
  decide: ({ state, player, tick, recent }, params): ArcadeInput => {
    if (params.land !== undefined) return landDecide(state, player, tick, recent, params.land.gravity, params.land);
    if (params.course === undefined) return NO_INPUT;
    const now = predict(state, player, recent, params.topSpeed, params.grip ?? (params.drift ? STEER.driftGrip : STEER.grip), params.brakeDrift ?? params.grip ?? (params.drift ? STEER.driftGrip : STEER.grip), params.ramp);
    const look = Math.max(STEER.carD * 2, now.vz * LOOK_TICKS) + STEER.carD;
    let aim = aimX(state, player, params.course, now.x, now.z, look);
    let dodgeBrake = false;
    if (params.dodge === true) ({ aim, brake: dodgeBrake } = dodgeAim(state, player, params.course, now, recent.length, aim));
    const want = Math.max(-STEER.latMax, Math.min(STEER.latMax, Math.trunc((aim - now.x) / SETTLE_TICKS)));
    const axis = Math.trunc((want * AXIS_MAX) / STEER.latMax);
    // Brzda: boční cesta k cíli pohledu je delší, než stihne při dnešní rychlosti.
    const ticks = Math.floor(look / Math.max(1, now.vz));
    const reach = STEER.latMax * Math.max(0, ticks - Math.ceil(STEER.latMax / STEER.steerRate));
    const brake = dodgeBrake || (now.vz > STEER.topSpeed / 2 && Math.abs(aim - now.x) > reach + BRAKE_SLACK);
    return { buttons: brake ? BUTTON.DOWN : 0, axis };
  },
};
