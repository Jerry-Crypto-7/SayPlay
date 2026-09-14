import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runLivePromptSchedule, type LivePromptBrowserBinding, type LivePromptProductBridge } from '../reality-compiler-live-prompt-session';
import { experimentDigest, type ReviewExperiment } from '../reality-compiler-review-protocol';
import { productionValidationSchema, SUBSCRIPTION_PRODUCTION_PROFILE } from '../subscription-production-profile';
import type { ValidatedLivePromptTransport } from '../reality-compiler-live-prompt-runner';
import type { ReviewArtifactSink } from '../reality-compiler-review-runner';
import type { PromptSample } from '../reality-compiler-prompt-recorder';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function setup() {
  const bytes = Buffer.from('synthetic ordinary scheduler fixture'), ref = { path: 'fixture.txt', sha256: hash(bytes.toString()) };
  const experiment: ReviewExperiment = { version: 'reality-compiler-review-v2', classification: 'development', experimentId: 'unit',
    frozenAt: '2020-01-01T00:00:00Z', change: { description: 'synthetic', patch: ref },
    config: { model: SUBSCRIPTION_PRODUCTION_PROFILE.model, effort: 'low', transport: 'official-codex-cli-chatgpt', billing: 'subscription',
      apiFallback: false, timeoutMs: 180000, limitsHash: 'a'.repeat(64), deviceProfile: ref, runtimeValidation: ref, sandboxValidation: ref },
    before: { commit: 'a'.repeat(40), dirtyPatch: null, build: ref }, after: { commit: 'b'.repeat(40), dirtyPatch: null, build: ref },
    cases: [{ id: 'ordinary', kind: 'prompt', category: 'ordinary', input: ref, inputLog: ref, intervention: ref, repetitions: 1 }] };
  const schedule = { version: 'live-prompt-schedule-v1', frozenAt: '2020-01-02T00:00:00Z', experimentHash: experimentDigest(experiment),
    browserTimeoutMs: 500, slots: [{ id: 'first', caseId: 'ordinary', arm: 'before', repetition: 1, retryOf: null as string | null }] };
  const records = new Map<string, { files: Map<string, unknown>; journal: unknown[]; late: unknown[] }>();
  const createSink = (key: string): ReviewArtifactSink => {
    if (records.has(key)) throw new Error('DUPLICATE_SINK');
    const record = { files: new Map<string, unknown>(), journal: [] as unknown[], late: [] as unknown[] }; records.set(key, record);
    let sealed = false;
    return { write(name, value) { if (record.files.has(name)) throw new Error('OVERWRITE'); record.files.set(name, structuredClone(value)); return ref; },
      append(value) { if (sealed) throw new Error('SEALED'); record.journal.push(structuredClone(value)); },
      late(value) { record.late.push(structuredClone(value)); }, seal() { sealed = true; return ref; } };
  };
  const identity = { validationRunId: 'synthetic', launcherSha256: 'a'.repeat(64), runtimeSha256: 'b'.repeat(64) };
  const stages = Object.fromEntries(Object.entries(productionValidationSchema.shape.stages.shape).map(([name, schema]) =>
    [name, { status: 'PASS', reportSha256: ref.sha256, checks: Object.fromEntries(Object.keys(schema.shape.checks.shape).map(key => [key, true])) }]));
  const validation = productionValidationSchema.parse({ kind: 'subscription-production-profile-validation', version: 1,
    profile: { ...SUBSCRIPTION_PRODUCTION_PROFILE }, identity, stages });
  const transport: ValidatedLivePromptTransport = { readiness: vi.fn(async () => ({ config: experiment.config, validation })),
    currentIdentity: vi.fn(async () => identity), generate: vi.fn(async (_request, _signal, started) => {
      started(); return { origin: 'live' as const, raw: '{}', usage: null, remoteCompletion: 'unknown' as const };
    }) };
  let interacted = false;
  const sample = (): PromptSample => ({ pipeline: { version: 'worldstream-pipeline-v1', currentRunId: 1,
    runs: [{ runId: 1, generation: 1, kind: 'prompt', provenance: 'live', droppedStages: 0, startedAtMs: 0,
      endedAtMs: null, elapsedMs: null, outcome: 'pending', stages: [
        { stageId: 1, name: 'first-frame', provenance: 'live', outcome: 'completed', startedAtMs: 0, endedAtMs: 1, elapsedMs: 1 },
        ...(interacted ? [{ stageId: 2, name: 'first-interaction' as const, provenance: 'live' as const, outcome: 'completed' as const,
          startedAtMs: 1, endedAtMs: 2, elapsedMs: 1 }] : []),
      ] }] }, renderer: { ready: true, frames: 1, drawCalls: 1, triangles: 1 }, authoredNotice: null,
    runtime: { tick: 1, inputs: interacted ? 1 : 0 }, runtimeEvidence: { inputResult: interacted ? 'Applied: press' : null, ruleTrace: interacted ? 'rule' : null, tick: '1' } });
  const binding: LivePromptBrowserBinding = { materializationOrigin: 'provider', sessionId: 'fresh', rawSha256: hash('{}'), runId: 1, generation: 1, device: { fixture: true },
    sample: vi.fn(async () => sample()), interact: vi.fn(async input => { expect(Array.from(input)).toEqual(Array.from(bytes)); interacted = true; }), close: vi.fn(async () => undefined) };
  const bridge: LivePromptProductBridge = { open: vi.fn(async () => binding) };
  const options = { experiment, schedule, sink: createSink('schedule'), createSink: (id: string, scope: string) => createSink(`${id}-${scope}`),
    readArtifact: () => bytes, transport, bridge };
  return { options, schedule, experiment, records, transport, bridge, binding, sample };
}

