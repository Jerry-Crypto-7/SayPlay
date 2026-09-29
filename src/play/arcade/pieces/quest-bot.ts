/**
 * Robot úkolu (P32G T2) – věrohodný hráč pro ověření obou režimů.
 *
 * Svět vidí 8 tiků starý jako robot arény; vlastní polohu si dopočítá z toho,
 * co od té doby zmáčkl (`predict`), pronásledovatele posune o jejich rychlost.
 *
 * - Cíl: s `order` první otevřený, jinak nejbližší, u kterého stihne dojít a
 *   dodržet krok dřív, než ho pronásledovatel dostihne.
 * - U cíle stojí a drží „Use“. Po kroku pravidlo čeká na puštění – robot pustí
 *   na jeden tik, jakmile zámek uvidí; okno připravenosti hlídá pravidlo samo
 *   (nachystané držení obrátí, jakmile se okno otevře).
 * - Cestou obchází kameny: z 32 směrů bere nejbližší k cíli, který nevede do
 *   kamene ani do stěny.
 * - Když žádný cíl nestihne, nebo je pronásledovatel blízko, utíká směrem, kde
 *   bude za `FLEE_TICKS` od pronásledovatelů nejdál.
 */

import { z } from 'zod';

import { type ArcadeInput, BODY, BUTTON, type BotPiece, FLAG, HEADER, NO_INPUT, ROLE, UNIT, bodyBase, targetStateOf } from '../contract';
import { compiledInteractWhen, interactRecord, isLocked } from '../rules/interact';
import { ARENA, DIRECTIONS, axisOfDirection } from './arena';
import { predict } from './arena-bot';

const REACTION = 8;
/** Rezerva tiků mezi dokončeným krokem a dotykem pronásledovatele. */
const MARGIN = 12;
/** Horizont útěku a jeho rozlišení. */
const FLEE_TICKS = 40;
/** Sondy obcházení kamenů před hráčem. */
const PROBES = [700, 1500] as const;
/** Rezerva kolem kamene a u stěny. */
const CLEARANCE = 150;

const botParams = z.object({ half: z.int().min(5 * UNIT).max(40 * UNIT), interact: compiledInteractWhen.shape.interact }).strict();
type QuestBotParams = z.infer<typeof botParams>;

interface Box {
  readonly index: number;
  readonly x: number;
  readonly z: number;
  readonly w: number;
  readonly d: number;
}

const cheb = (a: { readonly x: number; readonly z: number }, b: { readonly x: number; readonly z: number }): number => Math.max(Math.abs(a.x - b.x), Math.abs(a.z - b.z));

/** Mezera mezi obrysy v rovině x/z – tatáž míra jako dosah pravidla. */
const gapOf = (me: { x: number; z: number }, size: number, box: Box): number =>
  Math.max(0, Math.abs(me.x - box.x) - Math.ceil((size + box.w) / 2), Math.abs(me.z - box.z) - Math.ceil((size + box.d) / 2));

function boxesOf(state: Int32Array, player: number, lag: number) {
  const count = state[HEADER.bodyCount] as number;
  const size = state[bodyBase(player) + BODY.w] as number;
  const rocks: Box[] = [];
  const chasers: Box[] = [];
  for (let i = 0; i < count; i += 1) {
    if (i === player) continue;
    const base = bodyBase(i);
    const flags = state[base + BODY.flags] as number;
    if ((flags & FLAG.alive) === 0) continue;
    const box = { index: i, x: state[base + BODY.x] as number, z: state[base + BODY.z] as number, w: state[base + BODY.w] as number, d: state[base + BODY.d] as number };
    if ((flags & FLAG.solid) !== 0) rocks.push(box);
    // Větší buňka arény hráče honí (`move_free`); kde bude teď, odhadne její rychlost.
    else if (state[base + BODY.role] === ROLE.enemy && box.w > size) {
      chasers.push({ ...box, x: box.x + (state[base + BODY.vx] as number) * lag, z: box.z + (state[base + BODY.vz] as number) * lag });
    }
  }
  return { size, rocks, chasers };
}

/** Tiky, než pronásledovatel dostihne hráče stojícího v `at` (za tik se v každé ose přiblíží nejvýš o `hunterSpeed`). */
function contactTicks(at: { x: number; z: number }, size: number, chasers: readonly Box[]): number {
  let best = Number.POSITIVE_INFINITY;
  for (const c of chasers) best = Math.min(best, (cheb(at, c) - Math.ceil((c.w + size) / 2)) / ARENA.hunterSpeed);
  return best;
}

/** Vede krok z `at` směrem `k` do kamene nebo do stěny? */
function blocked(at: { x: number; z: number }, k: number, size: number, rocks: readonly Box[], half: number): boolean {
  const dir = DIRECTIONS[k]!;
  const limit = half - size / 2;
  for (const reach of PROBES) {
    const x = at.x + (dir.dx * reach) / 1000;
    const z = at.z + (dir.dz * reach) / 1000;
    if (Math.abs(x) > limit || Math.abs(z) > limit) return true;
    if (rocks.some((r) => Math.abs(x - r.x) < (r.w + size) / 2 + CLEARANCE && Math.abs(z - r.z) < (r.d + size) / 2 + CLEARANCE)) return true;
  }
  return false;
}

