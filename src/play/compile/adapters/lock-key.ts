/**
 * `lock_key`: dost klíčů odemkne dveře.
 *
 * Klíč se počítá jednou (čítač `<instance>_taken`, jako u `collectible`) do
 * `keysHeld`; při `keysNeeded` se každé dveře role odemknou a otevřou.
 * Zamčené dveře nic fyzicky neblokují – `zone_trigger` na roli `door` nese
 * stráž `lockedIs(door, false)`, takže průchod zamčenými nevyhraje.
 */

import type { z } from 'zod';

import type { MECHANICS } from '../../registry';
import type { CounterDecl, MechanicAdapter, SurfaceAction, SurfaceRule, WitnessStep } from '../types';

export const KEYS_COUNTER = 'keysHeld';

type Params = z.infer<(typeof MECHANICS)['lock_key']['params']>;

export const lockKey: MechanicAdapter<Params> = (params, ctx) => {
  const rules: Record<string, SurfaceRule> = {};
  const counters: Record<string, CounterDecl> = { [KEYS_COUNTER]: { min: 0, max: params.keysNeeded, init: 0 } };
  const witness: WitnessStep[] = [];
  for (const key of ctx.instances(params.keyRole)) {
    const taken = `${key}_taken`;
    counters[taken] = { min: 0, max: 1, init: 0 };
    const pick = `lock_key.${key}.pick`;
    rules[pick] = {
      id: pick,
      phase: 0,
      priority: 0,
      event: { kind: 'onPickup', entity: key },
      condition: { kind: 'counterIs', ref: taken, op: '=', value: 0 },
      actions: [
        { kind: 'addCounter', ref: taken, by: 1 },
        { kind: 'addCounter', ref: KEYS_COUNTER, by: 1 },
      ],
    };
    if (witness.length < params.keysNeeded) witness.push({ actionId: 'pickup', target: key, stage: 0 });
  }
  const unlock = `lock_key.${params.doorRole}.unlock`;
  rules[unlock] = {
    id: unlock,
    phase: 1,
    priority: 0,
    event: { kind: 'onCounterReaches', ref: KEYS_COUNTER, threshold: params.keysNeeded },
    condition: null,
    actions: ctx.instances(params.doorRole).flatMap((door): SurfaceAction[] => [
      { kind: 'setLocked', target: door, locked: false },
      { kind: 'setState', target: door, value: 'open' },
    ]),
  };
  return { counters, rules, witness };
};
