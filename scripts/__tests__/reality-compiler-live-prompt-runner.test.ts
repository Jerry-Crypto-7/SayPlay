import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runLivePromptProvider, type ValidatedLivePromptTransport, type LivePromptResponse } from '../reality-compiler-live-prompt-runner';
import type { ReviewExperiment } from '../reality-compiler-review-protocol';
import type { ReviewArtifactSink } from '../reality-compiler-review-runner';
import { productionValidationSchema, SUBSCRIPTION_PRODUCTION_PROFILE } from '../subscription-production-profile';

const identity = { validationRunId: 'synthetic', launcherSha256: 'a'.repeat(64), runtimeSha256: 'b'.repeat(64) };
function validation() {
  const stages = Object.fromEntries(Object.entries(productionValidationSchema.shape.stages.shape).map(([name, schema]) =>
    [name, { status: 'PASS', reportSha256: createHash('sha256').update('ordinary unit fixture').digest('hex'),
      checks: Object.fromEntries(Object.keys(schema.shape.checks.shape).map(key => [key, true])) }]));
  return productionValidationSchema.parse({ kind: 'subscription-production-profile-validation', version: 1,
    profile: { ...SUBSCRIPTION_PRODUCTION_PROFILE }, identity: { ...identity }, stages });
}

function setup(timeoutMs = 180000) {
  const bytes = Buffer.from('ordinary unit fixture');
  const ref = { path: 'fixture.txt', sha256: createHash('sha256').update(bytes).digest('hex') };
  const manifest: ReviewExperiment = {
    version: 'reality-compiler-review-v2', classification: 'development', experimentId: 'unit-only', frozenAt: '2020-01-01T00:00:00Z',
    change: { description: 'unit fixture', patch: ref },
    config: { model: SUBSCRIPTION_PRODUCTION_PROFILE.model, effort: 'low', transport: 'official-codex-cli-chatgpt', billing: 'subscription', apiFallback: false,
      timeoutMs, limitsHash: 'a'.repeat(64), deviceProfile: ref, runtimeValidation: ref, sandboxValidation: ref },
    before: { commit: 'a'.repeat(40), dirtyPatch: null, build: ref }, after: { commit: 'b'.repeat(40), dirtyPatch: null, build: ref },
    cases: [{ id: 'ordinary', kind: 'prompt', category: 'ordinary', input: ref, inputLog: ref, intervention: ref, repetitions: 1 }],
  };
  const files = new Map<string, unknown>(), journal: unknown[] = [], late: unknown[] = [];
  let sealed = false;
  const sink: ReviewArtifactSink = {
    write(name, value) { if (files.has(name)) throw new Error('OVERWRITE'); files.set(name, structuredClone(value)); return ref; },
    append(value) { if (sealed) throw new Error('SEALED'); journal.push(structuredClone(value)); },
    late(value) { late.push(structuredClone(value)); }, seal() { sealed = true; return ref; },
  };
  const response: LivePromptResponse = { origin: 'live', raw: '{}', usage: null, remoteCompletion: 'unknown' };
  const transport: ValidatedLivePromptTransport = {
    readiness: vi.fn(async () => ({ config: manifest.config, validation: validation() })),
    currentIdentity: vi.fn(async () => ({ ...identity })),
    generate: vi.fn(async (_request, _signal, started) => { started(); return response; }),
  };
  const options = { experiment: manifest, caseId: 'ordinary', arm: 'before' as const, repetition: 1,
    attemptId: 'unique-attempt', sink, readArtifact: () => bytes, transport };
  return { manifest, transport, options, files, journal, late, response };
}

