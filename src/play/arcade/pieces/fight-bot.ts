/**
 * Robot souboje (pahýl P32-0 T4, naplní P32E T3): zatím nic nemačká.
 */

import { z } from 'zod';

import { type BotPiece, NO_INPUT } from '../contract';

export const fightBot: BotPiece<Readonly<Record<string, unknown>>> = {
  id: 'fight_bot',
  params: z.record(z.string(), z.unknown()),
  roles: ['player', 'enemy'],
  // Obal doplňků (`addon_bot`) počítá s 8 tiky u každého základního robota.
  reactionTicks: 8,
  cost: () => ({ bodies: 0, rules: 0 }),
  decide: () => NO_INPUT,
};
