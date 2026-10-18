/**
 * Robot souboje (P25H, T4). Vzorec soupeře nezná – vidí jen jeho fázi a
 * zbylé tiky fáze, a to 8 tiků staré (nápřah hráč vidí jako napřaženou
 * ruku). Uhne, když úder přijde do délky úhybu; udeří, když viděná mezera
 * potrvá i po zpoždění ještě aspoň dva tiky. Vlastní časovač úhybu si
 * dopočítá ze stisků, které ve viděném stavu ještě nejsou.
 *
 * Hozená věc (P51 T6, `hurl`): věc v ruce soupeře v nápřahu znamená, že zásah přijde až `flight` tiků po švihu,
 * až věc doletí – robot uhne podle toho, ne podle švihu. Svět bez `hurl` hraje jako dřív.
 */

import { z } from 'zod';

import { ARCADE_HZ, ARCADE_LIMITS, type ArcadeInput, BODY, BUTTON, type BotPiece, FLAG, NO_INPUT, bodyBase } from '../contract';
import { DUEL, DUEL_FOE, DUEL_PHASE } from './duel';

const botParams = z.object({ hurl: z.object({ body: z.int().min(DUEL_FOE + 1).max(ARCADE_LIMITS.maxBodies - 1), flight: z.int().min(1).max(ARCADE_HZ) }).strict().optional() }).strict();

/** Časovač úhybu po `inputs` (stejné kroky jako ovládání, bez potácení – robot mimo mezeru neudeří). */
function timerAfter(timer: number, inputs: readonly ArcadeInput[]): number {
  let t = timer;
  for (const input of inputs) {
    if (t > 0) t = t === 1 ? -DUEL.cooldown : t - 1;
    else if (t < 0) t += 1;
    if ((input.buttons & BUTTON.DOWN) !== 0 && t === 0) t = DUEL.dodge;
  }
  return t;
}

export const duelBot: BotPiece<z.infer<typeof botParams>> = {
  id: 'duel_bot',
  params: botParams,
  roles: ['player', 'enemy'],
  reactionTicks: 8,
  cost: () => ({ bodies: 0, rules: 0 }),
  decide: ({ state, player, recent }, params): ArcadeInput => {
    const foe = bodyBase(DUEL_FOE);
    const phase = state[foe + BODY.aux0] as number;
    const left = (state[foe + BODY.aux1] as number) - recent.length;
    // Za kolik tiků zásah přijde: úder se švihem, hozená věc (v nápřahu ji soupeř drží v ruce) až po letu.
    const { hurl } = params;
    const held = hurl !== undefined && ((state[bodyBase(hurl.body) + BODY.flags] as number) & FLAG.alive) !== 0;
    const lands = phase === DUEL_PHASE.windup ? left + (held ? hurl.flight : 0) : phase === DUEL_PHASE.hurl && hurl !== undefined ? left : 0;
    if (lands >= 1 && lands <= DUEL.dodge - DUEL.margin) {
      // Úhyb teď: časovač po tomto tiku (dekrement, pak stisk) musí být na nule.
      const now = timerAfter(state[bodyBase(player) + BODY.aux1] as number, recent);
      const next = now > 0 ? (now === 1 ? -DUEL.cooldown : now - 1) : now < 0 ? now + 1 : 0;
      return next === 0 && now <= 0 ? { buttons: BUTTON.DOWN, axis: 0 } : NO_INPUT;
    }
    if (phase === DUEL_PHASE.open && left >= 2 && !recent.some((input) => (input.buttons & BUTTON.TAP) !== 0)) return { buttons: BUTTON.TAP, axis: 0 };
    return NO_INPUT;
  },
};
