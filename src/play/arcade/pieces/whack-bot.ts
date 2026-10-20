/**
 * Robot bouchání (P54C T6): bouchne do nejstaršího otevřeného krtka, hodné cíle vynechá.
 *
 * Svět vidí `reactionTicks` starý a jen to, co z díry vykouklo. Cíle stoupají stálou rychlostí,
 * takže z viděné výšky dopočítá, kdy se cíl schová (`upOf`, `windowOf`), a do díry, která se mezitím
 * zavře, už nebouchá. Krtka, do jehož díry od viděného stavu sám ťukl, má za rozbitého.
 */

import { z } from 'zod';

import { type ArcadeInput, BODY, BUTTON, type BotPiece, FLAG, HEADER, NO_INPUT, ROLE, bodyBase } from '../contract';
import { axisOfLane, laneOf, laneOfAxis, laneOfX } from './lanes';
import { WHACK, WHACK_BOT_REACTION, upOf } from './whack';

const botParams = z.object({}).strict();

/**
 * Nejstarší krtek, který ve viděném stavu (tik `seenAt`) kouká z díry, v tiku `now` ještě kouká
 * a do jeho díry od té doby nepadl ťuk (`tapped`); jinak −1.
 */
export function nextMole(state: Int32Array, player: number, seenAt: number, now: number, tapped: ReadonlySet<number>): number {
  const count = state[HEADER.bodyCount] as number;
  let best = -1;
  let bestUp = Number.POSITIVE_INFINITY;
  for (let body = 0; body < count; body += 1) {
    if (body === player) continue;
    const base = bodyBase(body);
    if (((state[base + BODY.flags] as number) & FLAG.alive) === 0 || state[base + BODY.role] !== ROLE.target) continue;
    const y = state[base + BODY.y] as number;
    const vy = state[base + BODY.vy] as number;
    if (vy <= 0 || y < 0 || y >= WHACK.band) continue;
    // Výška po kroku `now`: stav z `seenAt` je po kroku `seenAt − 1`.
    if (y + vy * (now - seenAt + 1) >= WHACK.band || tapped.has(laneOfX(state[base + BODY.x] as number))) continue;
    const up = upOf(y, vy, seenAt);
    if (up >= bestUp) continue;
    best = body;
    bestUp = up;
  }
  return best;
}

export const whackBot: BotPiece<z.infer<typeof botParams>> = {
  id: 'whack_bot',
  params: botParams,
  roles: ['player', 'target', 'hazard'],
  reactionTicks: WHACK_BOT_REACTION,
  cost: () => ({ bodies: 0, rules: 0 }),
  decide: ({ state, player, tick, recent }): ArcadeInput => {
    // Ťuky, které ve viděném stavu ještě nejsou: díra s osou míří do pruhu osy, bez ní do pruhu hrdiny.
    const tapped = new Set(recent.filter((input) => (input.buttons & BUTTON.TAP) !== 0).map((input) => (input.axis !== 0 ? laneOfAxis(input.axis) : laneOf(state, player))));
    const target = nextMole(state, player, tick, tick + recent.length, tapped);
    if (target < 0) return NO_INPUT;
    return { buttons: BUTTON.TAP, axis: axisOfLane(laneOfX(state[bodyBase(target) + BODY.x] as number)) };
  },
};
