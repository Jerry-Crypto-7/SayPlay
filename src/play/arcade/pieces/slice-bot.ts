/**
 * Robot krájení (P54C T8): švihne do pruhu s nejvíc ovocem ve výšce řezu, ve kterém tam není bomba.
 *
 * Svět vidí `reactionTicks` starý: věc, která vyletěla později, nezná. Věci letí po oblouku
 * gravitace jádra, takže z viděné výšky a rychlosti dopočítá, kde budou v tiku jeho švihu
 * (`heightAt`). Ovoce, které jeho vlastní švih od viděného stavu už rozsekl, nepočítá.
 */

import { z } from 'zod';

import { type ArcadeInput, BODY, BUTTON, type BotPiece, FLAG, HEADER, NO_INPUT, ROLE, bodyBase } from '../contract';
import { LANES, axisOfLane, laneOf, laneOfAxis, laneOfX } from './lanes';
import { SLICE, SLICE_BOT_REACTION, heightAt } from './slice';

const botParams = z.object({}).strict();

/** Švih, který robot vydal, ale ve viděném stavu ještě není: tik a pruh. */
export interface Swing {
  readonly at: number;
  readonly lane: number;
}

/**
 * Pruh s nejvíc ovocem, které ve viděném stavu (tik `seenAt`) letí a v tiku `now` bude ve výšce řezu,
 * bez bomby ve výšce řezu v témže pruhu; ovoce, které v témže pruhu rozsekl švih ze `swings`, nepočítá.
 * Bez takového pruhu −1.
 */
export function bestLane(state: Int32Array, player: number, seenAt: number, now: number, swings: readonly Swing[]): number {
  const fruit = Array.from({ length: LANES.count }, () => 0);
  const bombed = Array.from({ length: LANES.count }, () => false);
  for (let body = state[HEADER.spawnBase] as number; body < (state[HEADER.bodyCount] as number); body += 1) {
    if (body === player) continue;
    const base = bodyBase(body);
    const flags = state[base + BODY.flags] as number;
    if ((flags & FLAG.alive) === 0 || (flags & FLAG.grounded) !== 0) continue;
    const role = state[base + BODY.role] as number;
    if (role !== ROLE.collectible && role !== ROLE.hazard) continue;
    const y = state[base + BODY.y] as number;
    const vy = state[base + BODY.vy] as number;
    if (heightAt(y, vy, seenAt, now) < SLICE.cutY) continue;
    const lane = laneOfX(state[base + BODY.x] as number);
    if (role === ROLE.hazard) {
      bombed[lane] = true;
      continue;
    }
    if (swings.some((swing) => swing.lane === lane && heightAt(y, vy, seenAt, swing.at) >= SLICE.cutY)) continue;
    fruit[lane] = (fruit[lane] as number) + 1;
  }
  let best = -1;
  for (let lane = 0; lane < LANES.count; lane += 1) {
    if (bombed[lane] === true || (fruit[lane] as number) === 0) continue;
    if (best < 0 || (fruit[lane] as number) > (fruit[best] as number)) best = lane;
  }
  return best;
}

export const sliceBot: BotPiece<z.infer<typeof botParams>> = {
  id: 'slice_bot',
  params: botParams,
  roles: ['player', 'collectible', 'hazard'],
  reactionTicks: SLICE_BOT_REACTION,
  cost: () => ({ bodies: 0, rules: 0 }),
  decide: ({ state, player, tick, recent }): ArcadeInput => {
    // Švihy, které ve viděném stavu ještě nejsou: `recent[i]` padl v tiku `tick + i`, pruh z osy, bez ní pruh hrdiny.
    const swings: Swing[] = [];
    recent.forEach((input, at) => {
      if ((input.buttons & BUTTON.TAP) !== 0) swings.push({ at: tick + at, lane: input.axis !== 0 ? laneOfAxis(input.axis) : laneOf(state, player) });
    });
    const lane = bestLane(state, player, tick, tick + recent.length, swings);
    return lane < 0 ? NO_INPUT : { buttons: BUTTON.TAP, axis: axisOfLane(lane) };
  },
};
