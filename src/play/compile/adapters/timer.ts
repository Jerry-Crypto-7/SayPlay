/**
 * `timer`: odpočet, který hru vyhraje, prohraje nebo vyšle signál.
 *
 * Časovač s `init = durationTicks` běží od prvního tiku sám (`settle` ho
 * každý tik sníží, `src/sim/interpreter.ts:805`), takže `onStart → startTimer`
 * není potřeba; `onTimerEnd` je pád hrany `timer > 0`.
 */

import type { z } from 'zod';

import type { MECHANICS } from '../../registry';
import type { MechanicAdapter, SurfaceAction } from '../types';

export const TICKS_PER_SECOND = 20;

type Params = z.infer<(typeof MECHANICS)['timer']['params']>;

export const timer: MechanicAdapter<Params> = (params) => {
  const ticks = params.seconds * TICKS_PER_SECOND;
  const end = `timer.${params.id}.end`;
  const action: SurfaceAction =
    params.onEnd === 'signal' ? { kind: 'emit', signal: params.signal ?? `${params.id}Ended` } : { kind: params.onEnd };
  return {
    timers: { [params.id]: { durationTicks: ticks, init: ticks } },
    rules: {
      [end]: { id: end, phase: 2, priority: 0, event: { kind: 'onTimerEnd', timer: params.id }, condition: null, actions: [action] },
    },
  };
};
