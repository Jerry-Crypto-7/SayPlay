/**
 * Stráž, kterou cíl hry klade na výhru. Sdílí ji každý adaptér, jehož
 * pravidlo umí vyhrát vstupem do zóny (`zone_trigger`, `carry`, …), aby se
 * „co všechno musí být hotové“ řešilo na jednom místě.
 */

import type { MECHANICS } from '../../registry';
import type { AdapterContext, SurfaceCondition } from '../types';

type CollectibleParams = ReturnType<(typeof MECHANICS)['collectible']['params']['parse']>;

export function objectiveGuard(ctx: AdapterContext): SurfaceCondition | null {
  const objective = ctx.spec.objective;
  switch (objective.kind) {
    case 'collect': {
      const mechanic = ctx.spec.mechanics.find((m) => m.id === 'collectible' && (m.params as CollectibleParams).role === objective.role);
      const counter = (mechanic?.params as Partial<CollectibleParams> | undefined)?.counter ?? 'collected';
      return { kind: 'counterIs', ref: counter, op: '>=', value: objective.count ?? 1 };
    }
    default:
      return null;
  }
}
