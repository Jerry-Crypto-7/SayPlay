import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { PARAMETER_KEYS } from '../../src/worldstream/source-parameters';
import type { SourceObservation } from '../../src/worldstream/browser-measurement';
import { createPipelineMetrics } from '../../src/worldstream/pipeline-metrics';
import type { ReviewExperiment } from '../reality-compiler-review-protocol';
import { assertReviewTransportReady, createReviewSessionRecorder, type ReviewArtifactSink, type ReviewUIEvent } from '../reality-compiler-review-runner';
import { productionValidationSchema, SUBSCRIPTION_PRODUCTION_PROFILE } from '../subscription-production-profile';

const hash = 'a'.repeat(64), ref = { path: 'inputs/source.txt', sha256: hash };
const manifest: ReviewExperiment = {
  version: 'reality-compiler-review-v2', classification: 'development', experimentId: 'recorder-unit-fixture', frozenAt: '2020-01-01T00:00:00Z',
  change: { description: 'Unit fixture only', patch: ref },
  config: { model: 'fixture-model', effort: 'low', transport: 'official-codex-cli-chatgpt', billing: 'subscription', apiFallback: false,
    timeoutMs: 180000, limitsHash: hash, deviceProfile: ref, runtimeValidation: ref, sandboxValidation: ref },
  before: { commit: 'a'.repeat(40), dirtyPatch: null, build: ref }, after: { commit: 'b'.repeat(40), dirtyPatch: null, build: ref },
  cases: [{ id: 'source-1', kind: 'source', category: 'complete', input: ref, inputLog: ref, intervention: ref, repetitions: 1 }],
};
const slot = { id: 'attempt-1', caseId: 'source-1', arm: 'before' as const, repetition: 1, attempt: 1, retryOf: null };
function memorySink() {
  const files = new Map<string, unknown>(), journal: unknown[] = [], late: unknown[] = [];
  const sink: ReviewArtifactSink = {
    write(name, value) {
      if (files.has(name)) throw new Error('OVERWRITE');
      files.set(name, structuredClone(value));
      return { path: `attempt/${name}`, sha256: createHash('sha256').update(JSON.stringify(value)).digest('hex') };
    },
    append(event) { journal.push(structuredClone(event)); }, late(event) { late.push(structuredClone(event)); },
    seal() { return { path: 'attempt/journal.jsonl', sha256: createHash('sha256').update(JSON.stringify(journal)).digest('hex') }; },
  };
  return { sink, files, journal, late };
}
function setup(mode: 'manual-live' | 'fixture-smoke' = 'manual-live') {
  const output = memorySink(); let now = 0, sequence = 0;
  const recorder = createReviewSessionRecorder({ experiment: manifest, slot, mode, reviewerId: mode === 'manual-live' ? 'synthetic-unit-event' : null,
    sink: output.sink, now: () => now, date: () => new Date('2026-09-09T00:00:00Z') });
  const event = (kind: ReviewUIEvent['kind'], trusted = true, extra: Partial<ReviewUIEvent> = {}) =>
    recorder.event({ sequence: ++sequence, browserAtMs: now, trusted, kind, ...extra });
  const proposal = () => { event('source-submit'); recorder.beginRequest({ text: 'Frozen source' }); recorder.proposal({ kind: 'proposed' }, hash, 20); };
  const acknowledge = (trusted = true) => { event('review-shown', false); for (const key of PARAMETER_KEYS) event('parameter-change', trusted, { key, value: 'supported' }); event('confirm', trusted); };
  return { ...output, recorder, event, proposal, acknowledge, advance: (ms: number) => { now += ms; } };
}
const intervention = { ruleId: 'timer', durationTicks: 200, forkTick: 0, observationTick: 300 };
const observation = (proposalHash = hash) => ({ project: { parameterConfirmation: { proposalHash }, comparison: intervention }, inputs: [] } as unknown as SourceObservation);

