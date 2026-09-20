/**
 * `stun`: `use` na cíl ho na `seconds` zmrazí, nejvýš `uses`-krát.
 *
 * Bez stráže na polohu: `visible` není podmínka (`lowerCondition`) a byla by
 * stejně vždy pravdivá, a zóna kolem cíle, který se hýbe, neexistuje. Použití
 * počítá čítač `stunsUsed` a stráž `< uses` ho ohraničuje.
 */

import type { z } from 'zod';

import type { MECHANICS } from '../../registry';
import type { MechanicAdapter, SurfaceRule, WitnessStep } from '../types';
import { TICKS_PER_SECOND } from './timer';

export const STUNS_COUNTER = 'stunsUsed';

type Params = z.infer<(typeof MECHANICS)['stun']['params']>;

export const stun: MechanicAdapter<Params> = (params, ctx) => {
  const rules: Record<string, SurfaceRule> = {};
  const targets = ctx.instances(params.targetRole);
  for (const target of targets) {
    const id = `stun.${target}`;
    rules[id] = {
      id,
      phase: 0,
      priority: 0,
      event: { kind: 'onAction', actor: ctx.player, actionId: 'use', target },
      condition: { kind: 'counterIs', ref: STUNS_COUNTER, op: '<', value: params.uses },
      actions: [
        { kind: 'freeze', target, ticks: params.seconds * TICKS_PER_SECOND },
        { kind: 'addCounter', ref: STUNS_COUNTER, by: 1 },
      ],
    };
  }
  // Svědek omráčí první cíl hned na startu, aby měl volnou cestu.
  const witness: WitnessStep[] = targets.length > 0 ? [{ actionId: 'use', target: targets[0] as string, stage: 0 }] : [];
  return { counters: { [STUNS_COUNTER]: { min: 0, max: params.uses, init: 0 } }, rules, witness };
};
