/**
 * `health`: hráč vydrží `max` zásahů.
 *
 * Čítač jde **nahoru** (`damage` 0..max), ne dolů jako `hp`: `onCounterReaches`
 * je stoupající hrana `counter >= n` (`src/ir/lower.ts:118`), takže práh 0 by
 * platil od začátku a nikdy nevystřelil. Zraňující mechaniky volají
 * `addCounter(damage, 1)` (`DAMAGE_COUNTER`).
 */

import type { z } from 'zod';

import type { MECHANICS } from '../../registry';
import type { MechanicAdapter } from '../types';

export const DAMAGE_COUNTER = 'damage';

type Params = z.infer<(typeof MECHANICS)['health']['params']>;

export const health: MechanicAdapter<Params> = (params) => {
  const dead = 'health.dead';
  return {
    counters: { [DAMAGE_COUNTER]: { min: 0, max: params.max, init: 0 } },
    rules: {
      [dead]: {
        id: dead,
        phase: 2,
        priority: 0,
        event: { kind: 'onCounterReaches', ref: DAMAGE_COUNTER, threshold: params.max },
        condition: null,
        actions: [{ kind: 'lose' }],
      },
    },
  };
};
