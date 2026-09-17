import type { SceneSpec } from './spec';

export interface VisualObservation {
  stableId: string; built: boolean; loaded: boolean; inFrame: boolean;
  screenPixels: number; unoccludedSamples: number; samples: number;
}
/** Recognizability needs an explicit human judgment; projections cannot establish it. */
export function visibilityReport(spec: SceneSpec, observations: readonly VisualObservation[],
  expected: readonly { description: string; instanceIds: readonly string[] }[] = [],
  judgments: Readonly<Partial<Record<string, boolean>>> = {}) {
  const byId = new Map(observations.map(item => [item.stableId,item]));
  const planned = new Set(spec.instances.map(item => item.stableId));
  const requirements = [...spec.requirements.filter(r => r.polarity === 'required'), ...expected];
  return requirements.map(requirement => ({ description: requirement.description,
    instances: requirement.instanceIds.map(stableId => {
      const observed = byId.get(stableId);
      const status = !planned.has(stableId) ? 'absent' : !observed?.built ? 'planned'
        : !observed.loaded ? 'built' : !observed.inFrame || observed.unoccludedSamples === 0 || observed.screenPixels < 24 ? 'loaded'
        : judgments[stableId] === true ? 'recognizable' : 'visible';
      return { stableId, status, recognition: judgments[stableId] ?? 'unreviewed',
        observation: observed ?? null,
        repair: status === 'absent' ? 'Restore the omitted requirement in the semantic plan.'
          : status === 'planned' ? 'Build this instance.' : status === 'built' ? 'Load its representation.'
          : status === 'loaded' ? 'Inspect framing or occlusion for this instance.'
          : judgments[stableId] === false ? 'Revise this representation; its identity was not recognized.' : null };
    }),
  }));
}
