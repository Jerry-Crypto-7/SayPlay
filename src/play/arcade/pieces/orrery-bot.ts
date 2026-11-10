/**
 * Robot klikací simulace (P83C T2): v tempu diváka (`pace` tiků mezi klepnutími, i od startu) nejdřív třikrát klepne
 * na první věc – ukáže, že další klepnutí efekt stupňuje – a pak probudí každou další spící věc po řadě. Klepnutí
 * míří na věc (osa = věc + 1), ne na místo.
 *
 * Svět vidí `reactionTicks` starý: dokud klepnutí, které vydal, ve viděném stavu není, neklepne znovu.
 */

import { z } from 'zod';

import { type ArcadeInput, BODY, BUTTON, type BotPiece, NO_INPUT, bodyBase } from '../contract';
import { axisOfCell } from './lanes';
import { ORRERY, type OrreryGame, levelOf, orreryGameSchema } from './orrery';

const botParams = orreryGameSchema
  .extend({
    /** Tiky mezi klepnutími (a od startu do prvního). */
    pace: z.int().min(1).max(600),
  })
  .strict();
export type OrreryBotParams = z.infer<typeof botParams>;

/** Reakce robota (tiky): jako ostatní roboti knihovny. */
export const ORRERY_BOT_REACTION = 8;

/** Věc, na kterou robot klepne: první věc do nejvyššího stupně, pak první spící; `null` = není co probudit. */
export function orreryBotTarget(state: Int32Array, game: OrreryGame): number | null {
  if (levelOf(state, game, 0) < ORRERY.maxLevel) return 0;
  for (let index = 1; index < game.count; index += 1) if (levelOf(state, game, index) === 0) return index;
  return null;
}

export const orreryBot: BotPiece<OrreryBotParams> = {
  id: 'orrery_bot',
  params: botParams,
  roles: ['player', 'target'],
  reactionTicks: ORRERY_BOT_REACTION,
  cost: () => ({ bodies: 0, rules: 0 }),
  decide: ({ state, tick, recent }, params): ArcadeInput => {
    if (recent.some((input) => (input.buttons & BUTTON.TAP) !== 0)) return NO_INPUT;
    const board = bodyBase(params.board);
    const taps = state[board + BODY.x] as number;
    const last = taps === 0 ? 0 : (state[board + BODY.z] as number);
    if (tick - last < params.pace) return NO_INPUT;
    const target = orreryBotTarget(state, params);
    return target === null ? NO_INPUT : { buttons: BUTTON.TAP, axis: axisOfCell(target) };
  },
};
