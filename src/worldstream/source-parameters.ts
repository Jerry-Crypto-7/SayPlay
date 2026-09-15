/** Human parameter acknowledgement is separate from independent semantic review. */
import { z } from 'zod';
import { canonical, type SimPart } from '../ir/worlddoc';
import type { EvidenceRevision, SourceSnapshot } from './evidence';

export const PARAMETER_KEYS = ['trigger', 'initial', 'proximity', 'duration', 'expiration', 'reset', 'ordering'] as const;
export type ParameterKey = typeof PARAMETER_KEYS[number];
export const PARAMETER_LABELS: Record<ParameterKey, string> = {
  trigger: 'Trigger and conditions', initial: 'Initial state', proximity: 'Proximity and distance',
  duration: 'Timer duration and units', expiration: 'Expiration and outcome',
  reset: 'Reset and repetition', ordering: 'Events on the same tick',
};
export const parameterConfirmationSchema = z.strictObject({
  version: z.literal('source-parameters-v1'), proposalHash: z.string().regex(/^[a-f0-9]{64}$/),
  confirmed: z.array(z.enum(PARAMETER_KEYS)).length(PARAMETER_KEYS.length)
    .refine(values => new Set(values).size === PARAMETER_KEYS.length),
});
export type ParameterConfirmation = z.infer<typeof parameterConfirmationSchema>;
type Rule = { event: Record<string, unknown>; condition: Record<string, unknown>; actions: Record<string, unknown>[] };
export const sourceRulesSchema = z.record(z.string(), z.object({
  id: z.string().optional(), event: z.object({ kind: z.string() }).passthrough(),
  condition: z.object({ kind: z.string() }).passthrough(),
  actions: z.array(z.object({ kind: z.string() }).passthrough()).min(1).max(64),
}).passthrough());

/** Deliberately read action durations, never the timer's declared capacity.
 * The general lowerer supports a legacy fallback; the source pilot does not. */
export function explicitTimerIssues(sim: SimPart): string[] {
  const issues: string[] = [];
  const rules = sourceRulesSchema.safeParse(sim.rules);
  if (!rules.success) return ['The proposed rules cannot be reviewed.'];
  for (const [id, rule] of Object.entries(rules.data)) {
    for (const action of rule.actions ?? []) if (action.kind === 'startTimer' &&
      (!Number.isSafeInteger(action.durationTicks) || Number(action.durationTicks) < 1 || Number(action.durationTicks) > 3600)) {
      issues.push(`Rule ${id} needs an explicit start duration in integer ticks (20 ticks per second). Timer capacity is not a start duration.`);
    }
  }
  return issues;
}

export async function parameterProposalHash(sim: SimPart, sources: readonly SourceSnapshot[], evidence: EvidenceRevision): Promise<string> {
  // Acceptance rebinds the proposal to the complete WorldDoc. That mechanical
  // revision/hash seal does not change the declarations the user reviewed.
  const { evidenceHash: _hash, worldRevision: _revision, ...support } = evidence;
  const bytes = new TextEncoder().encode(canonical({ version: 'source-parameters-v1', sim, sources, evidence: support }));
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function validateParameterConfirmation(value: unknown, sim: SimPart,
  sources: readonly SourceSnapshot[], evidence: EvidenceRevision): Promise<boolean> {
  const parsed = parameterConfirmationSchema.safeParse(value);
  return parsed.success && explicitTimerIssues(sim).length === 0 &&
    parsed.data.proposalHash === await parameterProposalHash(sim, sources, evidence);
}

/** These are actual declarations, not a second model-written interpretation.
 * Displaying and acknowledging them cannot certify natural-language support. */
export function parameterDeclarations(sim: SimPart): Record<ParameterKey, unknown> {
  const rules = Object.entries(sim.rules as Record<string, Rule>);
  return {
    trigger: rules.map(([id, rule]) => ({ rule: id, event: rule.event, condition: rule.condition })),
    initial: { entities: sim.entities, state: sim.state },
    proximity: { grid: sim.grid, sockets: sim.sockets, conditions: rules.map(([id, rule]) => ({ rule: id, condition: rule.condition })) },
    duration: rules.flatMap(([id, rule]) => rule.actions.filter(action => action.kind === 'startTimer')
      .map(action => ({ rule: id, timer: action.ref, ticks: action.durationTicks, seconds: Number(action.durationTicks) / 20 }))),
    expiration: rules.filter(([, rule]) => rule.event.kind === 'onTimerEnd').map(([id, rule]) => ({ rule: id, ...rule })),
    reset: rules.map(([id, rule]) => ({ rule: id, guard: rule.condition, effects: rule.actions })),
    ordering: '20 ticks per second. Timeout is processed before activation on the same tick. Input at tick N is visible in snapshot N+1. Check that the source agrees with these semantics.',
  };
}
