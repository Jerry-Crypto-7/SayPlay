/**
 * Robot třídění (P66 T8): v tempu hráče (`pace` tiků mezi ťuky, i na začátku kola) ťukne do fronty, kterou mu dá
 * řešič z viděného stavu (`solveBoard` s rozpočtem stavů); když řešič v rozpočtu cestu nenajde, vezme první tah
 * řešiče (čelo do otevřené nádoby, jinak odložení druhu, jehož nádoba přijede nejdřív).
 *
 * Svět vidí `reactionTicks` starý: dokud ťuk, který vydal, ve viděném stavu není, neťuká znovu. V přestávce mezi koly
 * (svět stojí) nedělá nic.
 *
 * **Slabý robot** (`mistakes` ‰, test prohratelnosti): rovnoměrně každý `1000 / mistakes`-tý ťuk pošle čelo, které
 * do žádné otevřené nádoby nepatří – do odkladiště. Bez náhody: chyba padne podle počtu věcí, které kolo už opustily.
 */

import { z } from 'zod';

import { type ArcadeInput, BODY, BUTTON, type BotPiece, NO_INPUT, bodyBase } from '../contract';
import { inBreak } from '../hooks';
import { axisOfLane } from './lanes';
import { type SortGame, boardOfState, roundIn, sortGameSchema } from './sort';
import { type SortBoard, boardBins, firstLane, movesOf, solveBoard } from './sort-level';

const botParams = sortGameSchema
  .extend({
    /** Tiky mezi ťuky (a od začátku kola do prvního). */
    pace: z.int().min(1).max(600),
    /** Chybné ťuky na tisíc (slabý robot); 0 = robot světa. */
    mistakes: z.int().min(0).max(1000),
  })
  .strict();
export type SortBotParams = z.infer<typeof botParams>;

/** Reakce robota (tiky): jako ostatní roboti knihovny. */
export const SORT_BOT_REACTION = 8;
/** Kolik stavů řešič robota smí projít za jedno rozhodnutí. */
export const SORT_BOT_BUDGET = 4000;

/** Je `count`-tý ťuk kola (od nuly) chybou při `mistakes` ‰? Chyby padnou rovnoměrně. */
export const slipAt = (count: number, mistakes: number): boolean => Math.floor(((count + 1) * mistakes) / 1000) > Math.floor((count * mistakes) / 1000);

/** Věcí, které už kolo opustily (nádoba nebo odkladiště) – kolikátý ťuk robota v kole přijde. */
const tappedSoFar = (board: SortBoard, count: number): number => count - board.queues.reduce((sum, line) => sum + line.length, 0);

/** Fronta, jejíž čelo nepatří do žádné otevřené nádoby (chyba slabého robota), nebo `null`. */
function wrongQueue(board: SortBoard): number | null {
  const open = new Set(boardBins(board).map((bin) => bin.kind));
  const queue = board.queues.findIndex((line) => line[0] !== undefined && !open.has(line[0].kind));
  return queue < 0 ? null : queue;
}

export const sortBot: BotPiece<SortBotParams> = {
  id: 'sort_bot',
  params: botParams,
  roles: ['player', 'collectible'],
  reactionTicks: SORT_BOT_REACTION,
  cost: () => ({ bodies: 0, rules: 0 }),
  decide: ({ state, tick, recent }, params): ArcadeInput => {
    if (recent.some((input) => (input.buttons & BUTTON.TAP) !== 0) || inBreak(state, params.keeper)) return NO_INPUT;
    const round = roundIn(state, params as SortGame);
    const counter = bodyBase(params.board);
    // Hodiny kola ve viděném stavu; kolo, které ovládání ještě nerozběhlo, má 0.
    const clock = state[counter + BODY.y] === round ? (state[counter + BODY.x] as number) : 0;
    if (clock < params.pace || tick - (state[counter + BODY.z] as number) < params.pace) return NO_INPUT;
    const board = boardOfState(state, params as SortGame, round);
    const plan = params.rounds[round] as SortGame['rounds'][number];
    const slip = params.mistakes > 0 && slipAt(tappedSoFar(board, plan.count), params.mistakes) ? wrongQueue(board) : null;
    const queue = slip ?? solveBoard(board, SORT_BOT_BUDGET)?.[0] ?? movesOf(board)[0];
    if (queue === undefined) return NO_INPUT;
    return { buttons: BUTTON.TAP, axis: axisOfLane(firstLane(plan.queues) + queue) };
  },
};
