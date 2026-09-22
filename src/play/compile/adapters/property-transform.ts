/**
 * `property_transform`: instance role přejde ze stavu `from` do `to` na
 * `use`, na signál nebo po doběhnutí časovače. Jedno pravidlo na instanci se
 * stráží `stateIs(from)`, takže druhé spuštění už nic nemění.
 *
 * Výchozí stav entity dává druh role (`ROLE_INITIAL_STATE` ve `spec.ts`);
 * `from`, který se s ním neshoduje a žádná mechanika ho nenastaví, odmítne už
 * `readGameSpec`. Časovač trvá `afterSeconds` (výchozí 10); signál bez jména
 * je `<role>Triggered`, tj. výchozí jméno `zone_trigger` na téže roli.
 */

import type { z } from 'zod';

import type { MECHANICS } from '../../registry';
import type { MechanicAdapter, SurfaceEvent, SurfaceRule, TimerDecl } from '../types';
import { TICKS_PER_SECOND } from './timer';

type Params = z.infer<(typeof MECHANICS)['property_transform']['params']>;

export const propertyTransform: MechanicAdapter<Params> = (params, ctx) => {
  const rules: Record<string, SurfaceRule> = {};
  const timers: Record<string, TimerDecl> = {};
  const timerId = `${params.role}_transform`;
  if (params.trigger === 'timer') {
    const ticks = params.afterSeconds * TICKS_PER_SECOND;
    timers[timerId] = { durationTicks: ticks, init: ticks };
  }
  const trigger = (instance: string): SurfaceEvent => {
    switch (params.trigger) {
      case 'use':
        return { kind: 'onAction', actor: ctx.player, actionId: 'use', target: instance };
      case 'signal':
        return { kind: 'onSignal', name: params.signal ?? `${params.role}Triggered` };
      case 'timer':
        return { kind: 'onTimerEnd', timer: timerId };
    }
  };
  for (const instance of ctx.instances(params.role)) {
    const id = `property_transform.${instance}`;
    rules[id] = {
      id,
      phase: 1,
      priority: 0,
      event: trigger(instance),
      condition: { kind: 'stateIs', target: instance, value: params.from },
      actions: [{ kind: 'setState', target: instance, value: params.to }],
    };
  }
  return { rules, timers };
};
