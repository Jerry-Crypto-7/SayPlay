import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runOrdinaryGeneration, type OrdinaryGenerationCapability, type OrdinaryGenerationTransport } from '../reality-compiler-ordinary-generation';
import { experimentDigest, type ReviewExperiment } from '../reality-compiler-review-protocol';
import type { ReviewArtifactSink } from '../reality-compiler-review-runner';
import type { LivePromptResponse } from '../reality-compiler-live-prompt-runner';
import { productionValidationSchema, SUBSCRIPTION_PRODUCTION_PROFILE } from '../subscription-production-profile';
import { chooseAuthored, emitterFor } from '../../src/worldstream/authored';
import { serverGrammar } from '../../src/worldstream/sessions';

const sha = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
function setup(mode: 'live' | 'fixture' = 'fixture') {
  const prompt = 'A cathedral of stacked shipping containers around a light well.', bytes = Buffer.from(prompt);
  const ref = { path: 'prompt.txt', sha256: sha(bytes) }, grammar = serverGrammar();
  if (typeof grammar === 'string') throw new Error('GRAMMAR_SETUP');
  const grammarBytes = Buffer.from(JSON.stringify(grammar)), grammarRef = { path: 'grammar.json', sha256: sha(grammarBytes) };
  const experiment: ReviewExperiment = { version: 'reality-compiler-review-v2', classification: 'development', experimentId: 'synthetic',
    frozenAt: '2020-01-01T00:00:00Z', change: { description: 'synthetic only', patch: ref },
    config: { model: SUBSCRIPTION_PRODUCTION_PROFILE.model, effort: 'low', transport: 'official-codex-cli-chatgpt', billing: 'subscription',
      apiFallback: false, timeoutMs: 180000, limitsHash: 'a'.repeat(64), deviceProfile: ref, runtimeValidation: ref, sandboxValidation: ref },
    before: { commit: 'a'.repeat(40), dirtyPatch: null, build: ref }, after: { commit: 'b'.repeat(40), dirtyPatch: null, build: ref },
    cases: [{ id: 'ordinary', kind: 'prompt', category: 'ordinary', input: ref, inputLog: ref, intervention: ref, repetitions: 1 }] };
  const generation = { version: 'ordinary-generation-v1', frozenAt: '2020-01-02T00:00:00Z', experimentHash: experimentDigest(experiment),
    caseId: 'ordinary', arm: 'before', repetition: 1, attemptId: 'unit', grammar: grammarRef, sessionSeed: 4021,
    maxBlueprintRounds: 3, chainDeadlineMs: 180000, maxRequestBytes: 8388608 };
  const files = new Map<string, unknown>(), journal: unknown[] = [], late: unknown[] = []; let sealed = false;
  const sink: ReviewArtifactSink = { write(name, value) { if (files.has(name)) throw new Error('OVERWRITE'); files.set(name, structuredClone(value)); return ref; },
    append(value) { if (sealed) throw new Error('SEALED'); journal.push(structuredClone(value)); }, late(value) { late.push(structuredClone(value)); },
    seal() { sealed = true; return ref; } };
  const emitter = emitterFor(chooseAuthored(prompt)!.world);
  const fixture = vi.fn(async (request: Parameters<typeof emitter>[0]) => ({ origin: 'fixture' as const,
    raw: JSON.stringify(await emitter(request)), usage: null, remoteCompletion: 'not-started' as const }));
  const identity = { validationRunId: 'synthetic', launcherSha256: 'a'.repeat(64), runtimeSha256: 'b'.repeat(64) };
  const stages = Object.fromEntries(Object.entries(productionValidationSchema.shape.stages.shape).map(([name, schema]) =>
    [name, { status: 'PASS', reportSha256: ref.sha256, checks: Object.fromEntries(Object.keys(schema.shape.checks.shape).map(key => [key, true])) }]));
  const validation = productionValidationSchema.parse({ kind: 'subscription-production-profile-validation', version: 1,
    profile: { ...SUBSCRIPTION_PRODUCTION_PROFILE }, identity, stages });
  const transport: OrdinaryGenerationTransport = { readiness: vi.fn(async () => ({ config: experiment.config, validation })),
    currentIdentity: vi.fn(async () => identity), emit: vi.fn(async (request, _signal, started) => {
      started(); return { origin: 'live' as const, raw: JSON.stringify(await emitter(request.request)), usage: null, remoteCompletion: 'confirmed' as const };
    }) };
  const capability: OrdinaryGenerationCapability = mode === 'fixture' ? { mode: 'fixture', emit: fixture } : { mode: 'live', transport };
  const options = { experiment, generation, capability, sink, readArtifact: (path: string) => path === 'grammar.json' ? grammarBytes : bytes };
  return { options, experiment, generation, fixture, transport, validation, identity, emitter, files, journal, late, sink };
}

