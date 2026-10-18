/**
 * Robot házeče (P25G, T5). Svět vidí 8 tiků starý; nabití a úhel „teď“ si
 * dopočítá z vlastních stisků od té doby. Hází, jen když je pole v klidu:
 * žádný míček ve vzduchu (ani ten, který teprve pustil a ještě ho nevidí),
 * rozestup hodů uběhl a žádný blok věže nepadá. Pak vezme první cíl (věž
 * shora), pro který `solveThrow` najde úhel a sílu z rovnice letu, drží
 * s tím úhlem do plánovaného nabití a pustí. Útočník na cestě k hráči (P51 T6, `THROW_DIVE`) má přednost
 * (`diverPlan`); svět bez útočníků hraje jako dřív.
 */

import { z } from 'zod';

import { type ArcadeInput, BODY, BUTTON, type BotPiece, COUNTER, FLAG, HEADER, NO_INPUT, ROLE, bodyBase } from '../contract';
import { THROW, type ThrowBox, type ThrowPlan, boxesOfState, launchVelocity, solveThrow, throwFlight } from './throw';

const S = BODY;

/** Letí míček, padá blok, nebo běží rozestup hodů? Pak se nehází. */
function busy(state: Int32Array, recent: readonly ArcadeInput[]): boolean {
  if (recent.some((input) => (input.buttons & BUTTON.TAP) !== 0)) return true;
  if ((state[HEADER.counters + COUNTER.cooldown] as number) > recent.length) return true;
  const count = state[HEADER.bodyCount] as number;
  for (let i = 0; i < count; i += 1) {
    const b = bodyBase(i);
    const flags = state[b + S.flags] as number;
    if ((flags & FLAG.alive) === 0) continue;
    if (state[b + S.role] === ROLE.projectile) return true;
    if ((flags & FLAG.gravity) !== 0 && state[b + S.vy] !== 0) return true;
  }
  return false;
}

/** Pohyblivý terč (bonusový terč průběhu P45C T14): kinematický s rychlostí. */
const swinging = (state: Int32Array, body: number): boolean => ((state[bodyBase(body) + S.flags] as number) & FLAG.kinematic) !== 0 && state[bodyBase(body) + S.vx] !== 0;

/** Poloha x kyvadla jádra po `ticks` krocích (posun, pak počítadlo úseku a obrat) – vzor `predictSlider`. */
function swingX(state: Int32Array, body: number, ticks: number): number {
  const b = bodyBase(body);
  let x = state[b + S.x] as number;
  let vx = state[b + S.vx] as number;
  let leg = state[b + S.aux0] as number;
  const period = state[b + S.aux1] as number;
  for (let i = 0; i < ticks; i += 1) {
    x += vx;
    if (period <= 0) continue;
    leg += 1;
    if (leg >= period) {
      leg = 0;
      vx = -vx;
    }
  }
  return x;
}

/** Index bodu letu (tik po prvním po puštění), ve kterém dráha míčku protne terč v hloubce a výšce; −1 = nikdy. */
function meetTick(plan: ThrowPlan, box: ThrowBox): number {
  const { vz } = launchVelocity(plan.aim, plan.charge);
  return throwFlight(plan).findIndex(({ y, z, vy }) => Math.abs(2 * z - vz - 2 * box.z) < THROW.ballSize + Math.abs(vz) + box.d && Math.min(y, y - vy) < box.y + box.h && box.y < Math.max(y, y - vy) + THROW.ballSize);
}

type BotPlan = ThrowPlan & { readonly swing?: { readonly body: number; readonly meet: number } };

/**
 * Plán na první cíl, který jde trefit: stojící cíle (věž shora dolů, pak zepředu dozadu), pohyblivý terč až
 * nakonec – plán na něj míří na čáru hodu (`x` 0) a nese tik, kdy ho let potká. Pohyblivý terč je i terč-boss
 * role nepřítele (P47A T7); stojící nepřítel v hodu není.
 */
function planOf(state: Int32Array, player: number): BotPlan | null {
  const boxes = boxesOfState(state, player);
  const aimed = (body: number): boolean => state[bodyBase(body) + S.role] === ROLE.target || (state[bodyBase(body) + S.role] === ROLE.enemy && swinging(state, body));
  const targets = boxes.filter((box) => aimed(box.index)).sort((a, b) => b.y - a.y || a.z - b.z);
  for (const target of targets) {
    if (swinging(state, target.index)) continue;
    const plan = solveThrow(boxes, target.index);
    if (plan !== null) return plan;
  }
  for (const target of targets) {
    if (!swinging(state, target.index)) continue;
    const centered = { ...target, x: 0 };
    const plan = solveThrow(boxes.map((box) => (box.index === target.index ? centered : box)), target.index);
    const meet = plan === null ? -1 : meetTick(plan, centered);
    if (plan !== null && meet >= 0) return { ...plan, swing: { body: target.index, meet } };
  }
  return null;
}

/**
 * Pustit na pohyblivý terč teď? Viděný stav je `recent.length` tiků starý; míček vznikne v tiku puštění a
 * letí od dalšího, terč se mezitím hne o tik puštění a tiky letu do bodu `meet`. Terč musí stát na čáře hodu
 * s rezervou jednoho tiku pohybu (zásah jádra: |x| < (míček + terč) / 2).
 */
