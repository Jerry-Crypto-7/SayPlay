/**
 * Robot hry kresli a zachraň (P68-S T13), prototyp „střecha“ z brány T12 jako kus robota pod jménem z kostry.
 *
 * **Tah:** jeden tah ze dvou bodů = střecha nad postavou (`roofStroke`). Vysoký konec dvě řady nad postavou a sloupec
 * za ní (u bližší stěny), nízký konec řadu nad ní a tři sloupce na volnou stranu – hrozby po střeše sjedou pryč od
 * postavy. Stojí ~4,1 buňky inkoustu z 10, takže kreslení skončí oknem, ne inkoustem.
 *
 * **Bez paměti:** robot vidí stav `reactionTicks` starý a ví, co sám zmáčkl (`recent`). Dokud ve viděném stavu úsečka
 * není: poslední stisk byl vysoký konec → nízký konec (tah pokračuje); nízký konec už zmáčkl → prst zvedne; jinak začne
 * tah vysokým koncem. Vypadlý stisk (profil začátečníka) tah jen zopakuje – zvednutý prst začne tah znovu.
 */

import { z } from 'zod';

import { DRAWSAVE_STROKE } from '../../genre/p68-contract';
import { type ArcadeInput, BUTTON, type BotPiece, NO_INPUT } from '../contract';
import { DRAWSAVE, PHASE, cellOf, colOf, heroCellOf, phaseOf, rowOf, segmentCountOf } from './drawsave-world';
import { axisOfCell } from './lanes';

/** Reakce robota (tiky): jako ostatní roboti knihovny. */
export const DRAWSAVE_BOT_REACTION = 8;

const HOLD = BUTTON[DRAWSAVE_STROKE.hold];
const botParams = z.object({}).strict();

const clampCol = (col: number): number => Math.max(0, Math.min(DRAWSAVE.cols - 1, col));

/** Střecha nad postavou v buňce `hero`: [vysoký konec, nízký konec] tahu. */
export function roofStroke(hero: number): readonly [number, number] {
  const toRight = colOf(hero) <= (DRAWSAVE.cols - 1) / 2;
  const high = cellOf(clampCol(colOf(hero) + (toRight ? -1 : 1)), rowOf(hero) - 2);
  const low = cellOf(clampCol(colOf(hero) + (toRight ? 3 : -3)), rowOf(hero) - 1);
  return [high, low];
}

const holdAt = (cell: number): ArcadeInput => ({ buttons: HOLD, axis: axisOfCell(cell) });
const isHoldAt = (input: ArcadeInput | undefined, cell: number): boolean => input !== undefined && (input.buttons & HOLD) !== 0 && input.axis === axisOfCell(cell);

export const drawsaveBot: BotPiece<z.infer<typeof botParams>> = {
  id: 'drawsave_bot',
  params: botParams,
  roles: ['player', 'enemy', 'obstacle'],
  reactionTicks: DRAWSAVE_BOT_REACTION,
  cost: () => ({ bodies: 0, rules: 0 }),
  decide: ({ state, recent }): ArcadeInput => {
    if (phaseOf(state) !== PHASE.draw || segmentCountOf(state) > 0) return NO_INPUT;
    const [high, low] = roofStroke(heroCellOf(state));
    if (isHoldAt(recent.at(-1), high)) return holdAt(low);
    if (recent.some((input) => isHoldAt(input, low))) return NO_INPUT;
    return holdAt(high);
  },
};
