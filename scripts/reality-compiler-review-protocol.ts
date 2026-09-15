/** Offline artifact validation only. Never launches inference or approves UI. */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { PARAMETER_KEYS } from '../src/worldstream/source-parameters';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const id = z.string().min(1).max(200);
const ms = z.number().finite().nonnegative();
const artifact = z.strictObject({ path: id, sha256: hash });
const config = z.strictObject({
  model: id, effort: z.literal('low'), transport: z.literal('official-codex-cli-chatgpt'),
  billing: z.literal('subscription'), apiFallback: z.literal(false),
  timeoutMs: z.number().int().positive(), limitsHash: hash,
  deviceProfile: artifact, runtimeValidation: artifact, sandboxValidation: artifact,
});
const build = z.strictObject({ commit: z.string().regex(/^[a-f0-9]{40}$/), dirtyPatch: artifact.nullable(), build: artifact });
export const experimentSchema = z.strictObject({
  version: z.literal('reality-compiler-review-v2'), classification: z.literal('development'),
  experimentId: id, frozenAt: z.iso.datetime(),
  change: z.strictObject({ description: id, patch: artifact }),
  config, before: build, after: build,
  cases: z.array(z.strictObject({
    id, kind: z.enum(['source', 'prompt']), category: z.enum(['complete', 'missing', 'conflict', 'ordinary']),
    input: artifact, inputLog: artifact, intervention: artifact, repetitions: z.number().int().min(1).max(30),
  })).min(1).max(100),
}).superRefine((value, ctx) => {
  const ids = new Set<string>();
  value.cases.forEach((entry, index) => {
    if (ids.has(entry.id)) ctx.addIssue({ code: 'custom', path: ['cases', index, 'id'], message: 'Duplicate case' });
    ids.add(entry.id);
    if ((entry.kind === 'prompt') !== (entry.category === 'ordinary'))
      ctx.addIssue({ code: 'custom', path: ['cases', index, 'category'], message: 'Category does not match input kind' });
  });
});
export type ReviewExperiment = z.infer<typeof experimentSchema>;

// Keys are sorted recursively; the digest binds the parsed manifest, not JSON whitespace.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(',')}}`;
  return JSON.stringify(value);
}

/** Caller supplies a reader rooted in its artifact directory. No credentials,
 * network access or process launching belongs in this offline check. */
export function verifyReviewArtifacts(value: unknown, readBytes: (path: string) => Uint8Array): number {
  let checked = 0;
  function visit(node: unknown): void {
    if (Array.isArray(node)) { node.forEach(visit); return; }
    if (node === null || typeof node !== 'object') return;
    const record = node as Record<string, unknown>;
    if ('path' in record && 'sha256' in record) {
      const ref = artifact.parse(record);
      if (ref.path.includes('\\') || ref.path.startsWith('/') || ref.path.includes(':') ||
        ref.path.split('/').some(part => part === '..' || part === '.' || part === '')) throw new Error('INVALID_ARTIFACT_PATH');
      if (createHash('sha256').update(readBytes(ref.path)).digest('hex') !== ref.sha256) throw new Error(`ARTIFACT_HASH_MISMATCH: ${ref.path}`);
      checked++;
    } else Object.values(record).forEach(visit);
  }
  visit(value);
  return checked;
}
export function experimentDigest(value: unknown): string {
  return createHash('sha256').update(canonical(experimentSchema.parse(value))).digest('hex');
}

