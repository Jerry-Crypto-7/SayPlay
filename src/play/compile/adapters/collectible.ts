/**
 * `collectible`: sběr předmětu role přičítá čítač, plný čítač vyšle signál.
 *
 * Jedno pravidlo `onPickup {entity}` **na instanci**, ne `onPickup {role}`:
 * rolový tvar se snižuje na jediný složený predikát `p.onPickup.<klíč>` a
 * hledač svědka čte abecedu jen z `p.onAction.<hráč>.<akce>.<cíl>`
 * (`src/verify/solve.ts:188`) – svět by byl hratelný, ale nedokazatelný.
 *
 * Entita se nedespawnuje ani nemění stav (obojí mimo capabilities), takže
 * „už sebráno“ drží čítač `<instance>_taken` s `max: 1` a stráž `counterIs = 0`;
 * bez ní by týž předmět šel sebrat pětkrát a svědek by hru vyhrál z místa.
 */

import type { z } from 'zod';

import type { MECHANICS } from '../../registry';
import type { CounterDecl, MechanicAdapter, SurfaceRule, WitnessStep } from '../types';

type Params = z.infer<(typeof MECHANICS)['collectible']['params']>;

export const collectible: MechanicAdapter<Params> = (params, ctx) => {
  const rules: Record<string, SurfaceRule> = {};
  const witness: WitnessStep[] = [];
  const counters: Record<string, CounterDecl> = { [params.counter]: { min: 0, max: params.count, init: 0 } };
  for (const instance of ctx.instances(params.role)) {
    const id = `collectible.${instance}.pick`;
    const taken = `${instance}_taken`;
    counters[taken] = { min: 0, max: 1, init: 0 };
    if (witness.length < params.count) witness.push({ actionId: 'pickup', target: instance, stage: 0 });
    rules[id] = {
      id,
      phase: 0,
      priority: 0,
      event: { kind: 'onPickup', entity: instance },
      condition: { kind: 'counterIs', ref: taken, op: '=', value: 0 },
      actions: [
        { kind: 'addCounter', ref: taken, by: 1 },
        { kind: 'addCounter', ref: params.counter, by: 1 },
      ],
    };
  }
  const full = `collectible.${params.role}.full`;
  rules[full] = {
    id: full,
    phase: 1,
    priority: 0,
    event: { kind: 'onCounterReaches', ref: params.counter, threshold: params.count },
    condition: null,
    actions: [{ kind: 'emit', signal: `${params.counter}Full` }],
  };
  return { counters, rules, witness };
};