describe('development session recorder, synthetic unit events only', () => {
  it('fails closed before provider work without explicit manual submit', () => {
    const run = setup();
    expect(() => run.recorder.beginRequest({ text: 'source' })).toThrow('MANUAL_SOURCE_SUBMIT_REQUIRED');
    expect(run.recorder.finish().protocolAttempt).toMatchObject({ outcome: 'failed', modelCalls: 0, parameterReview: null });
    expect(run.journal[0]).toMatchObject({ event: 'attempt-start' });
  });
  it('never converts accepted browser state without observed confirmation into a human result', () => {
    const run = setup(); run.proposal();
    run.recorder.observe(observation(), null);
    expect(run.recorder.finish().protocolAttempt).toMatchObject({ outcome: 'failed', error: 'PARAMETER_REVIEW_REQUIRED', parameterReview: null });
  });
  it('ignores scripted confirmation events and leaves human review unrecorded', () => {
    const run = setup(); run.proposal(); run.acknowledge(false);
    run.recorder.observe(observation(), null);
    expect(run.recorder.finish().protocolAttempt?.parameterReview).toBeNull();
    expect(run.files.has('parameter-review.json')).toBe(false);
  });
  it('requires all seven independently observed acknowledgements', () => {
    const run = setup(); run.proposal(); run.event('review-shown', false);
    for (const key of PARAMETER_KEYS.slice(1)) run.event('parameter-change', true, { key, value: 'supported' });
    run.event('confirm');
    expect(run.recorder.error).toBe('PARAMETER_REVIEW_REQUIRED');
  });
  it('removes a formerly supported acknowledgement when changed back', () => {
    const run = setup(); run.proposal(); run.event('review-shown', false);
    for (const key of PARAMETER_KEYS) run.event('parameter-change', true, { key, value: 'supported' });
    run.event('parameter-change', true, { key: 'duration', value: 'missing' }); run.event('confirm');
    expect(run.recorder.error).toBe('PARAMETER_REVIEW_REQUIRED');
  });
  it('binds review to the displayed proposal and separates the observed waiting interval', () => {
    const run = setup(); run.proposal(); run.advance(20); run.event('review-shown', false); run.advance(1000);
    for (const key of PARAMETER_KEYS) run.event('parameter-change', true, { key, value: 'supported' }); run.event('confirm');
    run.recorder.observe(observation(), null); run.recorder.complete([], intervention);
    const result = run.recorder.finish();
    expect(result.protocolAttempt).toMatchObject({ outcome: 'completed', humanWaitMs: 1000, parameterReview: { proposalHash: hash } });
    expect(result).toHaveProperty('humanIdentityVerified', false);
    expect(result.protocolAttempt?.semanticReview).toBe('NOT_RUN');
  });
  it('refuses an acceptance bound to another proposal', () => {
    const run = setup(); run.proposal(); run.acknowledge(); run.recorder.observe(observation('b'.repeat(64)), null);
    expect(run.recorder.finish().protocolAttempt?.error).toBe('PARAMETER_REVIEW_REQUIRED');
  });
  it('preserves a nonzero browser review interval when polling delivers all events at the same recorder time', () => {
    const run = setup(); run.proposal(); run.advance(1000);
    run.event('review-shown', false, { browserAtMs: 100 });
    for (const key of PARAMETER_KEYS) run.event('parameter-change', true, { key, value: 'supported', browserAtMs: 120 });
    run.event('confirm', true, { browserAtMs: 150 });
    run.recorder.observe(observation(), null); run.recorder.complete([], intervention);
    expect(run.recorder.finish().protocolAttempt).toMatchObject({ humanWaitMs: 50,
      parameterReview: { shownAtMs: 950, decidedAtMs: 1000 } });
    expect(run.files.get('parameter-review.json')).toMatchObject({ shownAtReceiptMs: 1000, shownBrowserAtMs: 100, decidedBrowserAtMs: 150 });
  });
  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY, 5])('rejects invalid or reversed browser clock %s', value => {
    const run = setup(); run.event('source-submit', true, { browserAtMs: 10 });
    run.event('review-shown', false, { browserAtMs: value });
    expect(run.recorder.finish().protocolAttempt?.error).toBe('UI_EVENT_CLOCK_INVALID');
  });
  it('records a deliberate review rejection without pretending it completed', () => {
    const run = setup(); run.proposal(); run.event('review-shown', false); run.event('discard');
    expect(run.recorder.finish().protocolAttempt).toMatchObject({ outcome: 'review-rejected', parameterReview: { decision: 'rejected' } });
  });
  it('invalidates an attempt if its frozen input changes after submission', () => {
    const run = setup(); run.proposal(); run.event('input-change');
    expect(run.recorder.finish().protocolAttempt?.error).toBe('FROZEN_INPUT_CHANGED');
  });
  it('forbids a hidden clarification resubmit within the same attempt', () => {
    const run = setup(); run.proposal(); run.event('source-submit');
    expect(() => run.recorder.beginRequest({ text: 'supplemented' })).toThrow('ONE_SOURCE_REQUEST_PER_ATTEMPT');
  });
  it('archives needsClarification without confirmation or fictional failure completion', () => {
    const run = setup(); run.event('source-submit'); run.recorder.beginRequest({ text: 'missing duration' });
    run.recorder.proposal({ kind: 'needsClarification', questions: ['Duration?'] }, null, 45);
    expect(run.recorder.finish().protocolAttempt).toMatchObject({ outcome: 'clarification-required', parameterReview: null, proposal: null });
  });
  it('retains cancellation and appends late provider completion without mutating sealed journal', () => {
    const run = setup(); run.event('source-submit'); run.recorder.beginRequest({ text: 'frozen' });
    const finishProvider = run.recorder.providerStarted({ model: 'fixture-model' });
    run.advance(100); run.event('source-cancel');
    const result = run.recorder.finish(); const originalJournal = structuredClone(run.journal);
    expect(result.protocolAttempt).toMatchObject({ outcome: 'cancelled', modelCalls: 1, remoteCompletion: 'unknown' });
    finishProvider({ output: { answer: 'late' } });
    expect(run.journal).toEqual(originalJournal); expect(run.late).toHaveLength(1);
  });
  it('does not relabel provider errors as confirmed remote cancellation', () => {
    const run = setup(); run.event('source-submit'); run.recorder.beginRequest({ text: 'frozen' });
    const finish = run.recorder.providerStarted({}); run.advance(50); finish({ error: 'PROVIDER_FAILED' });
    run.recorder.fail('SOURCE_BRIDGE_FAILED');
    expect(run.recorder.finish().protocolAttempt).toMatchObject({ remoteCompletion: 'unknown', stagesMs: { provider: null } });
  });
  it('separates fixture completion from any review-v2 human attempt', () => {
    const run = setup('fixture-smoke'); run.proposal(); run.acknowledge(); run.recorder.observe(observation(), null); run.recorder.complete([], intervention);
    const result = run.recorder.finish();
    expect(result).toMatchObject({ protocolAttempt: null, humanConfirmations: 0, modelCalls: 0, humanObservation: false, result: { outcome: 'completed', parameterReview: null } });
    expect(run.files.has('attempt.json')).toBe(false);
  });
  it.each(['inputs', 'intervention'] as const)('refuses changed frozen %s', what => {
    const run = setup(); run.proposal(); run.acknowledge(); run.recorder.observe(observation(), null);
    run.recorder.complete(what === 'inputs' ? [{ tick: 1 }] : [], what === 'intervention' ? { ...intervention, durationTicks: 300 } : intervention);
    expect(run.recorder.finish().protocolAttempt?.error).toBe(what === 'inputs' ? 'FROZEN_INPUT_LOG_MISMATCH' : 'FROZEN_INTERVENTION_MISMATCH');
  });
  it('retains raw client stages and refuses to manufacture pending durations', () => {
    const run = setup(); const metrics = createPipelineMetrics({ now: () => 10 });
    const measured = metrics.startRun({ generation: 1, kind: 'source' }); metrics.startStage(measured, 'first-frame');
    run.recorder.observe(null, metrics.snapshot());
    expect(run.recorder.finish().protocolAttempt?.stagesMs.frame).toBeNull();
    expect(run.files.get('client-pipeline.json')).toEqual(metrics.snapshot());
  });
  it('rejects unplanned repetitions and omitted retry history before opening the session', () => {
    const output = memorySink();
    for (const changed of [{ repetition: 2 }, { attempt: 2, retryOf: 'hidden-1' }])
      expect(() => createReviewSessionRecorder({ experiment: manifest, slot: { ...slot, ...changed }, mode: 'fixture-smoke', reviewerId: null, sink: output.sink })).toThrow('INVALID_PLANNED_ATTEMPT');
    expect(output.journal).toHaveLength(0);
  });
  it('requires complete production evidence, separate current identity, frozen profile and reviewer (synthetic unit fixture only)', () => {
    const identity = { validationRunId: 'synthetic-unit-only', launcherSha256: hash, runtimeSha256: 'b'.repeat(64) };
    const validation = productionValidationSchema.parse({ kind: 'subscription-production-profile-validation', version: 1,
      profile: { ...SUBSCRIPTION_PRODUCTION_PROFILE }, identity,
      stages: Object.fromEntries(Object.entries(productionValidationSchema.shape.stages.shape).map(([name, schema]) =>
        [name, { status: 'PASS', reportSha256: hash, checks: Object.fromEntries(Object.keys(schema.shape.checks.shape).map(key => [key, true])) }])) });
    const experiment = { ...manifest, config: { ...manifest.config, model: SUBSCRIPTION_PRODUCTION_PROFILE.model } };
    const ready = { validation, config: experiment.config };
    expect(() => assertReviewTransportReady(experiment, ready, null, identity)).toThrow('PARAMETER_REVIEW_REQUIRED');
    expect(() => assertReviewTransportReady(experiment, { ...ready, validation: null }, 'reviewer', identity)).toThrow('SUBSCRIPTION_PRODUCTION_NOT_VALIDATED');
    expect(() => assertReviewTransportReady(experiment, ready, 'reviewer', { ...identity, runtimeSha256: 'c'.repeat(64) })).toThrow('SUBSCRIPTION_PRODUCTION_NOT_VALIDATED');
    expect(() => assertReviewTransportReady(experiment, { ...ready, config: { ...ready.config, model: 'different' } }, 'reviewer', identity)).toThrow('FROZEN_CONFIG_MISMATCH');
    expect(() => assertReviewTransportReady(manifest, { ...ready, config: manifest.config }, 'reviewer', identity)).toThrow('PRODUCTION_PROFILE_CONFIG_MISMATCH');
    expect(() => assertReviewTransportReady(experiment, ready, 'reviewer', identity)).not.toThrow();
    for (const name of ['runtimeProbe', 'productionSandbox'] as const) {
      validation.stages[name].reportSha256 = 'c'.repeat(64);
      expect(() => assertReviewTransportReady(experiment, ready, 'reviewer', identity)).toThrow('FROZEN_VALIDATION_EVIDENCE_MISMATCH');
      validation.stages[name].reportSha256 = hash;
    }
    validation.stages.productionNetwork.status = 'FAIL';
    expect(() => assertReviewTransportReady(experiment, ready, 'reviewer', identity)).toThrow('SUBSCRIPTION_PRODUCTION_NOT_VALIDATED');
  });
});
