/**
 * Robot úkolu (P32G T2) – věrohodný hráč pro ověření obou režimů.
 *
 * Svět vidí 8 tiků starý jako robot arény; vlastní polohu si dopočítá z toho,
 * co od té doby zmáčkl (`predict`), pronásledovatele posune o jejich rychlost.
 *
 * - Cíl: s `order` první otevřený, jinak nejbližší, ke kterému cestu i celé
 *   držení přehraje proti pronásledovatelům (jdou rovnou na hráče, po ochraně,
 *   kterou ještě prospí) a mezera k nim neklesne pod `PLAN.safe` (u cíle, kde už
 *   drží, pod `PLAN.stay`).
 * - U cíle stojí a drží „Use“. Po kroku pravidlo čeká na puštění – robot pustí
 *   na jeden tik, jakmile zámek uvidí; okno připravenosti hlídá pravidlo samo
 *   (nachystané držení obrátí, jakmile se okno otevře).
 * - Cestou obchází kameny: z 32 směrů bere nejbližší k cíli, který nevede do
 *   kamene ani do stěny.
 * - Když žádný cíl nestihne, uhýbá: ze směrů, které po `PLAN.horizon` tiků drží
 *   mezeru `PLAN.cap`, ten, který ho nejvíc přiblíží nejbližšímu cíli (obejde
 *   pronásledovatele obloukem); jinak ten s největší mezerou.
 */

import { z } from 'zod';

import { type ArcadeInput, BODY, BUTTON, type BotPiece, FLAG, HEADER, NO_INPUT, ROLE, UNIT, bodyBase, targetStateOf } from '../contract';
import { compiledInteractWhen, interactRecord, isLocked } from '../rules/interact';
import { ARENA, DIRECTIONS, axisOfDirection, chaseParams, directionOfAxis, graceLeft } from './arena';
import { predict } from './arena-bot';

const REACTION = 8;
/** Rezerva tiků držení navíc. */
const MARGIN = 12;
/** Sondy obcházení kamenů před hráčem. */
const PROBES = [700, 1500] as const;
/** Rezerva kolem kamene a u stěny; o tolik blíž než dosah robot k cíli dojde. */
const CLEARANCE = 150;
/**
 * Přehrávka po `sample` ticích; mezery (okraj k okraji) pro novou cestu, pro držení u cíle a pro uhýbání.
 * Uhýbání: v pásu `wallBand` u stěny stojí každých `wallCost` jednotek blíž tik náskoku, dosavadní
 * směr má bonus `keep` tiků.
 */
const PLAN = { sample: 5, horizon: 90, safe: 1500, stay: 500, cap: 4 * UNIT, wallBand: 4 * UNIT, wallCost: 50, keep: 15 } as const;

const botParams = z
  .object({
    half: z.int().min(5 * UNIT).max(40 * UNIT),
    interact: compiledInteractWhen.shape.interact,
    /** Pronásledovatelé útěku téhle rychlosti (jako ovládání `move_free`). */
    chase: chaseParams.optional(),
  })
  .strict();
type QuestBotParams = z.infer<typeof botParams>;

interface Point {
  readonly x: number;
  readonly z: number;
}

interface Box extends Point {
  readonly index: number;
  readonly w: number;
  readonly d: number;
}

interface Chaser extends Point {
  /** Součet polovin s hráčem: dotyk, když Chebyševova vzdálenost klesne pod tohle. */
  readonly reach: number;
}

/** Mezera mezi obrysy v rovině x/z – tatáž míra jako dosah pravidla. */
const gapOf = (me: Point, size: number, box: Box): number =>
  Math.max(0, Math.abs(me.x - box.x) - Math.ceil((size + box.w) / 2), Math.abs(me.z - box.z) - Math.ceil((size + box.d) / 2));

const distance = (a: Point, b: Point): number => Math.sqrt((a.x - b.x) ** 2 + (a.z - b.z) ** 2);

