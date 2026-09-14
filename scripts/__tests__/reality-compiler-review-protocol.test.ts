import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { experimentDigest, experimentSchema, validateReviewRun, verifyReviewArtifacts, type ReviewAttempt, type ReviewExperiment } from '../reality-compiler-review-protocol';
import { PARAMETER_KEYS } from '../../src/worldstream/source-parameters';

const sha256 = 'a'.repeat(64);
const artifact = { path: 'artifacts/record.json', sha256 };
function experiment(): ReviewExperiment {
  return {
    version: 'reality-compiler-review-v2', classification: 'development', experimentId: 'dev-one-change', frozenAt: '2026-09-09T10:00:00Z',
    change: { description: 'Compact evidence bindings', patch: artifact },
    config: { model: 'existing-model', effort: 'low', transport: 'official-codex-cli-chatgpt', billing: 'subscription', apiFallback: false,
      timeoutMs: 180000, limitsHash: sha256, deviceProfile: artifact, runtimeValidation: artifact, sandboxValidation: artifact },
    before: { commit: 'a'.repeat(40), dirtyPatch: null, build: artifact }, after: { commit: 'b'.repeat(40), dirtyPatch: null, build: artifact },
    cases: [{ id: 'complete-1', kind: 'source', category: 'complete', input: artifact, inputLog: artifact, intervention: artifact, repetitions: 1 }],
  };
}
function attempt(e: ReviewExperiment, arm: 'before' | 'after' = 'before'): ReviewAttempt {
  return {
    id: `${arm}-1`, caseId: e.cases[0].id, arm, repetition: 1, attempt: 1, retryOf: null,
    experimentHash: experimentDigest(e), config: e.config, origin: 'live', startedAt: '2026-09-09T10:01:00Z', elapsedMs: 1500,
    outcome: 'completed', error: null, journal: artifact, proposalHash: sha256, proposal: artifact, supplements: [],
    parameterReview: { actor: 'human', reviewerId: 'tester-1', proposalHash: sha256, shownAtMs: 100, decidedAtMs: 1100,
      decision: 'confirmed', confirmed: [...PARAMETER_KEYS], record: artifact }, humanWaitMs: 1000,
    stagesMs: { preflight: 1, provider: 50, parse: 1, validation: 1, acceptance: 1, lowering: 1, mesh: 1, frame: 1, interaction: 1, compare: 1 },
    inputBytes: 10, outputBytes: 10, modelCalls: 1, usage: null, usd: null, remoteCompletion: 'confirmed', semanticReview: 'NOT_RUN',
  };
}
function run(e: ReviewExperiment, attempts: ReviewAttempt[], status = 'FINISHED') {
  return { version: 'reality-compiler-review-run-v2', experimentHash: experimentDigest(e), status, attempts };
}

