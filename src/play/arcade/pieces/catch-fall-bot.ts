/**
 * Robot chytání (P54C T5): jede do pruhu nejbližšího dopadu, který není bomba.
 *
 * Svět vidí `reactionTicks` starý a jen to, co je v obraze (věc pod `CATCH.viewTop`).
 * Věci padají stálou rychlostí, takže tik dopadu dopočítá z viděné výšky (`landingTick`);
 * ovoce, které mezitím dopadlo, už nehoní. Bomby padají vždy vedle ovoce téhož tiku,
 * takže robot, který k ovoci dojel včas, je mine sám.
 */

import { z } from 'zod';

import { type ArcadeInput, BODY, type BotPiece, FLAG, HEADER, NO_INPUT, ROLE, bodyBase } from '../contract';
import { CATCH, CATCH_BOT_REACTION, landingTick } from './catch-fall';
import { axisOfLane, laneOfX } from './lanes';

const botParams = z.object({}).strict();

/** Ovoce v obraze s nejbližším dopadem od tiku `now`, nebo −1. */
export function nextFruit(state: Int32Array, player: number, seenAt: number, now: number): number {
  const count = state[HEADER.bodyCount] as number;
  let best = -1;
  let bestAt = Number.POSITIVE_INFINITY;
  for (let body = 0; body < count; body += 1) {
    if (body === player) continue;
    const base = bodyBase(body);
    if (((state[base + BODY.flags] as number) & FLAG.alive) === 0 || state[base + BODY.role] !== ROLE.collectible) continue;
    const y = state[base + BODY.y] as number;
    const vy = state[base + BODY.vy] as number;
    if (vy >= 0 || y > CATCH.viewTop) continue;
    const landing = landingTick(y, -vy, seenAt);
    if (landing < now || landing >= bestAt) continue;
    best = body;
    bestAt = landing;
  }
  return best;
}

export const catchBot: BotPiece<z.infer<typeof botParams>> = {
  id: 'catch_bot',
  params: botParams,
  roles: ['player', 'collectible', 'hazard'],
  reactionTicks: CATCH_BOT_REACTION,
  cost: () => ({ bodies: 0, rules: 0 }),
  decide: ({ state, player, tick, recent }): ArcadeInput => {
    const target = nextFruit(state, player, tick, tick + recent.length);
    if (target < 0) return NO_INPUT;
    return { buttons: 0, axis: axisOfLane(laneOfX(state[bodyBase(target) + BODY.x] as number)) };
  },
};