function bodiesOf(state: Int32Array, player: number, lag: number, interact: QuestBotParams['interact']) {
  const count = state[HEADER.bodyCount] as number;
  const size = state[bodyBase(player) + BODY.w] as number;
  const rocks: Box[] = [];
  const chasers: Chaser[] = [];
  const open: Box[] = [];
  for (let i = 0; i < count; i += 1) {
    if (i === player) continue;
    const base = bodyBase(i);
    const flags = state[base + BODY.flags] as number;
    if ((flags & FLAG.alive) === 0) continue;
    const role = state[base + BODY.role];
    const box = { index: i, x: state[base + BODY.x] as number, z: state[base + BODY.z] as number, w: state[base + BODY.w] as number, d: state[base + BODY.d] as number };
    if ((flags & FLAG.solid) !== 0) rocks.push(box);
    // Kde je pronásledovatel teď, odhadne jeho rychlost.
    else if (role === ROLE.chaser) chasers.push({ x: box.x + (state[base + BODY.vx] as number) * lag, z: box.z + (state[base + BODY.vz] as number) * lag, reach: (box.w + size) / 2 });
    else if (role === interact.role && targetStateOf(state, i) < interact.states - 1) open.push(box);
  }
  return { size, rocks, chasers, open };
}

/** Pronásledovatelé, jak je vede `move_free` s `chase`: rychlost, předstih a zbytek ochrany (tiky, které ještě stojí). */
interface Pursuit {
  readonly chasers: readonly Chaser[];
  readonly speed: number;
  readonly lead: number;
  readonly asleep: number;
}

/**
 * Nejmenší mezera (okraj k okraji po osách, jako dotyk v jádře) k pronásledovatelům,
 * když hráč dojde po přímce z `from` do `to` a pak stojí – celkem `ticks` tiků.
 * Pronásledovatelé míří tam, kde hráč bude (nejvýš `lead` tiků dopředu), jakmile
 * prospí ochranu. Přehrávka končí, jakmile mezera klesne na `floor`; konečné
 * polohy pronásledovatelů zůstanou v `at`.
 */
function clearance(from: Point, to: Point, ticks: number, pursuit: Pursuit, floor: number, at = pursuit.chasers.map((c) => ({ x: c.x, z: c.z }))): number {
  const length = distance(from, to);
  const vx = length === 0 ? 0 : ((to.x - from.x) * ARENA.speed) / length;
  const vz = length === 0 ? 0 : ((to.z - from.z) * ARENA.speed) / length;
  let clear = Number.POSITIVE_INFINITY;
  for (let t = 0; t <= ticks; t += PLAN.sample) {
    const walking = ARENA.speed * t < length;
    const walked = length === 0 ? 0 : Math.min(length, ARENA.speed * t) / length;
    const px = from.x + (to.x - from.x) * walked;
    const pz = from.z + (to.z - from.z) * walked;
    const moving = t === 0 ? 0 : Math.max(0, Math.min(PLAN.sample, t - pursuit.asleep));
    for (let j = 0; j < at.length; j += 1) {
      const c = at[j]!;
      // `Math.sqrt`, ne `Math.hypot`: robot plánuje každý tik a hypot je ve V8 řádově pomalejší.
      const gap = Math.sqrt((px - c.x) ** 2 + (pz - c.z) ** 2);
      const ahead = walking ? Math.min(pursuit.lead, Math.floor(gap / pursuit.speed)) : 0;
      const dx = px + vx * ahead - c.x;
      const dz = pz + vz * ahead - c.z;
      const aim = Math.sqrt(dx * dx + dz * dz);
      const run = Math.min(aim, moving * pursuit.speed);
      if (aim > 0) {
        c.x += (dx * run) / aim;
        c.z += (dz * run) / aim;
      }
      clear = Math.min(clear, Math.max(Math.abs(px - c.x), Math.abs(pz - c.z)) - pursuit.chasers[j]!.reach);
    }
    if (clear <= floor) return clear;
  }
  return clear;
}

