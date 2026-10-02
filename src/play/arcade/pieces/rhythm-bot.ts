/**
 * Robot rytmu (P25H, T3). Svět vidí 8 tiků starý; noty jedou stálou
 * rychlostí, takže polohu „teď“ dopočítá: viděné `z` minus tolik kroků,
 * kolik je vjem pozadu. Ťukne v tiku, kdy nota stojí na liště (beat).
 * Notu, kterou mezitím sám trefil, ještě vidí živou – ta je ale už za
 * lištou, takže ji nezvolí znovu.
 */

import { z } from 'zod';

import { type ArcadeInput, BODY, BUTTON, type BotPiece, FLAG, HEADER, NO_INPUT, bodyBase } from '../contract';
import { RHYTHM, rhythmLaneAxis, rhythmLaneOfX } from './rhythm';

/** `lanes`: ovládání chce dráhu noty v ose ťuku (žánr Rytmus, P36A T11). */
const botParams = z.object({ lanes: z.boolean().optional() }).strict();

export const rhythmBot: BotPiece<z.infer<typeof botParams>> = {
  id: 'rhythm_bot',
  params: botParams,
  roles: ['player', 'target'],
  reactionTicks: 8,
  cost: () => ({ bodies: 0, rules: 0 }),
  decide: ({ state, player, recent }, params): ArcadeInput => {
    const count = state[HEADER.bodyCount] as number;
    const ahead = recent.length * RHYTHM.noteSpeed;
    for (let i = 0; i < count; i += 1) {
      if (i === player) continue;
      const base = bodyBase(i);
      if (((state[base + BODY.flags] as number) & FLAG.alive) === 0) continue;
      if (Math.abs((state[base + BODY.z] as number) - ahead) * 2 >= RHYTHM.noteSpeed) continue;
      return { buttons: BUTTON.TAP, axis: params.lanes === true ? rhythmLaneAxis(rhythmLaneOfX(state[base + BODY.x] as number)) : 0 };
    }
    return NO_INPUT;
  },
};
