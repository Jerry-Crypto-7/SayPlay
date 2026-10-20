/**
 * Robot vytlačování (P54C T12): drží si odstup od okraje, uhýbá výpadům soupeřů a soupeře tlačí k okraji. Vybere
 * soupeře, kterého má nejblíž k bodu výpadu, postaví se za něj na straně středu ringu (na přímce střed → soupeř)
 * a vypadne, když soupeř leží před ním směrem k okraji a výpad hrdinu sám za okraj neodnese. Vidí stav o reakci
 * starší; směr a výpad si dopočítá z vlastních vstupů, které stav ještě neukazuje (`lungeStep`), polohy těl
 * posune o jejich rychlost.
 */

import { z } from 'zod';

import { type ArcadeInput, type ArcadeObservation, type ArcadeState, BODY, BUTTON, type BotPiece, FLAG, NO_INPUT, bodyBase } from '../contract';
import { DIRECTIONS, arenaAxis, axisOfDirection, directionToward } from './arena';
import { behaviourPhaseOf, telegraphOf } from './behaviours';
import { length } from './behaviours/flanker';
import { PUSH, PUSH_BODIES, lungeStep, mindOf, ringAt, rivalsOf } from './push-ring';

const botParams = z.object({}).strict();
export type PushBotParams = z.infer<typeof botParams>;

/** Dotyk hrdiny a soupeře (vzdálenost středů). */
const CONTACT = (PUSH.hero + PUSH.rival) / 2;
/** Kam výpad hrdinu sám odnese (j): výpad a dobrzdění z `speed`. */
const LUNGE_REACH = PUSH.lunge.speed * PUSH.lunge.ticks + Math.ceil((PUSH.speed * PUSH.speed) / (2 * PUSH.brake));

export const PUSH_BOT = {
  /** Od okraje drží hrdina aspoň tolik (j); konec výpadu aspoň `lungeEdge`. */
  edge: 1500,
  lungeEdge: 700,
  /** Uhne, když leží blíž čáře výpadu soupeře. */
  clearance: 1400,
  /** Mezera mezi hrdinou a soupeřem před výpadem: nejmíň a nejvíc (j). */
  gap: { min: 300, max: 2000 },
  /** Výpad, když soupeř leží před hrdinou směrem k okraji (kosinus × 1000) a hrdina stojí do `near` od bodu výpadu. */
  aligned: 920,
  near: 600,
  /** Uprostřed stačí stát. */
  home: 600,
} as const;

interface Point {
  readonly x: number;
  readonly z: number;
}

const alive = (state: ArcadeState, body: number): boolean => ((state[bodyBase(body) + BODY.flags] as number) & FLAG.alive) !== 0;
/** Poloha tělesa posunutá o jeho rychlost × `lag` tiků. */
function ahead(state: ArcadeState, body: number, lag: number): Point {
  const base = bodyBase(body);
  return { x: (state[base + BODY.x] as number) + (state[base + BODY.vx] as number) * lag, z: (state[base + BODY.z] as number) + (state[base + BODY.vz] as number) * lag };
}

/** Vzdálenost bodu `p` od úsečky `a → b`. */
function segmentGap(p: Point, a: Point, b: Point): number {
  const ux = b.x - a.x;
  const uz = b.z - a.z;
  const span = ux * ux + uz * uz;
  const t = span === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * ux + (p.z - a.z) * uz) / span));
  return length(p.x - Math.round(a.x + ux * t), p.z - Math.round(a.z + uz * t));
}

/** Uhnutí před soupeřem, který varuje nebo vyrazil a jehož dráha vede přes hrdinu; `null` = není kam uhýbat. */
function dodgeOf(state: ArcadeState, hero: Point): ArcadeInput | null {
  for (const rival of rivalsOf(state)) {
    const phase = behaviourPhaseOf(state, mindOf(rival));
    if (phase !== 'telegraph' && phase !== 'act') continue;
    const from = ahead(state, rival, 0);
    let to: Point;
    if (phase === 'telegraph') to = (telegraphOf(state, mindOf(rival)) as { aim: Point }).aim;
    else {
      const base = bodyBase(rival);
      const vx = state[base + BODY.vx] as number;
      const vz = state[base + BODY.vz] as number;
      const speed = length(vx, vz);
      if (speed === 0) continue;
      to = { x: from.x + Math.trunc((vx * 2500) / speed), z: from.z + Math.trunc((vz * 2500) / speed) };
    }
    if (segmentGap(hero, from, to) > PUSH_BOT.clearance) continue;
    // Kolmo na dráhu, na stranu blíž středu ringu.
    const ux = to.x - from.x;
    const uz = to.z - from.z;
    const left = { x: -uz, z: ux };
    const step = (sign: number): Point => ({ x: hero.x + Math.sign(sign) * left.x, z: hero.z + Math.sign(sign) * left.z });
    const side = length(step(1).x, step(1).z) <= length(step(-1).x, step(-1).z) ? 1 : -1;
    return { axis: arenaAxis(side * left.x, side * left.z), buttons: 0 };
  }
  return null;
}

