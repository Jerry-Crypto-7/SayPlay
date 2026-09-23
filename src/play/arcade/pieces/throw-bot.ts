/**
 * Robot házeče (P25G, T5). Svět vidí 8 tiků starý; nabití a úhel „teď“ si
 * dopočítá z vlastních stisků od té doby. Hází, jen když je pole v klidu:
 * žádný míček ve vzduchu (ani ten, který teprve pustil a ještě ho nevidí),
 * rozestup hodů uběhl a žádný blok věže nepadá. Pak vezme první cíl (věž
 * shora), pro který `solveThrow` najde úhel a sílu z rovnice letu, drží
 * s tím úhlem do plánovaného nabití a pustí.
 */

import { z } from 'zod';

import { type ArcadeInput, BODY, BUTTON, type BotPiece, COUNTER, FLAG, HEADER, NO_INPUT, ROLE, bodyBase } from '../contract';
import { THROW, type ThrowPlan, boxesOfState, solveThrow } from './throw';

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

/** Plán na první cíl, který jde trefit: věž shora dolů, pak zepředu dozadu. */
function planOf(state: Int32Array, player: number): ThrowPlan | null {
  const boxes = boxesOfState(state, player);
  const targets = boxes.filter((box) => state[bodyBase(box.index) + S.role] === ROLE.target).sort((a, b) => b.y - a.y || a.z - b.z);
  for (const target of targets) {
    const plan = solveThrow(boxes, target.index);
    if (plan !== null) return plan;
  }
  return null;
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
    const plan = planOf(state, player);
    if (plan === null) return NO_INPUT;
    // Nabití „teď“: pozorované (po puštění záporné = 0) plus vlastní držení od té doby.
    let charge = Math.max(0, state[bodyBase(player) + S.aux1] as number);
    for (const input of recent) if ((input.buttons & BUTTON.HOLD) !== 0) charge = Math.min(THROW.maxCharge, charge + 1);
    // Tento tik držení přidá jedno nabití; puštění nabití nemění.
    return { buttons: charge >= plan.charge ? BUTTON.TAP : BUTTON.HOLD, axis: plan.aim };
  },
};
