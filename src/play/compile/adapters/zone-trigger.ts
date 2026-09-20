/**
 * `zone_trigger`: vstup do zóny role (nebo odchod z ní) vyhraje, prohraje
 * nebo vyšle signál. Jedno pravidlo na instanci role – zóna instance je její
 * soket (+ obdélník z rozvržení, viz `sim.ts`).
 *
 * Výhra nese stráž cíle (`objectiveGuard`): u `collect` je to „sebráno vše“,
 * jinak by východ vyhrál hned po příchodu a hledač by sběr přeskočil.
 */

import type { z } from 'zod';

import type { MECHANICS } from '../../registry';
import type { MechanicAdapter, SurfaceAction, SurfaceRule } from '../types';
import { objectiveGuard } from './objective';

type Params = z.infer<(typeof MECHANICS)['zone_trigger']['params']>;

export const zoneTrigger: MechanicAdapter<Params> = (params, ctx) => {
  const rules: Record<string, SurfaceRule> = {};
  const action: SurfaceAction =
    params.effect === 'signal' ? { kind: 'emit', signal: params.signal ?? `${params.role}Triggered` } : { kind: params.effect };
  const condition = params.effect === 'win' ? objectiveGuard(ctx) : null;
  for (const instance of ctx.instances(params.role)) {
    const id = `zone_trigger.${instance}`;
    rules[id] = {
      id,
      phase: 2,
      priority: 0,
      event: { kind: params.when === 'enter' ? 'onEnterZone' : 'onExitZone', entity: ctx.player, zone: instance },
      condition,
      actions: [action],
    };
  }
  // Svědek vstoupí do první instance; `exit` bývá jedna, u víc je první tak dobrá jako jiná.
  const [first] = ctx.instances(params.role);
  const witness = params.effect === 'win' && params.when === 'enter' && first !== undefined ? [{ actionId: 'moveTo' as const, target: first, stage: 1 as const }] : [];
  return { rules, witness };
};
