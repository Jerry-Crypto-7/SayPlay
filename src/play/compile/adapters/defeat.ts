/**
 * `defeat`: `use` na cíl je zásah; po `hitsPerTarget` zásazích cíl zmizí a
 * po `count` cílech hra vyhraje.
 *
 * Zásahy drží čítač `<instance>_hits`; `onCounterReaches` na jeho maximu cíl
 * despawnuje, přepne do `down` a přičte `defeated`. Bez stráže na polohu –
 * `visible` je bez blokovaných buněk vždy pravda (mapa T1, „Co nevíme“).
 */

import type { z } from 'zod';

import type { MECHANICS } from '../../registry';
import type { CounterDecl, MechanicAdapter, SurfaceRule, WitnessStep } from '../types';

export const DEFEATED_COUNTER = 'defeated';

type Params = z.infer<(typeof MECHANICS)['defeat']['params']>;

export const defeat: MechanicAdapter<Params> = (params, ctx) => {
  const rules: Record<string, SurfaceRule> = {};
  const targets = ctx.instances(params.role);
  const counters: Record<string, CounterDecl> = { [DEFEATED_COUNTER]: { min: 0, max: targets.length, init: 0 } };
  const witness: WitnessStep[] = [];
  for (const target of targets) {
    const hits = `${target}_hits`;
    counters[hits] = { min: 0, max: params.hitsPerTarget, init: 0 };
    rules[`defeat.${target}.hit`] = {
      id: `defeat.${target}.hit`,
      phase: 0,
      priority: 0,
      event: { kind: 'onAction', actor: ctx.player, actionId: 'use', target },
      condition: { kind: 'stateIs', target, value: 'alive' },
      actions: [{ kind: 'addCounter', ref: hits, by: 1 }],
    };
    rules[`defeat.${target}.down`] = {
      id: `defeat.${target}.down`,
      phase: 1,
      priority: 0,
      event: { kind: 'onCounterReaches', ref: hits, threshold: params.hitsPerTarget },
      condition: null,
      actions: [
        { kind: 'setState', target, value: 'down' },
        { kind: 'despawn', target },
        { kind: 'addCounter', ref: DEFEATED_COUNTER, by: 1 },
      ],
    };
    if (witness.length < params.count * params.hitsPerTarget) {
      for (let hit = 0; hit < params.hitsPerTarget; hit += 1) witness.push({ actionId: 'use', target, stage: 0 });
    }
  }
  const win = `defeat.${params.role}.win`;
  rules[win] = {
    id: win,
    phase: 2,
    priority: 0,
    event: { kind: 'onCounterReaches', ref: DEFEATED_COUNTER, threshold: params.count },
    condition: null,
    actions: [{ kind: 'win' }],
  };
  return { counters, rules, witness };
};