describe('full ordinary core generation seam, synthetic transports only', () => {
  afterEach(() => vi.useRealTimers());
  it('runs actual planner/compiler core with frozen grammar and seed, zero fixture model calls', async () => {
    const run = setup(), result = await runOrdinaryGeneration(run.options);
    expect(result).toMatchObject({ mode: 'fixture', outcome: 'compiled', modelCalls: 0, emitterInvocations: 2,
      liveMeasurement: 'NOT_RUN', humanObservation: false, usd: null, usage: null, blueprint: { version: 'worldstream-v1', sessionSeed: 4021 } });
    expect(run.files.get('response-1.json')).toMatchObject({ origin: 'fixture', providerElapsedMs: null });
    expect(run.files.has('request-2.json')).toBe(true); expect(run.files.has('blueprint.json')).toBe(true);
  });
  it('uses actual core repair request and retains rejected round before successful repair', async () => {
    const run = setup(); let count = 0;
    run.options.capability = { mode: 'fixture', emit: async request => ({ origin: 'fixture',
      raw: JSON.stringify(++count === 2 ? {} : await run.emitter(request)), usage: null, remoteCompletion: 'not-started' }) };
    const result = await runOrdinaryGeneration(run.options);
    expect(result).toMatchObject({ outcome: 'compiled', emitterInvocations: 3, modelCalls: 0 });
    expect(result.rounds).toHaveLength(2); expect(result.rounds[0].fault).not.toBeNull(); expect(result.rounds[1].fault).toBeNull();
    expect(run.files.get('request-3.json')).toMatchObject({ stage: 'repair' });
    expect(run.files.get('response-2.json')).toMatchObject({ raw: '{}' });
  });
  it('preserves core repeated-rejection stop without adding adapter retries', async () => {
    const run = setup(); let count = 0;
    run.options.capability = { mode: 'fixture', emit: async request => ({ origin: 'fixture',
      raw: JSON.stringify(++count === 1 ? await run.emitter(request) : {}), usage: null, remoteCompletion: 'not-started' }) };
    const result = await runOrdinaryGeneration(run.options);
    expect(result).toMatchObject({ error: 'COMPILER_REJECTED', emitterInvocations: 3, blueprint: null }); expect(result.rounds).toHaveLength(2);
  });
  it('checks trusted readiness and exact frozen config before every live dispatch', async () => {
    const run = setup('live'), result = await runOrdinaryGeneration(run.options);
    expect(result).toMatchObject({ outcome: 'compiled', modelCalls: 2, dispatchCount: 2, liveMeasurement: 'NOT_RUN' });
    expect(run.transport.readiness).toHaveBeenCalledTimes(2); expect(run.transport.currentIdentity).toHaveBeenCalledTimes(2);
    expect(run.files.has('readiness-2.json')).toBe(true);
    const request = vi.mocked(run.transport.emit).mock.calls[0][0];
    expect(Object.keys(request).sort()).toEqual(['config', 'remainingBudgetMs', 'request']);
    expect(request.remainingBudgetMs).toBeLessThanOrEqual(180000);
    expect(request.config).toMatchObject({ model: SUBSCRIPTION_PRODUCTION_PROFILE.model, effort: 'low', apiFallback: false });
  });
  it('refuses a stale dispatcher between planner and compiler without dispatching compiler', async () => {
    const run = setup('live'); let checks = 0;
    run.transport.currentIdentity = async () => ++checks === 1 ? run.identity : { ...run.identity, validationRunId: 'changed' };
    const result = await runOrdinaryGeneration(run.options);
    expect(result.error).toBe('SUBSCRIPTION_PRODUCTION_NOT_VALIDATED'); expect(run.transport.emit).toHaveBeenCalledOnce();
    expect(run.files.has('request-2.json')).toBe(true); expect(run.files.has('readiness-2.json')).toBe(true);
  });
  it('fences every later live call after a returned intent with unknown remote termination', async () => {
    const run = setup('live');
    run.transport.emit = vi.fn(async (request, _signal, started) => {
      started(); return { origin: 'live' as const, raw: JSON.stringify(await run.emitter(request.request)), usage: null, remoteCompletion: 'unknown' as const };
    });
    const result = await runOrdinaryGeneration(run.options);
    expect(result).toMatchObject({ error: 'PRIOR_REMOTE_TERMINATION_UNVERIFIED', modelCalls: 1, dispatchCount: 1,
      blueprint: null, termination: { localCleanup: 'not-verified', remote: 'unknown' } });
    expect(run.transport.emit).toHaveBeenCalledOnce(); expect(run.transport.readiness).toHaveBeenCalledOnce();
    expect(run.files.has('request-2.json')).toBe(true); expect(run.files.has('response-2.json')).toBe(false);
  });
  it.each(['prepared', 'cache', 'nearest', 'scripted', 'fixture'])('rejects %s in live responses while archiving origin', async origin => {
    const run = setup('live'); run.transport.emit = async (_request, _signal, started) => { started(); return { origin, raw: '{}', usage: null, remoteCompletion: 'confirmed' } as LivePromptResponse; };
    expect(await runOrdinaryGeneration(run.options)).toMatchObject({ error: 'INVALID_GENERATION_PROVENANCE', outputBytes: 2 });
    expect(run.files.get('response-1.json')).toMatchObject({ origin });
  });
  it('refuses fixture data claiming live provenance', async () => {
    const run = setup(); run.options.capability = { mode: 'fixture', emit: async () => ({ origin: 'live', raw: '{}', usage: null, remoteCompletion: 'not-started' } as never) };
    expect((await runOrdinaryGeneration(run.options)).error).toBe('INVALID_GENERATION_PROVENANCE');
  });
  it('rejects changed grammar or freeze before invoking an emitter', async () => {
    const run = setup(); run.generation.grammar.sha256 = 'f'.repeat(64);
    expect((await runOrdinaryGeneration(run.options)).error).toBe('GENERATION_GRAMMAR_MISMATCH'); expect(run.fixture).not.toHaveBeenCalled();
    const other = setup(); other.generation.experimentHash = 'f'.repeat(64);
    expect((await runOrdinaryGeneration(other.options)).error).toBe('INVALID_FROZEN_GENERATION'); expect(other.fixture).not.toHaveBeenCalled();
  });
  it('bounds oversize raw output to count/hash without a body', async () => {
    const run = setup(); run.options.capability = { mode: 'fixture', emit: async () => ({ origin: 'fixture', raw: 'x'.repeat(8388609), usage: null, remoteCompletion: 'not-started' }) };
    expect(await runOrdinaryGeneration(run.options)).toMatchObject({ error: 'GENERATION_OUTPUT_LIMIT', outputBytes: 8388609 });
    expect(run.files.get('response-1.json')).toMatchObject({ bytes: 8388609, bodyArchived: false }); expect(run.files.get('response-1.json')).not.toHaveProperty('raw');
  });
  it('counts a known raw response even when usage metadata is invalid', async () => {
    const run = setup('live');
    run.transport.emit = async (_request, _signal, started) => {
      started(); return { origin: 'live', raw: '{"known":true}', usage: { tokens: -1 }, remoteCompletion: 'confirmed' };
    };
    expect(await runOrdinaryGeneration(run.options)).toMatchObject({ error: 'INVALID_GENERATION_USAGE', outputBytes: 14,
      modelCalls: 1, observedProviderStarts: 1 });
  });
  it('keeps a response that resolves after synchronous cancellation outside the sealed total', async () => {
    const run = setup('live'), control = new AbortController();
    run.transport.emit = async (_request, _signal, started) => {
      started(); control.abort(); return { origin: 'live', raw: '{}', usage: null, remoteCompletion: 'confirmed' };
    };
    const result = await runOrdinaryGeneration({ ...run.options, signal: control.signal });
    expect(result).toMatchObject({ error: 'GENERATION_CANCELLED', outputBytes: 0, blueprint: null, observedProviderStarts: 1 });
    await Promise.resolve();
    expect(run.late).toContainEqual(expect.objectContaining({ event: 'late-response',
      value: expect.objectContaining({ evidence: expect.objectContaining({ bytes: 2 }) }) }));
  });
  it('requires exactly one actual provider-start per call', async () => {
    const run = setup('live'); run.transport.emit = async () => ({ origin: 'live', raw: '{}', usage: null, remoteCompletion: 'confirmed' });
    expect(await runOrdinaryGeneration(run.options)).toMatchObject({ error: 'INVALID_GENERATION_PROVENANCE',
      modelCalls: null, observedProviderStarts: 0, dispatchCount: 1, outputBytes: 2 });
    const other = setup('live'); other.transport.emit = async (_request, _signal, started) => { started(); started(); return { origin: 'live', raw: '{}', usage: null, remoteCompletion: 'confirmed' }; };
    expect((await runOrdinaryGeneration(other.options)).error).toBe('INVALID_PROVIDER_START');
  });
  it('keeps known starts separate when a later dispatched call omits its start callback', async () => {
    const run = setup('live'); let invocation = 0;
    run.transport.emit = async (request, _signal, started) => {
      if (++invocation === 1) started();
      return { origin: 'live', raw: JSON.stringify(await run.emitter(request.request)), usage: null, remoteCompletion: 'confirmed' };
    };
    expect(await runOrdinaryGeneration(run.options)).toMatchObject({ error: 'INVALID_GENERATION_PROVENANCE',
      modelCalls: null, observedProviderStarts: 1, dispatchCount: 2 });
  });
  it('uses one total deadline and passes decreasing remaining budget to successive dispatches', async () => {
    vi.useFakeTimers(); const run = setup('live'), budgets: number[] = [];
    run.transport.emit = vi.fn(async (request, _signal, started) => {
      started(); budgets.push(request.remainingBudgetMs); await new Promise(resolve => setTimeout(resolve, 1000));
      return { origin: 'live' as const, raw: JSON.stringify(await run.emitter(request.request)), usage: null, remoteCompletion: 'confirmed' as const };
    });
    const pending = runOrdinaryGeneration(run.options); await vi.advanceTimersByTimeAsync(2500);
    expect((await pending).outcome).toBe('compiled'); expect(budgets).toHaveLength(2); expect(budgets[1]).toBeLessThan(budgets[0]);
  });
  it('times out a noncooperative call and preserves late response outside the sealed journal', async () => {
    vi.useFakeTimers(); const run = setup('live'); let resolve!: (response: LivePromptResponse) => void;
    run.transport.emit = async (_request, _signal, started) => { started(); return new Promise(done => { resolve = done; }); };
    const pending = runOrdinaryGeneration(run.options); await vi.advanceTimersByTimeAsync(180001); const result = await pending, journal = structuredClone(run.journal);
    expect(result).toMatchObject({ error: 'GENERATION_TIMEOUT', modelCalls: 1, remoteCompletions: ['unknown'], blueprint: null });
    resolve({ origin: 'live', raw: 'x'.repeat(8388609), usage: null, remoteCompletion: 'confirmed' }); await vi.advanceTimersByTimeAsync(0);
    expect(run.journal).toEqual(journal); expect(run.late).toContainEqual(expect.objectContaining({ event: 'late-response', value: expect.objectContaining({ evidence: expect.objectContaining({ bodyArchived: false }) }) }));
  });
  it('cancels before dispatch and does not expose arbitrary thrown provider details', async () => {
    const run = setup(), control = new AbortController(); control.abort();
    expect((await runOrdinaryGeneration({ ...run.options, signal: control.signal })).error).toBe('GENERATION_CANCELLED'); expect(run.fixture).not.toHaveBeenCalled();
    const other = setup(); other.options.capability = { mode: 'fixture', emit: async () => { throw new Error('PRIVATE_PROVIDER_DETAIL'); } };
    expect((await runOrdinaryGeneration(other.options)).error).toBe('GENERATION_EMITTER_FAILED');
    expect(JSON.stringify([...other.files.values()])).not.toContain('PRIVATE_PROVIDER_DETAIL');
  });
  it('stops further dispatch after archive failure even though core phase callbacks are best effort', async () => {
    const run = setup(), append = run.sink.append;
    run.sink.append = value => {
      if ((value as { event?: string }).event === 'phase-finish') throw new Error('DISK_FAILED');
      append(value);
    };
    const result = await runOrdinaryGeneration(run.options);
    expect(result).toMatchObject({ error: 'ARCHIVE_FAILED', blueprint: null, emitterInvocations: 1 });
    expect(run.fixture).toHaveBeenCalledOnce();
  });
  it('keeps frozen task input logs outside every model request', async () => {
    const run = setup(), oracle = Buffer.from('PRIVATE_ORACLE_MARKER');
    run.experiment.cases[0].inputLog = { path: 'oracle.json', sha256: sha(oracle) };
    run.generation.experimentHash = experimentDigest(run.experiment);
    const reader = run.options.readArtifact;
    expect((await runOrdinaryGeneration({ ...run.options, readArtifact: path => path === 'oracle.json' ? oracle : reader(path) })).outcome).toBe('compiled');
    expect(JSON.stringify(run.files.get('request-1.json'))).not.toContain('PRIVATE_ORACLE_MARKER');
    expect(JSON.stringify(run.files.get('request-2.json'))).not.toContain('PRIVATE_ORACLE_MARKER');
  });
  it('snapshots capability methods and caller metadata before the first asynchronous step', async () => {
    const run = setup('live');
    run.transport.readiness = async () => {
      run.options.generation.sessionSeed = 0;
      run.transport.emit = async () => { throw new Error('MUTATED'); };
      return { config: run.experiment.config, validation: run.validation };
    };
    const result = await runOrdinaryGeneration(run.options);
    expect(result).toMatchObject({ outcome: 'compiled', blueprint: { sessionSeed: 4021 }, modelCalls: 2 });
  });
});
