/**
 * `checkpoint`: projít branami role, s `ordered` v pořadí instancí.
 *
 * Čítač `gatesPassed` (jméno čtou keypointy fixtur). Brána *k* přičte jen
 * jednou (stav `pending → passed`) a s `ordered` jen při `gatesPassed = k-1`.
 * Výhru dává `onCounterReaches` jen když je cíl hry `checkpoints`; jinak jsou
 * brány mezikroky (kameny v `hazard_crossing`) a výhru řeší jiná mechanika.
 */

import type { z } from 'zod';

import type { MECHANICS } from '../../registry';
import type { MechanicAdapter, SurfaceCondition, SurfaceRule, WitnessStep } from '../types';

export const GATES_COUNTER = 'gatesPassed';

type Params = z.infer<(typeof MECHANICS)['checkpoint']['params']>;

export const checkpoint: MechanicAdapter<Params> = (params, ctx) => {
  const rules: Record<string, SurfaceRule> = {};
  const instances = ctx.instances(params.role);
  const witness: WitnessStep[] = [];
  instances.forEach((id, index) => {
    const pending: SurfaceCondition = { kind: 'stateIs', target: id, value: 'pending' };
    const inOrder: SurfaceCondition = { kind: 'counterIs', ref: GATES_COUNTER, op: '=', value: index };
    const pass = `checkpoint.${id}.pass`;
    rules[pass] = {
      id: pass,
      phase: 0,
      priority: 0,
      event: { kind: 'onEnterZone', entity: ctx.player, zone: id },
      condition: params.ordered ? { kind: 'allOf', operands: [pending, inOrder] } : pending,
      actions: [
        { kind: 'addCounter', ref: GATES_COUNTER, by: 1 },
        { kind: 'setState', target: id, value: 'passed' },
      ],
    };
    witness.push({ actionId: 'moveTo', target: id, stage: 0 });
  });
  if (ctx.spec.objective.kind === 'checkpoints') {
    const done = `checkpoint.${params.role}.done`;
    rules[done] = {
      id: done,
      phase: 2,
      priority: 0,
      event: { kind: 'onCounterReaches', ref: GATES_COUNTER, threshold: params.count },
      condition: null,
      actions: [{ kind: 'win' }],
    };
  }
  return { counters: { [GATES_COUNTER]: { min: 0, max: instances.length, init: 0 } }, rules, witness };
};