describe('ordinary live session orchestration, synthetic capabilities only', () => {
  afterEach(() => vi.useRealTimers());
  it('binds frozen provider output to fresh frame and post-frame input without semantic/live benchmark credit', async () => {
    const run = setup(), result = await runLivePromptSchedule(run.options);
    expect(result).toMatchObject({ liveMeasurement: 'NOT_RUN', humanObservation: false, protocolAttempt: null,
      results: [{ outcome: 'completed', browser: { cleanupVerified: true, sessionId: 'fresh' } }] });
    expect(run.binding.close).toHaveBeenCalledOnce();
    expect(run.records.get('first-provider')?.files.has('provider-response.json')).toBe(true);
    expect(run.records.get('first-browser')?.files.has('device.json')).toBe(true);
  });
  it('refuses duplicate slots and foreign, forward or branching retries before dispatch', async () => {
    for (const mutation of ['duplicate', 'forward', 'branch']) {
      const run = setup();
      if (mutation === 'duplicate') run.schedule.slots.push({ ...run.schedule.slots[0], id: 'second' });
      if (mutation === 'forward') run.schedule.slots[0].retryOf = 'absent';
      if (mutation === 'branch') run.schedule.slots.push({ ...run.schedule.slots[0], id: 'retry1', retryOf: 'first' }, { ...run.schedule.slots[0], id: 'retry2', retryOf: 'first' });
      await expect(runLivePromptSchedule(run.options)).rejects.toThrow(); expect(run.transport.generate).not.toHaveBeenCalled();
    }
  });
  it('retains failed attempt before a declared retry and skips successful retry successors', async () => {
    const run = setup();
    run.schedule.slots.push({ ...run.schedule.slots[0], id: 'retry', retryOf: 'first' }, { ...run.schedule.slots[0], id: 'third', retryOf: 'retry' });
    run.transport.generate = vi.fn(async (_request, _signal, started) => { started(); return { origin: 'live' as const, raw: '{}', usage: null, remoteCompletion: 'confirmed' as const }; });
    let samples = 0; run.binding.sample = async () => { if (++samples === 1) throw new Error('SAMPLE_FAILED'); return run.sample(); };
    const result = await runLivePromptSchedule(run.options);
    expect(result.results.map(entry => [entry.id, entry.outcome])).toEqual([['first', 'failed'], ['retry', 'completed'], ['third', 'skipped']]);
    expect(run.transport.generate).toHaveBeenCalledTimes(2);
    expect(run.records.get('first-browser')?.files.get('result.json')).toMatchObject({ error: 'SAMPLE_FAILED' });
  });
  it.each(['prepared', 'cache', 'fixture'])('rejects %s browser provenance after live provider output', async provenance => {
    const run = setup(); run.binding.sample = async () => { const sample = run.sample(); sample.pipeline = { ...sample.pipeline!, runs: [{ ...sample.pipeline!.runs[0], provenance: provenance as 'prepared' }] }; return sample; };
    const result = await runLivePromptSchedule(run.options);
    expect(result.results[0].error).toBe('NON_LIVE_BROWSER_PROVENANCE'); expect(run.binding.interact).not.toHaveBeenCalled();
  });
  it('refuses mismatched raw/session run binding and closes the allocated browser', async () => {
    const run = setup(); run.binding.rawSha256 = 'f'.repeat(64);
    expect((await runLivePromptSchedule(run.options)).results[0].error).toBe('INVALID_BROWSER_BINDING');
    expect(run.binding.close).toHaveBeenCalledOnce();
  });
  it('rejects an explicitly fixture browser binding in the live schedule', async () => {
    const run = setup(); run.binding.materializationOrigin = 'fixture';
    expect((await runLivePromptSchedule(run.options)).results[0].error).toBe('MATERIALIZATION_ORIGIN_MISMATCH');
    expect(run.binding.interact).not.toHaveBeenCalled();
  });
  it('preserves unknown product telemetry provenance without relabeling it live', async () => {
    const run = setup(); run.binding.sample = async () => {
      const sample = run.sample(); sample.pipeline = { ...sample.pipeline!, runs: [{ ...sample.pipeline!.runs[0], provenance: 'unknown' }] }; return sample;
    };
    expect((await runLivePromptSchedule(run.options)).results[0].outcome).toBe('completed');
    expect(run.records.get('first-browser')!.journal).toContainEqual(expect.objectContaining({ event: 'browser-sample',
      value: expect.objectContaining({ pipeline: expect.objectContaining({ runs: [expect.objectContaining({ provenance: 'unknown' })] }) }) }));
  });
  it('does not spend a provider call without a product bridge', async () => {
    const run = setup();
    expect((await runLivePromptSchedule({ ...run.options, bridge: undefined })).results[0].error).toBe('PRODUCT_BROWSER_BRIDGE_REQUIRED');
    expect(run.transport.generate).not.toHaveBeenCalled();
  });
  it('blocks retries after an unknown remote completion or unverified browser cleanup', async () => {
    const run = setup(); run.schedule.slots.push({ ...run.schedule.slots[0], id: 'retry', retryOf: 'first' });
    run.binding.sample = async () => { throw new Error('SAMPLE_FAILED'); };
    const result = await runLivePromptSchedule(run.options);
    expect(result.results[1]).toMatchObject({ outcome: 'skipped', error: 'PRIOR_TERMINATION_UNVERIFIED' });
    expect(run.transport.generate).toHaveBeenCalledOnce();
  });
  it('freezes caller metadata and bytes before asynchronous dispatch', async () => {
    const run = setup();
    const open = run.bridge.open;
    run.bridge.open = async (request, signal) => {
      run.schedule.slots[0].id = 'mutated'; run.experiment.cases[0].inputLog.path = 'changed';
      return open(request, signal);
    };
    expect((await runLivePromptSchedule(run.options)).results[0]).toMatchObject({ id: 'first', outcome: 'completed' });
  });
  it('rejects changed frozen artifacts before readiness or browser allocation', async () => {
    const run = setup();
    await expect(runLivePromptSchedule({ ...run.options, readArtifact: () => Buffer.from('changed') })).rejects.toThrow();
    expect(run.transport.readiness).not.toHaveBeenCalled(); expect(run.bridge.open).not.toHaveBeenCalled();
  });
  it('preserves all remaining slots when pre-cancelled without dispatch', async () => {
    const run = setup(), control = new AbortController(); control.abort();
    const result = await runLivePromptSchedule({ ...run.options, signal: control.signal });
    expect(result.results[0]).toMatchObject({ outcome: 'skipped', error: 'SCHEDULE_CANCELLED' });
    expect(run.transport.generate).not.toHaveBeenCalled();
  });
  it('fences unrelated root slots after provider timeout with unknown termination', async () => {
    vi.useFakeTimers(); const run = setup();
    run.schedule.slots.push({ ...run.schedule.slots[0], id: 'unrelated', arm: 'after' });
    run.transport.generate = vi.fn(async (_request, _signal, started) => { started(); return new Promise<never>(() => undefined); });
    const pending = runLivePromptSchedule(run.options); await vi.advanceTimersByTimeAsync(180001);
    const result = await pending;
    expect(result.results[1]).toMatchObject({ id: 'unrelated', outcome: 'skipped', error: 'PRIOR_TERMINATION_UNVERIFIED' });
    expect(run.transport.generate).toHaveBeenCalledOnce();
  });
  it('times out a stuck sample, closes the browser and journals late errors separately', async () => {
    vi.useFakeTimers(); const run = setup(); let reject!: (error: Error) => void;
    run.binding.sample = () => new Promise((_resolve, fail) => { reject = fail; });
    const pending = runLivePromptSchedule(run.options); await vi.advanceTimersByTimeAsync(501); const result = await pending;
    expect(result.results[0].error).toBe('BROWSER_TIMEOUT'); expect(run.binding.close).toHaveBeenCalledOnce();
    const record = run.records.get('first-browser')!, journal = structuredClone(record.journal);
    reject(new Error('late')); await vi.advanceTimersByTimeAsync(0);
    expect(record.journal).toEqual(journal); expect(record.late).toContainEqual(expect.objectContaining({ event: 'late-browser-sample-error' }));
  });
  it('cleans a late browser allocation after timeout without revising sealed outcome', async () => {
    vi.useFakeTimers(); const run = setup(); let resolve!: (value: LivePromptBrowserBinding) => void;
    run.bridge.open = () => new Promise(done => { resolve = done; });
    const pending = runLivePromptSchedule(run.options); await vi.advanceTimersByTimeAsync(501); const result = await pending;
    expect(result.results[0].error).toBe('BROWSER_TIMEOUT'); resolve(run.binding); await vi.advanceTimersByTimeAsync(0);
    expect(run.binding.close).toHaveBeenCalledOnce();
    expect(run.records.get('first-browser')!.late).toContainEqual(expect.objectContaining({ event: 'late-browser-close' }));
  });
  it('refuses stale completed interaction evidence even after a no-op driver', async () => {
    vi.useFakeTimers(); const run = setup(); await run.binding.interact(Buffer.from('synthetic ordinary scheduler fixture'), new AbortController().signal);
    const pending = runLivePromptSchedule(run.options); await vi.advanceTimersByTimeAsync(501);
    expect((await pending).results[0].error).toBe('BROWSER_TIMEOUT');
  });
  it('records cleanup timeout as failure and does not mark cleanup verified', async () => {
    vi.useFakeTimers(); const run = setup(); run.binding.close = () => new Promise(() => undefined);
    const pending = runLivePromptSchedule(run.options); await vi.advanceTimersByTimeAsync(4000);
    expect((await pending).results[0]).toMatchObject({ error: 'BROWSER_CLEANUP_UNVERIFIED', browser: { cleanupVerified: false } });
  });
});





