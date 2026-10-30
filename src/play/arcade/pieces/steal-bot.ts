/**
 * Robot krádeže (P66 T7): s nákladem (plným, nebo když už nic neleží) běží rovnou domů, jinak jde pro ležící kořist.
 *
 * **Kdy sebrat:** kořist leží vpředu v cizí základně, strážci hlídají řady za ní a zloděje bez kořisti nehoní. Robot
 * proto dojde na stanoviště kousek pod kořistí (dotyk by ji sebral) a čeká, až budou všichni strážci v tiku sebrání
 * dost daleko (`safe`, u strážce velké kořisti víc – je rychlejší); pak skočí pro ni a utíká domů. Strážci honí
 * pomaleji, než zloděj s kořistí běží, takže kdo má náskok, uteče. Ze všech ležících vezme kořist, u které je sebrání
 * nejdřív bezpečné. Strážce blíž než `wary` navíc odpuzuje s úkrokem na stranu, kam robot chce. Vidí stav o reakci
 * starší: polohy posune o rychlost těl za tu dobu, hlídku strážců dopočítá (`patrolAt`).
 *
 * **Práh chyb:** `wary` = jak daleko strážce bere vážně. Slabý robot (`wary` 0) strážce nevidí, nečeká a bere
 * nejbližší kořist hned – sebere ji strážci pod nosem a prohraje (test T7: strážce, který nikoho nedohoní, by
 * z krádeže udělal procházku).
 */

import { z } from 'zod';

import { ARCADE_LIMITS, type ArcadeInput, type ArcadeObservation, BODY, type BotPiece, NO_INPUT, bodyBase } from '../contract';
import { arenaAxis } from './arena';
import { LOOT, STEAL, capacityOf, chasing, guardsOf, length, lootIn } from './steal';

export const STEAL_BOT = {
  /** Strážce blíž než tohle (j) robot odpuzuje. */
  wary: 1600,
  /** Váha odpuzení a bočního úkroku od strážce na samém dotyku (‰ tahu k cíli). */
  push: 1800,
  side: 1400,
  /** Kam strážce dojde: rychlost × tolik tiků navíc k reakci (odpuzení). */
  predict: 8,
  /** Od stěny drží odstup (j). */
  wall: 500,
  /** Stanoviště: tolik (j) pod kořistí; blíž než `still` k němu robot stojí. */
  stage: 1300,
  still: 400,
  /** Sebrání je bezpečné, když je každý strážce v tiku sebrání dál než tohle (j) od kořisti; strážce velké kořisti dál. */
  safe: 2700,
  bossSafe: 3300,
} as const;

const botParams = z
  .object({
    hooks: z.int().min(1).max(ARCADE_LIMITS.maxBodies - 1),
    wary: z.int().min(0).max(10_000).optional(),
  })
  .strict();
export type StealBotParams = z.infer<typeof botParams>;

interface Point {
  readonly x: number;
  readonly z: number;
}

const ahead = (state: Int32Array, body: number, lag: number): Point => {
  const base = bodyBase(body);
  return { x: (state[base + BODY.x] as number) + (state[base + BODY.vx] as number) * lag, z: (state[base + BODY.z] as number) + (state[base + BODY.vz] as number) * lag };
};

/** Kde napříč bude hlídkující strážce za `ticks` tiků: jde rychlostí `vx` a od konců hlídky (`±reach`) se odráží. */
export function patrolAt(x: number, vx: number, ticks: number, reach: number): number {
  if (reach <= 0 || vx === 0) return x;
  const span = 4 * reach;
  // Hlídka tam a zpět rozvinutá do jedné dráhy délky 4 × reach: tam (x + reach), zpět (3 × reach − x).
  const clamped = Math.max(-reach, Math.min(reach, x));
  const unfolded = vx > 0 ? clamped + reach : 3 * reach - clamped;
  const at = (unfolded + Math.abs(vx) * ticks) % span;
  return at <= 2 * reach ? at - reach : 3 * reach - at;
}

/**
 * Rezerva sebrání kořisti v `loot` za `ticks` tiků (j): nejmenší vzdálenost strážce od kořisti v tu chvíli minus
 * bezpečná vzdálenost. Hlídkující strážce posune po hlídce, honícího tam, kde je – takový sebrání nedovolí.
 */
export function grabMargin(state: Int32Array, lag: number, loot: Point, ticks: number): number {
  let worst = Number.POSITIVE_INFINITY;
  for (const guard of guardsOf(state)) {
    const boss = (state[bodyBase(guard) + BODY.w] as number) > STEAL.guard.w;
    const size = boss ? STEAL.boss : STEAL.guard;
    const at = ahead(state, guard, lag);
    const x = chasing(state, guard) ? at.x : patrolAt(at.x, state[bodyBase(guard) + BODY.vx] as number, ticks, Math.min(size.range, STEAL.half - Math.ceil(size.w / 2)));
    worst = Math.min(worst, length(x - loot.x, at.z - loot.z) - (boss ? STEAL_BOT.bossSafe : STEAL_BOT.safe) - (chasing(state, guard) ? STEAL.guard.keep : 0));
  }
  return worst;
}

