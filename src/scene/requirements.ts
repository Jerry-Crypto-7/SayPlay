import type { SceneSpec } from './spec';

/** Independent, human-authored prompt oracle. Never derive this from planner output. */
export interface RequirementExpectation {
  readonly quote: string;
  readonly count: number;
  readonly polarity: 'required' | 'forbidden';
  readonly attributes?: readonly { name: string; value: string }[];
}

/** Semantic ledger coverage, explicitly not visual recognizability. */
export function auditRequirements(spec: SceneSpec, expected: readonly RequirementExpectation[]): string[] {
  const failures: string[] = [];
  for (const oracle of expected) {
    const matches = spec.requirements.filter((r) => r.provenance.kind === 'requested' && r.provenance.quote === oracle.quote && r.polarity === oracle.polarity);
    if (matches.length !== 1) { failures.push(`Expected one requirement for: ${oracle.quote}`); continue; }
    const requirement = matches[0];
    if (requirement.count !== oracle.count) failures.push(`Expected ${oracle.count} instances for: ${oracle.quote}`);
    for (const instanceId of requirement.instanceIds) {
      const instance = spec.instances.find((i) => i.stableId === instanceId);
      for (const attribute of oracle.attributes ?? [])
        if (!instance?.attributes.some((a) => a.name === attribute.name && a.value === attribute.value)) failures.push(`Missing ${attribute.name}=${attribute.value} on ${instanceId}`);
    }
  }
  return failures;
}
