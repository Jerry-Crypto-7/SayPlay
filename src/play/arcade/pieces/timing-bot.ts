/**
 * Robot načasování (P25H, T2). Svět vidí 8 tiků starý; jezdec je kyvadlo
 * jádra, takže jeho polohu „teď“ dopočítá přesně: od viděného stavu
 * přehraje tolik kroků kyvu, kolik tiků je vjem pozadu. Ťukne, když
 * předpověď padne na bod kyvu nejblíž středu cíle (a ten je v toleranci).
 * Po vlastním ťuku čeká, dokud nové kolo neuvidí.
 */

import { z } from 'zod';

import { type ArcadeInput, BODY, BUTTON, type BotPiece, NO_INPUT, bodyBase } from '../contract';
import { TIMING_SLOTS } from './timing';

const S = BODY;

/** Poloha jezdce po `ticks` krocích kyvadla jádra (posun, pak počítadlo úseku a obrat). */
export function predictSlider(state: Int32Array, ticks: number): number {
  const slider = bodyBase(TIMING_SLOTS.slider);
  let x = state[slider + S.x] as number;
  let vx = state[slider + S.vx] as number;
  let leg = state[slider + S.aux0] as number;
  const period = state[slider + S.aux1] as number;
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

const botParams = z.object({}).strict();

export const timingBot: BotPiece<z.infer<typeof botParams>> = {
  id: 'timing_bot',
  params: botParams,
  roles: ['player', 'platform', 'target'],
  reactionTicks: 8,
  cost: () => ({ bodies: 0, rules: 0 }),
  decide: ({ state, recent }): ArcadeInput => {
    if (recent.some((input) => (input.buttons & BUTTON.TAP) !== 0)) return NO_INPUT;
    const slider = bodyBase(TIMING_SLOTS.slider);
    const target = bodyBase(TIMING_SLOTS.target);
    const offset = Math.abs(predictSlider(state, recent.length) - (state[target + S.x] as number));
    const reach = Math.min(Math.floor((state[target + S.w] as number) / 2), Math.floor(Math.abs(state[slider + S.vx] as number) / 2));
    return offset <= reach ? { buttons: BUTTON.TAP, axis: 0 } : NO_INPUT;
  },
};