/** Nejbližší volný směr k bodu `to` (osa pro `move_free`). */
function steer(me: { x: number; z: number }, to: { x: number; z: number }, size: number, rocks: readonly Box[], half: number): number {
  const dx = to.x - me.x;
  const dz = to.z - me.z;
  const length = Math.hypot(dx, dz) || 1;
  let best = -1;
  let bestDot = Number.NEGATIVE_INFINITY;
  for (let k = 0; k < 32; k += 1) {
    const dir = DIRECTIONS[k]!;
    const dot = (dir.dx * dx + dir.dz * dz) / length;
    if (dot > bestDot && !blocked(me, k, size, rocks, half)) {
      best = k;
      bestDot = dot;
    }
  }
  return axisOfDirection(best);
}

/** Útěk: směr, kde bude hráč za `FLEE_TICKS` od pronásledovatelů nejdál (ti jdou přímo za ním). */
function flee(me: { x: number; z: number }, size: number, chasers: readonly Box[], rocks: readonly Box[], half: number): number {
  const limit = half - size / 2;
  let best = -1;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (let k = 0; k < 32; k += 1) {
    const dir = DIRECTIONS[k]!;
    const x = Math.max(-limit, Math.min(limit, me.x + (dir.dx * ARENA.speed * FLEE_TICKS) / 1000));
    const z = Math.max(-limit, Math.min(limit, me.z + (dir.dz * ARENA.speed * FLEE_TICKS) / 1000));
    let score = Number.POSITIVE_INFINITY;
    for (const c of chasers) {
      const dx = x - c.x;
      const dz = z - c.z;
      const length = Math.hypot(dx, dz) || 1;
      const step = Math.min(length, ARENA.hunterSpeed * FLEE_TICKS);
      score = Math.min(score, cheb({ x, z }, { x: c.x + (dx * step) / length, z: c.z + (dz * step) / length }) - (c.w + size) / 2);
    }
    if (blocked(me, k, size, rocks, half)) score -= 4 * UNIT;
    if (score > bestScore) {
      best = k;
      bestScore = score;
    }
  }
  return axisOfDirection(best);
}

function decide(state: Int32Array, player: number, tick: number, recent: readonly ArcadeInput[], params: QuestBotParams): ArcadeInput {
  const { interact, half } = params;
  const lag = recent.length;
  const me = predict(state, player, recent);
  const { size, rocks, chasers } = boxesOf(state, player, lag);
  const final = interact.states - 1;
  const count = state[HEADER.bodyCount] as number;
  const open: Box[] = [];
  for (let i = 0; i < count; i += 1) {
    const base = bodyBase(i);
    if (i === player || state[base + BODY.role] !== interact.role || ((state[base + BODY.flags] as number) & FLAG.alive) === 0 || targetStateOf(state, i) >= final) continue;
    open.push({ index: i, x: state[base + BODY.x] as number, z: state[base + BODY.z] as number, w: state[base + BODY.w] as number, d: state[base + BODY.d] as number });
  }
  if (open.length === 0) return NO_INPUT;

  // Krok stojí `hold` tiků a zpoždění, než robot uvidí zámek a pustí.
  const work = interact.hold + REACTION + MARGIN;
  const travel = (t: Box): number => Math.max(0, gapOf(me, size, t) - interact.radius) / ARENA.speed + REACTION;
  const slack = (t: Box): number => contactTicks(t, size, chasers) - travel(t) - work;
  let goal: Box | undefined;
  if (interact.order === true) goal = open[0];
  else {
    let bestTravel = Number.POSITIVE_INFINITY;
    for (const t of open) {
      if (slack(t) < 0 || travel(t) >= bestTravel) continue;
      goal = t;
      bestTravel = travel(t);
    }
  }

  const here = goal !== undefined && gapOf(me, size, goal) <= interact.radius - CLEARANCE;
  if (goal === undefined || (here ? contactTicks(me, size, chasers) < work : slack(goal) < 0)) {
    return { buttons: 0, axis: flee(me, size, chasers, rocks, half) };
  }
  if (!here) return { buttons: 0, axis: steer(me, goal, size, rocks, half) };
  // Zámek po kroku: pustit, pokud robot od té doby ještě nepustil.
  const record = interactRecord(state);
  const released = recent.some((input) => (input.buttons & BUTTON.INTERACT) === 0);
  if (record.body === goal.index && isLocked(record) && !released) return NO_INPUT;
  void tick;
  return { buttons: BUTTON.INTERACT, axis: 0 };
}

export const questBot: BotPiece<QuestBotParams> = {
  id: 'quest_bot',
  params: botParams,
  roles: ['player', 'target', 'obstacle', 'enemy'],
  // Obal doplňků (`addon_bot`) počítá s 8 tiky u každého základního robota.
  reactionTicks: REACTION,
  cost: () => ({ bodies: 0, rules: 0 }),
  decide: ({ state, player, tick, recent }, params) => decide(state, player, tick, recent, params),
};