/** Vede krok z `at` směrem `k` do kamene nebo do stěny? */
function blocked(at: Point, k: number, size: number, rocks: readonly Box[], half: number): boolean {
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
function steer(me: Point, to: Point, size: number, rocks: readonly Box[], half: number): number {
  const dx = to.x - me.x;
  const dz = to.z - me.z;
  const length = Math.sqrt(dx * dx + dz * dz) || 1;
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

function decide(state: Int32Array, player: number, recent: readonly ArcadeInput[], params: QuestBotParams): ArcadeInput {
  const { interact, half } = params;
  const lag = recent.length;
  const me = predict(state, player, recent);
  const { size, rocks, chasers, open } = bodiesOf(state, player, lag, interact);
  if (open.length === 0) return NO_INPUT;
  const pursuit: Pursuit = { chasers, speed: params.chase?.speed ?? 1, lead: params.chase?.lead ?? 0, asleep: Math.max(0, graceLeft(state) - lag) };
  const record = interactRecord(state);
  const reach = interact.radius - CLEARANCE;
  const limit = half - size / 2;
  const clamp = (value: number): number => Math.max(-limit, Math.min(limit, value));

  /** Kam dojít: po přímce k cíli, až je mezera v dosahu. */
  const standFor = (t: Box): Point => {
    const gap = gapOf(me, size, t);
    if (gap <= reach) return me;
    const dx = t.x - me.x;
    const dz = t.z - me.z;
    // Mezera po osách klesá rychlostí větší složky směru.
    const along = (gap - reach) / Math.max(Math.abs(dx), Math.abs(dz), 1);
    return { x: me.x + dx * along, z: me.z + dz * along };
  };
  /** Cesta k cíli a celé držení; rozdělané držení (viděné před `lag` tiky) se odečte. */
  const safe = (t: Box): boolean => {
    if (chasers.length === 0) return true;
    const to = standFor(t);
    const here = to === me;
    const held = here && record.body === t.index && !isLocked(record) ? record.held : 0;
    const ticks = Math.ceil(distance(me, to) / ARENA.speed) + interact.hold - held + REACTION + MARGIN;
    const floor = here ? PLAN.stay : PLAN.safe;
    return clearance(me, to, ticks, pursuit, floor) > floor;
  };

  const byDistance = [...open].sort((a, b) => gapOf(me, size, a) - gapOf(me, size, b));
  const goal = (interact.order === true ? [open[0]!] : byDistance).find(safe);
  if (goal !== undefined) {
    if (gapOf(me, size, goal) > reach) return { buttons: 0, axis: steer(me, goal, size, rocks, half) };
    // Zámek po kroku: pustit, pokud robot od té doby ještě nepustil.
    const released = recent.some((input) => (input.buttons & BUTTON.INTERACT) === 0);
    if (record.body === goal.index && isLocked(record) && !released) return NO_INPUT;
    return { buttons: BUTTON.INTERACT, axis: 0 };
  }

  // Uhýbání: ze směrů, které drží mezeru `cap`, ten, po kterém bude náskok k některému cíli největší
  // (náskok = kolik tiků pronásledovatel k cíli jde déle než hráč); jinak největší mezera.
  // Pás u stěny náskok snižuje (u stěny není kam uhnout) a dosavadní směr ho zvyšuje – jinak robot
  // mezi dvěma skoro stejnými směry kmitá na místě, než ho dostihnou.
  const last = directionOfAxis(recent.at(-1)?.axis ?? 0);
  let best = -1;
  let bestClear = Number.NEGATIVE_INFINITY;
  let bestLead = Number.NEGATIVE_INFINITY;
  for (let k = 0; k < 32; k += 1) {
    if (blocked(me, k, size, rocks, half)) continue;
    const dir = DIRECTIONS[k]!;
    const to = { x: clamp(me.x + (dir.dx * ARENA.speed * PLAN.horizon) / 1000), z: clamp(me.z + (dir.dz * ARENA.speed * PLAN.horizon) / 1000) };
    const at = chasers.map((c) => ({ x: c.x, z: c.z }));
    const clear = clearance(me, to, PLAN.horizon, pursuit, Math.min(bestClear, PLAN.cap - 1), at);
    if (clear < PLAN.cap ? bestClear >= PLAN.cap || clear <= bestClear : false) continue;
    let lead = Number.NEGATIVE_INFINITY;
    for (const t of open) lead = Math.max(lead, Math.min(...at.map((c) => distance(c, t) / pursuit.speed)) - distance(to, t) / ARENA.speed);
    lead -= Math.max(0, PLAN.wallBand - (limit - Math.max(Math.abs(to.x), Math.abs(to.z)))) / PLAN.wallCost;
    if (k === last) lead += PLAN.keep;
    if (clear >= PLAN.cap && bestClear >= PLAN.cap && lead <= bestLead) continue;
    best = k;
    bestClear = clear;
    bestLead = lead;
  }
  return { buttons: 0, axis: axisOfDirection(best) };
}

export const questBot: BotPiece<QuestBotParams> = {
  id: 'quest_bot',
  params: botParams,
  roles: ['player', 'target', 'obstacle', 'chaser'],
  // Obal doplňků (`addon_bot`) počítá s 8 tiky u každého základního robota.
  reactionTicks: REACTION,
  cost: () => ({ bodies: 0, rules: 0 }),
  decide: ({ state, player, recent }, params) => decide(state, player, recent, params),
};
