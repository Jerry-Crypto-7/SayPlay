/**
 * Robot šipek (P66 T9): ťukne na první kus běžícího kola (po řadách), který má volnou cestu ven.
 *
 * Svět vidí `reactionTicks` starý, proto ťuká jen jednou za `pace` tiků (tempo hráče, víc než reakce): výsledek
 * minulého ťuku už vidí a stejný kus neťukne dvakrát. V přestávce mezi koly neťuká.
 *
 * **Slabý robot** (`mistakes` ‰ > 0, jen pro testy a měření): s touhle pravděpodobností ťukne místo volného kusu
 * na kus, který má cestu zatarasenou, a ztratí srdce. Los je z `pure-rand` (`createCompileRng` nad tikem a streamem
 * `ai`), takže týž svět dá týž běh. Robot světa chyby nedělá (`mistakes` 0).
 */

import { z } from 'zod';

import { createCompileRng } from '@/play/compile/rng';

import { ARCADE_LIMITS, type ArcadeInput, BUTTON, type BotPiece, NO_INPUT } from '../contract';
import { inBreak, roundOf } from '../hooks';
import { gridOfRound, gridSchema } from './arrows';
import { freeIn, occupancy } from './arrows-level';
import { axisOfCell } from './lanes';

export const ARROWS_BOT = {
  reactionTicks: 8,
  /** Tiků mezi ťuky robota světa (0,4 s): hráčské tempo, ať par skóre (bonus za čas) není nedosažitelný. */
  pace: 24,
} as const;

const botParams = z
  .object({
    keeper: z.int().min(1).max(ARCADE_LIMITS.maxBodies - 1),
    grids: z.array(gridSchema).min(1),
    pace: z.int().min(ARROWS_BOT.reactionTicks + 1).max(ARCADE_LIMITS.maxTicks).default(ARROWS_BOT.pace),
    /** ‰ ťuků na zatarasený kus (slabý robot); 0 = bez chyb. */
    mistakes: z.int().min(0).max(1000).default(0),
  })
  .strict();
export type ArrowsBotParams = z.infer<typeof botParams>;

const SALT = 0x5a17;

/** Buňky kusů běžícího kola: s volnou cestou a se zatarasenou, po řadách. */
export function arrowsChoices(state: Int32Array, params: Pick<ArrowsBotParams, 'keeper' | 'grids'>): { readonly free: number[]; readonly blocked: number[] } {
  const round = roundOf(state, params.keeper);
  const grid = gridOfRound(params.grids, round);
  const occ = occupancy(state, round, grid);
  const free: number[] = [];
  const blocked: number[] = [];
  for (let cell = 0; cell < occ.length; cell += 1) {
    if (occ[cell] === 0) continue;
    (freeIn(state, occ, grid, cell) ? free : blocked).push(cell);
  }
  return { free, blocked };
}

export const arrowsBot: BotPiece<ArrowsBotParams> = {
  id: 'arrows_bot',
  params: botParams,
  roles: ['player', 'target'],
  reactionTicks: ARROWS_BOT.reactionTicks,
  cost: () => ({ bodies: 0, rules: 0 }),
  decide: ({ state, tick, recent }, params): ArcadeInput => {
    if (tick % params.pace !== 0 || recent.some((input) => (input.buttons & BUTTON.TAP) !== 0) || inBreak(state, params.keeper)) return NO_INPUT;
    const { free, blocked } = arrowsChoices(state, params);
    const wrong = params.mistakes > 0 && blocked.length > 0 && createCompileRng(tick ^ SALT, 'ai').int(0, 999) < params.mistakes;
    const cell = wrong ? blocked[0] : free[0];
    return cell === undefined ? NO_INPUT : { buttons: BUTTON.TAP, axis: axisOfCell(cell) };
  },
};
