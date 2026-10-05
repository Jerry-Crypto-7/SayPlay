/**
 * Robot ověřovače „za ruku“ (P36C T4): e2e se zeptá, co by robot teď stiskl,
 * zahraje to gesty na dotykové ploše a odtiká tik. Pozorování je totéž jako
 * v `runBot` (svět starý `reactionTicks`, vlastní nedávné vstupy), jen „nedávné
 * vstupy“ jsou ty, které hra z gest opravdu dostala – robot tak dorovná, kde
 * prst stisk jen přiblížil (plošinovka zná jen plný běh, tah má celé pixely).
 * Jen pro sondu e2e; do stavu ani hashe nesahá, hraje přes vstupy relace.
 */

import { type ArcadeInput, type ArcadeObservation, HEADER, NO_INPUT } from '@/play/arcade/contract';
import { ARCADE_LIBRARY } from '@/play/arcade/library';
import { rulesPlanner } from '@/play/arcade/rules/bot';

import type { ArcadeSession } from './session';

export interface BotHand {
  /** Co by robot stiskl v tomhle tiku. Volat jednou před každým `step`. */
  decide(): ArcadeInput;
  /** Jeden tik se vstupy, které mezitím sebrala relace (z gest); zapamatuje si, co hra dostala. */
  step(): void;
}

export function botHand(session: Pick<ArcadeSession, 'world' | 'state' | 'inputs' | 'stepOnce'>): BotHand {
  const world = session.world;
  const piece = ARCADE_LIBRARY.bots[world.bot.id];
  if (piece === undefined) throw new Error(`arcade: unknown bot ${world.bot.id}`);
  const params = piece.params.parse(world.bot.params);
  // Týž výběr jako `runBot`: hru vyhrávanou pravidly specu hraje plánovač cílů.
  const bot = rulesPlanner(world) ?? { reactionTicks: piece.reactionTicks, decide: (observation: ArcadeObservation) => piece.decide(observation, params) };
  const delay = bot.reactionTicks;
  const history: Int32Array[] = [];
  const issued: ArcadeInput[] = [];
  return {
    decide: () => {
      const state = session.state();
      const tick = state[HEADER.tick] as number;
      history[tick % (delay + 1)] = state.slice();
      const seenAt = Math.max(0, tick - delay);
      return bot.decide({
        state: history[seenAt % (delay + 1)] as Int32Array,
        player: state[HEADER.player] as number,
        tick: seenAt,
        recent: issued.slice(issued.length - (tick - seenAt)),
      });
    },
    step: () => {
      const tick = session.state()[HEADER.tick] as number;
      session.stepOnce();
      const last = session.inputs().at(-1);
      issued.push(last !== undefined && last.tick === tick ? { buttons: last.buttons, axis: last.axis } : NO_INPUT);
    },
  };
}