describe('ordinary live provider seam (synthetic transport, no inference)', () => {
  afterEach(() => vi.useRealTimers());
  it('fails closed and archives a missing capability before dispatch', async () => {
    const run = setup();
    const result = await runLivePromptProvider({ ...run.options, transport: undefined });
    expect(result).toMatchObject({ error: 'VALIDATED_PRODUCTION_TRANSPORT_REQUIRED', modelCalls: 0,
      remoteCompletion: 'not-started', origin: 'unknown' });
    expect(run.files.has('result.json')).toBe(true);
  });
  it('requires the production profile beyond dummy runtime and sandbox verification', async () => {
    const run = setup();
    const report = validation(); report.stages.productionCleanup.checks.exactProductionLimits = false;
    run.transport.readiness = async () => ({ config: run.manifest.config, validation: report });
    expect((await runLivePromptProvider(run.options)).error).toBe('SUBSCRIPTION_PRODUCTION_NOT_VALIDATED');
    expect(run.transport.generate).not.toHaveBeenCalled();
  });
  it('binds artifacts and configuration before dispatch', async () => {
    const run = setup();
    run.transport.readiness = async () => ({ config: { ...run.manifest.config, model: 'different' }, validation: validation() });
    expect((await runLivePromptProvider(run.options)).error).toBe('FROZEN_CONFIG_MISMATCH');
    expect(run.transport.generate).not.toHaveBeenCalled();
    const bad = setup();
    expect((await runLivePromptProvider({ ...bad.options, readArtifact: () => Buffer.from('changed') })).outcome).toBe('failed');
    expect(bad.transport.readiness).not.toHaveBeenCalled();
  });
  it('records only provider completion with null unmeasured stages and no benchmark credit', async () => {
    const run = setup();
    run.transport.generate = vi.fn(async (request, _signal, started) => {
      expect(run.files.has('provider-request.json')).toBe(true);
      expect(Object.keys(request).sort()).toEqual(['config', 'prompt']);
      started(); return run.response;
    });
    const result = await runLivePromptProvider(run.options);
    expect(result).toMatchObject({ outcome: 'provider-completed', modelCalls: 1, usage: null, usd: null,
      remoteCompletion: 'unknown', protocolAttempt: null, humanObservation: false, liveMeasurement: 'NOT_RUN',
      stagesMs: { frame: null, interaction: null } });
  });
  it.each(['prepared', 'cache', 'nearest', 'scripted'])('rejects %s provenance and retains the original response', async origin => {
    const run = setup();
    run.transport.generate = async (_request, _signal, started) => { started(); return { ...run.response, origin } as LivePromptResponse; };
    expect((await runLivePromptProvider(run.options)).error).toBe('INVALID_LIVE_PROVIDER_RESPONSE');
    expect(run.files.get('provider-response.json')).toMatchObject({ origin });
  });
  it('does not invent model calls from transport invocation without start evidence', async () => {
    const run = setup(); run.transport.generate = async () => run.response;
    expect(await runLivePromptProvider(run.options)).toMatchObject({ error: 'PROVIDER_START_REQUIRED', modelCalls: 0, remoteCompletion: 'unknown' });
  });
  it('rejects repeated start signals', async () => {
    const run = setup(); run.transport.generate = async (_request, _signal, started) => { started(); started(); return run.response; };
    expect(await runLivePromptProvider(run.options)).toMatchObject({ error: 'INVALID_PROVIDER_START', modelCalls: 1 });
  });
  it('rejects stale dispatcher identity and changed evidence independently of archived config', async () => {
    const run = setup(); run.transport.currentIdentity = async () => ({ ...identity, validationRunId: 'changed' });
    expect((await runLivePromptProvider(run.options)).error).toBe('SUBSCRIPTION_PRODUCTION_NOT_VALIDATED');
    expect(run.transport.generate).not.toHaveBeenCalled();
    const other = setup(), report = validation(); report.stages.runtimeProbe.reportSha256 = 'f'.repeat(64);
    other.transport.readiness = async () => ({ config: other.manifest.config, validation: report });
    expect((await runLivePromptProvider(other.options)).error).toBe('FROZEN_VALIDATION_EVIDENCE_MISMATCH');
  });
  it('revalidates after request archival and refuses a newly stale dispatcher before dispatch', async () => {
    const run = setup(); let checks = 0;
    run.transport.currentIdentity = vi.fn(async () => (++checks === 1 ? identity : { ...identity, validationRunId: 'replaced' }));
    expect(await runLivePromptProvider(run.options)).toMatchObject({ error: 'SUBSCRIPTION_PRODUCTION_NOT_VALIDATED',
      dispatched: false, modelCalls: 0, remoteCompletion: 'not-started', stagesMs: { preflight: null } });
    expect(run.files.has('provider-request.json')).toBe(true);
    expect(run.files.has('production-readiness-before-dispatch.json')).toBe(true);
    expect(run.transport.generate).not.toHaveBeenCalled();
  });
  it('records successful preflight separately and rechecks frozen evidence at dispatch', async () => {
    const run = setup();
    expect((await runLivePromptProvider(run.options)).stagesMs.preflight).toEqual(expect.any(Number));
    expect(run.transport.readiness).toHaveBeenCalledTimes(2);
    const stale = setup(); let checks = 0;
    stale.transport.readiness = async () => {
      const report = validation(); if (++checks === 2) report.stages.productionSandbox.reportSha256 = 'f'.repeat(64);
      return { config: stale.manifest.config, validation: report };
    };
    expect(await runLivePromptProvider(stale.options)).toMatchObject({ error: 'FROZEN_VALIDATION_EVIDENCE_MISMATCH', dispatched: false });
    expect(stale.transport.generate).not.toHaveBeenCalled();
  });
  it('archives oversize output as byte count and digest without the raw body', async () => {
    const run = setup(); run.response.raw = 'x'.repeat(SUBSCRIPTION_PRODUCTION_PROFILE.maxOutputBytes + 1);
    const result = await runLivePromptProvider(run.options);
    expect(result.error).toBe('PROVIDER_OUTPUT_LIMIT');
    const record = run.files.get('provider-response.json');
    expect(record).toMatchObject({ bytes: 8388609, bodyArchived: false, sha256: createHash('sha256').update(run.response.raw).digest('hex') });
    expect(record).not.toHaveProperty('raw');
    expect(result).toMatchObject({ remoteCompletion: 'unknown', usage: null, stagesMs: { provider: null } });
  });
  it('isolates request metadata and rejects changed production limits', async () => {
    const run = setup();
    run.transport.currentIdentity = async () => { run.options.caseId = 'mutated'; return identity; };
    expect((await runLivePromptProvider(run.options)).caseId).toBe('ordinary');
    const other = setup(1000);
    expect((await runLivePromptProvider(other.options)).error).toBe('FROZEN_PRODUCTION_PROFILE_MISMATCH');
    expect(other.transport.generate).not.toHaveBeenCalled();
  });
  it('bounds usage metadata and refuses a reused output sink before a second dispatch', async () => {
    const run = setup(); run.response.usage = Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`field${i}`, 1]));
    expect((await runLivePromptProvider(run.options)).error).toBe('INVALID_LIVE_PROVIDER_RESPONSE');
    expect(run.files.get('provider-response.json')).not.toHaveProperty('usage');
    await expect(runLivePromptProvider(run.options)).rejects.toThrow('SEALED');
    expect(run.transport.generate).toHaveBeenCalledTimes(1);
  });
  it('handles pre-abort and synchronous readiness abort followed by rejection', async () => {
    const run = setup(), controller = new AbortController(); controller.abort();
    expect((await runLivePromptProvider({ ...run.options, signal: controller.signal })).outcome).toBe('cancelled');
    expect(run.transport.readiness).not.toHaveBeenCalled();
    const next = setup(), nextControl = new AbortController();
    next.transport.readiness = async () => { nextControl.abort(); throw new Error('late readiness rejection'); };
    expect((await runLivePromptProvider({ ...next.options, signal: nextControl.signal })).error).toBe('SESSION_CANCELLED');
    expect(next.transport.generate).not.toHaveBeenCalled();
  });
  it('times out a noncooperative transport and preserves late response outside sealed journal', async () => {
    vi.useFakeTimers();
    const run = setup();
    let resolve!: (response: LivePromptResponse) => void;
    run.transport.generate = async (_request, _signal, started) => {
      started(); return new Promise<LivePromptResponse>(done => { resolve = done; });
    };
    const pending = runLivePromptProvider(run.options);
    await vi.advanceTimersByTimeAsync(180001);
    const result = await pending;
    const journal = structuredClone(run.journal);
    expect(result).toMatchObject({ error: 'SESSION_TIMEOUT', outcome: 'interrupted', modelCalls: 1,
      remoteCompletion: 'unknown', stagesMs: { provider: null } });
    resolve({ ...run.response, raw: 'x'.repeat(SUBSCRIPTION_PRODUCTION_PROFILE.maxOutputBytes + 1), remoteCompletion: 'confirmed' });
    await vi.advanceTimersByTimeAsync(0);
    expect(run.journal).toEqual(journal);
    expect(run.late).toHaveLength(1);
    expect(run.late[0]).toMatchObject({ value: { error: 'PROVIDER_OUTPUT_LIMIT', bodyArchived: false, bytes: 8388609 } });
    expect(result.remoteCompletion).toBe('unknown');
    vi.useRealTimers();
  });
});
