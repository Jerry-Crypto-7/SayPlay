/**
 * Robot úkolu (pahýl P32-0 T4, naplní P32G T2): zatím nic nemačká.
 */

import { z } from 'zod';

import { type BotPiece, NO_INPUT } from '../contract';

export const questBot: BotPiece<Readonly<Record<string, unknown>>> = {
  id: 'quest_bot',
  params: z.record(z.string(), z.unknown()),
  roles: ['player', 'target'],
  // Obal doplňků (`addon_bot`) počítá s 8 tiky u každého základního robota.
  reactionTicks: 8,
  cost: () => ({ bodies: 0, rules: 0 }),
  decide: () => NO_INPUT,
};