function swingReady(state: Int32Array, recent: readonly ArcadeInput[], swing: NonNullable<BotPlan['swing']>): boolean {
  const b = bodyBase(swing.body);
  if ((state[b + S.aux1] as number) <= 0) return false;
  const reach = Math.floor((THROW.ballSize + (state[b + S.w] as number)) / 2) - Math.abs(state[b + S.vx] as number);
  return Math.abs(swingX(state, swing.body, recent.length + 2 + swing.meet)) < reach;
}

/** Útočník (P51 T6, `THROW_DIVE`) na cestě k hráči: kinematický nepřítel, který napříč stojí a snáší se nebo se plíží po −z. */
const diving = (state: Int32Array, body: number): boolean => {
  const b = bodyBase(body);
  return state[b + S.role] === ROLE.enemy && ((state[b + S.flags] as number) & FLAG.kinematic) !== 0 && state[b + S.vx] === 0 && ((state[b + S.vz] as number) < 0 || (state[b + S.vy] as number) < 0);
};

/** Úhly, které robot na útočníka zkouší (jako řešič hodu: −700..900 po 100). */
const DIVE_AIMS = Array.from({ length: 17 }, (_, k) => (k === 7 ? 1 : -700 + 100 * k));

/**
 * Trefí hod `plan` puštěný teď útočníka `diver` dřív než cokoli jiného? Jako `simulateThrow`, jen útočníci se mezitím
 * posunou: viděný stav je `lag` tiků starý, míček vznikne v tiku puštění a letí od dalšího (bod letu `n` = `lag + 2 + n`
 * tiků posunu, vzor `swingReady`).
 */
function hitsDiver(state: Int32Array, boxes: readonly ThrowBox[], diver: number, plan: ThrowPlan, lag: number): boolean {
  const { vz } = launchVelocity(plan.aim, plan.charge);
  const s = THROW.ballSize;
  const flight = throwFlight(plan);
  for (let n = 0; n < flight.length; n += 1) {
    const { y, z, vy } = flight[n] as (typeof flight)[number];
    const bottom = Math.min(y, y - vy);
    const top = Math.max(y, y - vy) + s;
    for (const box of boxes) {
      const bz = diving(state, box.index) ? box.z + (state[bodyBase(box.index) + S.vz] as number) * (lag + 2 + n) : box.z;
      if (Math.abs(2 * z - vz - 2 * bz) < s + Math.abs(vz) + box.d && Math.abs(-2 * box.x) < s + box.w && bottom < box.y + box.h && box.y < top) return box.index === diver;
    }
  }
  return false;
}

/**
 * Útočníci mají přednost (P51 T6): nejbližší, dokud žije. Úhel, se kterým ho hod s nabitím `charge` puštěný teď trefí;
 * `hold` = zatím žádný – nabíjet dál (s plným nabitím čekat); útočník, který se ještě snáší, nemá přímou dráhu, tak
 * taky `hold`. `null` = žádný útočník na cestě k hráči.
 */
function diverPlan(state: Int32Array, player: number, recent: readonly ArcadeInput[], charge: number): { readonly aim: number } | 'hold' | null {
  const boxes = boxesOfState(state, player);
  const diver = boxes.filter((box) => diving(state, box.index)).sort((a, b) => a.z - b.z)[0];
  if (diver === undefined) return null;
  if ((state[bodyBase(diver.index) + S.vy] as number) < 0) return 'hold';
  const aim = DIVE_AIMS.find((candidate) => hitsDiver(state, boxes, diver.index, { aim: candidate, charge: Math.max(1, charge) }, recent.length));
  return aim === undefined ? 'hold' : { aim };
}

const botParams = z.object({}).strict();

export const throwBot: BotPiece<z.infer<typeof botParams>> = {
  id: 'throw_bot',
  params: botParams,
  roles: ['player', 'projectile', 'target'],
  reactionTicks: 8,
  cost: () => ({ bodies: 0, rules: 0 }),
  decide: ({ state, player, recent }): ArcadeInput => {
    if ((state[HEADER.counters + COUNTER.ammo] as number) <= 0 || busy(state, recent)) return NO_INPUT;
    // Nabití „teď“: pozorované (po puštění záporné = 0) plus vlastní držení od té doby.
    let charge = Math.max(0, state[bodyBase(player) + S.aux1] as number);
    for (const input of recent) if ((input.buttons & BUTTON.HOLD) !== 0) charge = Math.min(THROW.maxCharge, charge + 1);
    // Útočník: pustit, jakmile ho hod s dnešním nabitím trefí, jinak nabíjet (svět bez útočníků hraje jako dřív).
    const dive = diverPlan(state, player, recent, charge);
    if (dive === 'hold') return { buttons: charge < THROW.maxCharge ? BUTTON.HOLD : 0, axis: 0 };
    if (dive !== null) return { buttons: BUTTON.TAP, axis: dive.aim };
    const plan = planOf(state, player);
    if (plan === null) return NO_INPUT;
    // Tento tik držení přidá jedno nabití; puštění nabití nemění.
    if (plan.swing === undefined || charge < plan.charge) return { buttons: charge >= plan.charge ? BUTTON.TAP : BUTTON.HOLD, axis: plan.aim };
    // Pohyblivý terč: nabito předem, puštění čeká, až terč v tiku setkání stojí na čáře hodu.
    return { buttons: swingReady(state, recent, plan.swing) ? BUTTON.TAP : 0, axis: plan.aim };
  },
};