/** Bod výpadu proti soupeři v `rival`: za ním na přímce střed → soupeř, s mezerou, po které výpad hrdinu nevynese ven. */
export function pushPoint(rival: Point, hero: Point, ring: number): { readonly at: Point; readonly out: Point } {
  const r = length(rival.x, rival.z);
  // Soupeř uprostřed nemá směr k okraji: tlačí se tam, kam od hrdiny leží.
  const away = r >= 300 ? { x: rival.x, z: rival.z } : { x: rival.x - hero.x, z: rival.z - hero.z };
  const size = Math.max(1, length(away.x, away.z));
  const out = { x: (away.x * 1000) / size, z: (away.z * 1000) / size };
  // Hrdina po výpadu (dotyk + mezera + dosah výpadu dál) musí zůstat `lungeEdge` před okrajem.
  const gap = Math.max(PUSH_BOT.gap.min, Math.min(PUSH_BOT.gap.max, r + LUNGE_REACH - CONTACT - (ring - PUSH_BOT.lungeEdge)));
  const back = CONTACT + gap;
  return { at: { x: Math.round(rival.x - (out.x * back) / 1000), z: Math.round(rival.z - (out.z * back) / 1000) }, out };
}

export function pushDecide(observation: ArcadeObservation): ArcadeInput {
  const { state, player, recent } = observation;
  if (!alive(state, PUSH_BODIES.hero)) return NO_INPUT;
  let facing = state[bodyBase(player) + BODY.aux0] as number;
  let lunge = state[bodyBase(player) + BODY.aux1] as number;
  for (const input of recent) ({ facing, lunge } = lungeStep(facing, lunge, input));
  // Výpad jede sám, osa se v něm nečte.
  if (lunge > 0) return NO_INPUT;
  const lag = recent.length;
  const hero = ahead(state, PUSH_BODIES.hero, lag);
  const ring = ringAt(state, observation.tick + lag);
  const fromCenter = length(hero.x, hero.z);
  if (fromCenter > ring - PUSH_BOT.edge) return { axis: arenaAxis(-hero.x, -hero.z), buttons: 0 };
  const dodge = dodgeOf(state, hero);
  if (dodge !== null) return dodge;

  let best: { readonly rival: Point; readonly at: Point; readonly out: Point; readonly cost: number } | null = null;
  for (const body of rivalsOf(state)) {
    const rival = ahead(state, body, lag);
    const { at, out } = pushPoint(rival, hero, ring);
    // Blízký bod výpadu, a soupeř blíž okraji.
    const cost = length(at.x - hero.x, at.z - hero.z) + (ring - length(rival.x, rival.z));
    if (best === null || cost < best.cost) best = { rival, at, out, cost };
  }
  if (best === null) return fromCenter > PUSH_BOT.home ? { axis: arenaAxis(-hero.x, -hero.z), buttons: 0 } : NO_INPUT;

  const { rival, at, out } = best;
  const dx = rival.x - hero.x;
  const dz = rival.z - hero.z;
  const gap = Math.max(1, length(dx, dz));
  const cos = (dx * out.x + dz * out.z) / gap;
  const there = length(at.x - hero.x, at.z - hero.z) <= PUSH_BOT.near;
  if (there && cos >= PUSH_BOT.aligned) {
    const direction = directionToward(dx, dz);
    const dir = DIRECTIONS[direction] as { readonly dx: number; readonly dz: number };
    const end = { x: hero.x + Math.trunc((dir.dx * LUNGE_REACH) / 1000), z: hero.z + Math.trunc((dir.dz * LUNGE_REACH) / 1000) };
    const safe = length(end.x, end.z) <= ring - PUSH_BOT.lungeEdge;
    if (safe && lunge === 0 && facing === direction) return { axis: axisOfDirection(direction), buttons: BUTTON.TAP };
    // Natočit se k soupeři (a dojít), výpad až další tik.
    return { axis: axisOfDirection(direction), buttons: 0 };
  }
  // K bodu výpadu; leží-li soupeř na cestě (hrdina je od středu za ním), obejít ho bokem.
  let goal = at;
  if (segmentGap(rival, hero, at) < CONTACT + 300) {
    const side = -out.z * (hero.x - rival.x) + out.x * (hero.z - rival.z) >= 0 ? 1 : -1;
    const around = CONTACT + 900;
    goal = { x: Math.round(rival.x + (side * -out.z * around) / 1000), z: Math.round(rival.z + (side * out.x * around) / 1000) };
  }
  return { axis: arenaAxis(goal.x - hero.x, goal.z - hero.z), buttons: 0 };
}

export const pushBot: BotPiece<PushBotParams> = {
  id: 'push_bot',
  params: botParams,
  roles: ['player', 'thing', 'enemy'],
  reactionTicks: 8,
  cost: () => ({ bodies: 0, rules: 0 }),
  decide: pushDecide,
};
