/**
 * Robot řidiče (P25F, T3) – věrohodný hráč pro ověření závodu.
 *
 * Svět vidí 8 tiků starý (`reactionTicks`), vlastní jízdu si dopočítá z toho,
 * co od té doby zmáčkl (ví, kam točil volantem). Drží ideální stopu: míří na
 * střed trati kus před sebou, takže schody zatáčky projíždí šikmo. Soupeře
 * před sebou objede stranou, kde je víc místa. Před zatáčkou, kterou by při
 * dnešní rychlosti nestihl, brzdí. Trať zná z osy (`course`, tatáž, po které
 * ovládání vede soupeře), soupeře čte z geometrie (role `enemy`).
 */

import { z } from 'zod';

import { AXIS_MAX, type ArcadeInput, BODY, BUTTON, type BotPiece, FLAG, HEADER, NO_INPUT, ROLE, bodyBase } from '../contract';
import { STEER, type SteerCourse, centerAt, courseSchema } from './steer';

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
function predict(state: Int32Array, player: number, recent: readonly ArcadeInput[], topSpeed: number, grip: number): { x: number; z: number; vx: number; vz: number } {
  const p = bodyBase(player);
  let x = state[p + BODY.x] as number;
  let z = state[p + BODY.z] as number;
  let vx = state[p + BODY.vx] as number;
  let vz = state[p + BODY.vz] as number;
  const top = topSpeed + ((state[p + BODY.aux0] as number) > 0 ? STEER.boost : 0);
  for (const input of recent) {
    vz = (input.buttons & BUTTON.DOWN) !== 0 ? Math.max(0, vz - STEER.brake) : toward(vz, top, vz > top ? STEER.brake : STEER.accel);
    const target = Math.trunc((input.axis * STEER.latMax) / AXIS_MAX);
    vx = target !== 0 ? toward(vx, target, STEER.steerRate) : toward(vx, 0, grip);
    x += vx;
    z += vz;
  }
  return { x, z, vx, vz };
}

/** Kam mířit do strany: střed trati před sebou, nebo vedle soupeře, který je v cestě. */
function aimX(state: Int32Array, player: number, course: SteerCourse, x: number, z: number, look: number): number {
  const center = centerAt(course, z + look);
  const room = course.halfWidth - STEER.carW / 2 - STEER.clearance;
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

const botParams = z
  .object({ topSpeed: z.int().min(150).max(360).default(STEER.topSpeed), drift: z.boolean().default(false), course: courseSchema.optional() })
  .strict();

export const steerBot: BotPiece<z.infer<typeof botParams>> = {
  id: 'steer_bot',
  params: botParams,
  roles: ['player', 'obstacle', 'enemy', 'collectible', 'goal'],
  reactionTicks: REACTION,
  cost: () => ({ bodies: 0, rules: 0 }),
  decide: ({ state, player, recent }, params): ArcadeInput => {
    if (params.course === undefined) return NO_INPUT;
    const now = predict(state, player, recent, params.topSpeed, params.drift ? STEER.driftGrip : STEER.grip);
    const look = Math.max(STEER.carD * 2, now.vz * LOOK_TICKS) + STEER.carD;
    const aim = aimX(state, player, params.course, now.x, now.z, look);
    const want = Math.max(-STEER.latMax, Math.min(STEER.latMax, Math.trunc((aim - now.x) / SETTLE_TICKS)));
    const axis = Math.trunc((want * AXIS_MAX) / STEER.latMax);
    // Brzda: boční cesta k cíli pohledu je delší, než stihne při dnešní rychlosti.
    const ticks = Math.floor(look / Math.max(1, now.vz));
    const reach = STEER.latMax * Math.max(0, ticks - Math.ceil(STEER.latMax / STEER.steerRate));
    const brake = now.vz > STEER.topSpeed / 2 && Math.abs(aim - now.x) > reach + BRAKE_SLACK;
    return { buttons: brake ? BUTTON.DOWN : 0, axis };
  },
};