describe('offline development review protocol', () => {
  it('checks artifact bytes and rejects mismatched hashes without launching anything', () => {
    const bytes = new TextEncoder().encode('source bytes');
    const ref = { path: 'inputs/source.txt', sha256: createHash('sha256').update(bytes).digest('hex') };
    expect(verifyReviewArtifacts({ source: ref }, () => bytes)).toBe(1);
    expect(() => verifyReviewArtifacts({ source: ref }, () => new Uint8Array())).toThrow('ARTIFACT_HASH_MISMATCH');
  });
  it.each(['../source', '/source', 'C:/source', 'inputs/../source', 'inputs\\source'])('rejects unsafe artifact path %s before reading', path => {
    expect(() => verifyReviewArtifacts({ path, sha256 }, () => { throw new Error('reader must not run'); })).toThrow('INVALID_ARTIFACT_PATH');
  });
  it('validates both arms without claiming semantic review or human identity verification', () => {
    const e = experiment();
    const result = validateReviewRun(e, run(e, [attempt(e), attempt(e, 'after')]));
    expect(result.coverage).toEqual({ planned: 2, recorded: 2 });
    expect(result.semanticReview).toBe('NOT_RUN');
    expect(result.humanIdentityVerified).toBe(false);
  });
  it('accepts an honest NOT_RUN and rejects invented independent holdout status', () => {
    const e = experiment();
    expect(validateReviewRun(e, run(e, [], 'NOT_RUN')).counts.completed).toBe(0);
    expect(experimentSchema.safeParse({ ...e, classification: 'independent-holdout' }).success).toBe(false);
  });
  it('binds canonical configuration regardless of JSON key order', () => {
    const e = experiment();
    expect(experimentDigest(Object.fromEntries(Object.entries(e).reverse()))).toBe(experimentDigest(e));
    expect(experimentDigest({ ...e, change: { ...e.change, description: 'Other change' } })).not.toBe(experimentDigest(e));
  });
  it.each(['model', 'timeoutMs', 'limitsHash'] as const)('rejects changed frozen %s', key => {
    const e = experiment(), a = attempt(e);
    a.config = { ...a.config, [key]: key === 'timeoutMs' ? 42 : key === 'limitsHash' ? 'b'.repeat(64) : 'other-model' };
    expect(() => validateReviewRun(e, run(e, [a], 'IN_PROGRESS'))).toThrow('FROZEN_CONFIG_MISMATCH');
  });
  it('requires observed human acknowledgement bound to exactly the recorded proposal', () => {
    const e = experiment(), a = attempt(e);
    a.parameterReview = null; a.humanWaitMs = null;
    expect(() => validateReviewRun(e, run(e, [a], 'IN_PROGRESS'))).toThrow('PARAMETER_REVIEW_REQUIRED');
    const stale = attempt(e); stale.proposalHash = 'b'.repeat(64);
    expect(() => validateReviewRun(e, run(e, [stale], 'IN_PROGRESS'))).toThrow('Review must bind');
  });
  it('rejects duplicated acknowledgement and conflated human timing', () => {
    const e = experiment(), a = attempt(e);
    a.parameterReview!.confirmed[0] = 'duration';
    expect(() => validateReviewRun(e, run(e, [a], 'IN_PROGRESS'))).toThrow('Duplicate parameter');
    const wrong = attempt(e); wrong.humanWaitMs = 50;
    expect(() => validateReviewRun(e, run(e, [wrong], 'IN_PROGRESS'))).toThrow('Human wait');
  });
  it('retains failures on retry and refuses an omitted first attempt', () => {
    const e = experiment(), failed = attempt(e);
    failed.outcome = 'failed'; failed.error = 'provider-timeout'; failed.remoteCompletion = 'unknown';
    const retry = { ...attempt(e), id: 'before-2', attempt: 2, retryOf: failed.id };
    const result = validateReviewRun(e, run(e, [failed, retry, attempt(e, 'after')]));
    expect(result.counts.failed).toBe(1); expect(result.counts.completed).toBe(2);
    expect(() => validateReviewRun(e, run(e, [retry, attempt(e, 'after')]))).toThrow('RETRY_HISTORY_MISSING');
  });
  it('refuses incomplete or duplicate finished series and unplanned cases', () => {
    const e = experiment(), a = attempt(e);
    expect(() => validateReviewRun(e, run(e, [a]))).toThrow('PLANNED_ATTEMPTS_MISSING');
    expect(() => validateReviewRun(e, run(e, [a, a]))).toThrow('DUPLICATE_ATTEMPT');
    expect(() => validateReviewRun(e, run(e, [{ ...a, caseId: 'surprise' }], 'IN_PROGRESS'))).toThrow('UNPLANNED_ATTEMPT');
  });
  it('does not convert unknown remote termination into completed inference', () => {
    const e = experiment(), a = attempt(e); a.remoteCompletion = 'unknown';
    expect(() => validateReviewRun(e, run(e, [a], 'IN_PROGRESS'))).toThrow('confirmed remote completion');
  });
  it('keeps ordinary prompt attempts separate from source parameter review', () => {
    const e = experiment(); e.cases[0].kind = 'prompt'; e.cases[0].category = 'ordinary';
    const a = attempt(e); a.parameterReview = null; a.humanWaitMs = null; a.proposal = null; a.proposalHash = null;
    expect(validateReviewRun(e, run(e, [a], 'IN_PROGRESS')).coverage.recorded).toBe(1);
  });
});