const review = z.strictObject({
  actor: z.literal('human'), reviewerId: id, proposalHash: hash,
  shownAtMs: ms, decidedAtMs: ms, decision: z.enum(['confirmed', 'rejected']),
  confirmed: z.array(z.enum(PARAMETER_KEYS)).max(PARAMETER_KEYS.length), record: artifact,
}).superRefine((value, ctx) => {
  if (value.decidedAtMs < value.shownAtMs) ctx.addIssue({ code: 'custom', message: 'Review time reversed' });
  if (new Set(value.confirmed).size !== value.confirmed.length)
    ctx.addIssue({ code: 'custom', message: 'Duplicate parameter acknowledgement' });
  if (value.decision === 'confirmed' && value.confirmed.length !== PARAMETER_KEYS.length)
    ctx.addIssue({ code: 'custom', message: 'All seven parameters require acknowledgement' });
});
const phaseNames = ['preflight', 'provider', 'parse', 'validation', 'acceptance', 'lowering', 'mesh', 'frame', 'interaction', 'compare'] as const;
export const attemptSchema = z.strictObject({
  id, caseId: id, arm: z.enum(['before', 'after']), repetition: z.number().int().positive(),
  attempt: z.number().int().positive(), retryOf: id.nullable(), experimentHash: hash, config,
  origin: z.enum(['live', 'prepared', 'cache']), startedAt: z.iso.datetime(), elapsedMs: ms,
  outcome: z.enum(['completed', 'clarification-required', 'review-rejected', 'failed', 'cancelled', 'interrupted']),
  error: id.nullable(), journal: artifact, proposalHash: hash.nullable(),
  proposal: artifact.nullable(), supplements: z.array(artifact),
  parameterReview: review.nullable(), humanWaitMs: ms.nullable(),
  stagesMs: z.strictObject(Object.fromEntries(phaseNames.map(name => [name, ms.nullable()])) as Record<typeof phaseNames[number], z.ZodNullable<typeof ms>>),
  inputBytes: z.number().int().nonnegative().nullable(), outputBytes: z.number().int().nonnegative().nullable(),
  modelCalls: z.number().int().nonnegative(), usage: z.record(z.string(), z.number().finite().nonnegative()).nullable(), usd: z.null(),
  remoteCompletion: z.enum(['confirmed', 'unknown', 'not-started']),
  semanticReview: z.literal('NOT_RUN'),
}).superRefine((value, ctx) => {
  const fail = (message: string) => ctx.addIssue({ code: 'custom', message });
  if (value.parameterReview) {
    if (value.parameterReview.proposalHash !== value.proposalHash || !value.proposal) fail('Review must bind recorded proposal');
    if (value.parameterReview.decidedAtMs > value.elapsedMs) fail('Review exceeds attempt duration');
    if (value.humanWaitMs !== value.parameterReview.decidedAtMs - value.parameterReview.shownAtMs) fail('Human wait must equal separate review interval');
  } else if (value.humanWaitMs !== null) fail('Unobserved human wait must be null');
  if (['failed', 'cancelled', 'interrupted'].includes(value.outcome) && value.error === null) fail('Unsuccessful attempt needs explicit reason');
  if (value.modelCalls === 0 && value.remoteCompletion !== 'not-started') fail('No call means remote not started');
  if (value.modelCalls > 0 && value.remoteCompletion === 'not-started') fail('Model calls contradict remote not started');
  if (value.outcome === 'completed' && value.modelCalls > 0 && value.remoteCompletion !== 'confirmed') fail('Completed requires confirmed remote completion');
});
export type ReviewAttempt = z.infer<typeof attemptSchema>;

export const runSchema = z.strictObject({
  version: z.literal('reality-compiler-review-run-v2'), experimentHash: hash,
  status: z.enum(['NOT_RUN', 'IN_PROGRESS', 'FINISHED']), attempts: z.array(attemptSchema),
});

/** Reject incomplete FINISHED series and cherry-picked/reordered retry chains.
 * Artifact hashes and human identity still require external evidence inspection. */
export function validateReviewRun(manifest: unknown, input: unknown) {
  const experiment = experimentSchema.parse(manifest);
  const run = runSchema.parse(input);
  const digest = experimentDigest(experiment);
  if (run.experimentHash !== digest) throw new Error('EXPERIMENT_HASH_MISMATCH');
  if ((run.status === 'NOT_RUN') !== (run.attempts.length === 0)) throw new Error('RUN_STATUS_MISMATCH');
  const ids = new Set<string>();
  const slots = new Map<string, ReviewAttempt>();
  for (const attempt of run.attempts) {
    if (ids.has(attempt.id)) throw new Error('DUPLICATE_ATTEMPT');
    ids.add(attempt.id);
    if (attempt.experimentHash !== digest || canonical(attempt.config) !== canonical(experiment.config)) throw new Error('FROZEN_CONFIG_MISMATCH');
    if (Date.parse(attempt.startedAt) < Date.parse(experiment.frozenAt)) throw new Error('ATTEMPT_BEFORE_FREEZE');
    const entry = experiment.cases.find(item => item.id === attempt.caseId);
    if (!entry || attempt.repetition > entry.repetitions) throw new Error('UNPLANNED_ATTEMPT');
    const slot = `${attempt.caseId}/${attempt.arm}/${attempt.repetition}`;
    const previous = slots.get(slot);
    if (attempt.attempt !== (previous?.attempt ?? 0) + 1 || attempt.retryOf !== (previous?.id ?? null)) throw new Error('RETRY_HISTORY_MISSING');
    if (entry.kind === 'source' && attempt.outcome === 'completed' && attempt.parameterReview?.decision !== 'confirmed') throw new Error('PARAMETER_REVIEW_REQUIRED');
    if (attempt.outcome === 'review-rejected' && attempt.parameterReview?.decision !== 'rejected') throw new Error('REJECTION_RECORD_REQUIRED');
    if (attempt.outcome === 'clarification-required' && (entry.kind !== 'source' || attempt.parameterReview?.decision === 'confirmed')) throw new Error('INVALID_CLARIFICATION_OUTCOME');
    if (entry.kind === 'prompt' && attempt.parameterReview !== null) throw new Error('PROMPT_REVIEW_NOT_APPLICABLE');
    slots.set(slot, attempt);
  }
  const planned = experiment.cases.reduce((sum, entry) => sum + entry.repetitions * 2, 0);
  if (run.status === 'FINISHED' && slots.size !== planned) throw new Error('PLANNED_ATTEMPTS_MISSING');
  return { experiment, run, coverage: { planned, recorded: slots.size },
    counts: Object.fromEntries(['completed', 'clarification-required', 'review-rejected', 'failed', 'cancelled', 'interrupted']
      .map(outcome => [outcome, run.attempts.filter(attempt => attempt.outcome === outcome).length])),
    semanticReview: 'NOT_RUN' as const, humanIdentityVerified: false as const,
  };
}