/** Kam robot jde a zda tam čeká. `null` = nic k práci. */
function targetOf(state: Int32Array, params: StealBotParams, lag: number, hero: Point): { readonly at: Point; readonly waiting: boolean } | null {
  const carried = lootIn(state, LOOT.carried).length;
  const free = lootIn(state, LOOT.free);
  const edge = STEAL.home.halfW - STEAL.hero.w;
  if (carried > 0 && (carried >= capacityOf(state, params.hooks) || free.length === 0)) return { at: { x: Math.max(-edge, Math.min(edge, hero.x)), z: STEAL.home.z }, waiting: false };
  if (free.length === 0) return null;
  const wary = params.wary ?? STEAL_BOT.wary;
  let best: { readonly at: Point; readonly margin: number; readonly far: number } | null = null;
  for (const loot of free) {
    const at = ahead(state, loot, 0);
    const far = length(at.x - hero.x, at.z - hero.z);
    // Slabý robot: nejbližší kořist, sebrat hned.
    const margin = wary === 0 ? 0 : grabMargin(state, lag, at, Math.ceil(Math.min(far, STEAL_BOT.stage + STEAL_BOT.still) / STEAL.speed));
    const better = best === null || (wary === 0 ? far < best.far : margin > best.margin + 300 || (margin >= best.margin - 300 && far < best.far));
    if (better) best = { at, margin, far };
  }
  if (best === null) return null;
  if (wary === 0) return { at: best.at, waiting: false };
  const stage = { x: best.at.x, z: best.at.z - STEAL_BOT.stage };
  const staged = length(stage.x - hero.x, stage.z - hero.z) <= STEAL_BOT.stage;
  if (staged && best.margin >= 0) return { at: best.at, waiting: false };
  return { at: stage, waiting: true };
}

export function stealDecide(observation: ArcadeObservation, params: StealBotParams): ArcadeInput {
  const { state, player, recent } = observation;
  const lag = recent.length;
  const hero = ahead(state, player, lag);
  const target = targetOf(state, params, lag, hero);
  if (target === null) return NO_INPUT;
  const wary = params.wary ?? STEAL_BOT.wary;
  const gx = target.at.x - hero.x;
  const gz = target.at.z - hero.z;
  const gap = length(gx, gz);
  // U stanoviště stát (dokud k němu nejde strážce); u cíle dojít.
  const there = gap < (target.waiting ? STEAL_BOT.still : 1);
  const wantX = there ? 0 : Math.trunc((gx * 1000) / gap);
  const wantZ = there ? 0 : Math.trunc((gz * 1000) / gap);
  let sx = wantX;
  let sz = wantZ;
  const fleeing = lootIn(state, LOOT.carried).length > 0;
  for (const guard of wary === 0 ? [] : guardsOf(state)) {
    const at = ahead(state, guard, lag + STEAL_BOT.predict);
    // S kořistí utíká domů: strážce za zády ho neodkloní (úhyb by ho jen zdržel), jen ten, kdo je v cestě.
    if (fleeing && at.z >= hero.z) continue;
    const dx = hero.x - at.x;
    const dz = hero.z - at.z;
    const d = length(dx, dz);
    if (d >= wary) continue;
    const ux = d === 0 ? 0 : Math.trunc((dx * 1000) / d);
    const uz = d === 0 ? -1000 : Math.trunc((dz * 1000) / d);
    const weight = Math.trunc(((wary - d) * 1000) / wary);
    sx += Math.trunc((ux * weight * STEAL_BOT.push) / 1_000_000);
    sz += Math.trunc((uz * weight * STEAL_BOT.push) / 1_000_000);
    // Úkrok kolmo od strážce na stranu, kam robot chce; na přímce k cíli ke středu hřiště.
    const dot = -uz * wantX + ux * wantZ;
    const sign = dot > 0 ? 1 : dot < 0 ? -1 : hero.x > 0 ? (uz > 0 ? 1 : -1) : uz > 0 ? -1 : 1;
    sx += Math.trunc((sign * -uz * weight * STEAL_BOT.side) / 1_000_000);
    sz += Math.trunc((sign * ux * weight * STEAL_BOT.side) / 1_000_000);
  }
  const edge = STEAL.half - STEAL.hero.w / 2 - STEAL_BOT.wall;
  if (hero.x > edge && sx > 0) sx = 0;
  if (hero.x < -edge && sx < 0) sx = 0;
  const end = STEAL.length - STEAL.hero.w / 2 - STEAL_BOT.wall;
  if (hero.z > end && sz > 0) sz = 0;
  if (hero.z < -end && sz < 0) sz = 0;
  if (sx === 0 && sz === 0) return there ? NO_INPUT : { axis: arenaAxis(wantX, wantZ), buttons: 0 };
  return { axis: arenaAxis(sx, sz), buttons: 0 };
}

export const stealBot: BotPiece<StealBotParams> = {
  id: 'steal_bot',
  params: botParams,
  roles: ['player', 'collectible', 'chaser'],
  reactionTicks: 8,
  cost: () => ({ bodies: 0, rules: 0 }),
  decide: stealDecide,
};
