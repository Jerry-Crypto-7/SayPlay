import { createHash } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import * as generationModule from '../reality-compiler-ordinary-generation';
import { canonical } from '../../src/ir/worlddoc';
import { chooseAuthored, emitterFor } from '../../src/worldstream/authored';
import { serverGrammar } from '../../src/worldstream/sessions';
import { runOrdinaryGenerationSession } from '../reality-compiler-ordinary-generation-session';
import { experimentDigest, type ReviewExperiment } from '../reality-compiler-review-protocol';
import type { ReviewArtifactSink } from '../reality-compiler-review-runner';
import type { LivePromptBrowserBinding, LivePromptProductBridge } from '../reality-compiler-live-prompt-session';
import type { PromptSample } from '../reality-compiler-prompt-recorder';
import { SUBSCRIPTION_PRODUCTION_PROFILE } from '../subscription-production-profile';

const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
afterEach(() => vi.restoreAllMocks());
function setup() {
  const prompt = 'A cathedral of stacked shipping containers around a light well.';
  const grammar = serverGrammar(); if (typeof grammar === 'string') throw new Error('GRAMMAR');
  const bytes = new Map([['prompt.txt', Buffer.from(prompt)], ['grammar.json', Buffer.from(JSON.stringify(grammar))],
    ['input.json', Buffer.from('{"fixture":true}')]]);
  const ref = (path: string) => ({ path, sha256: sha(bytes.get(path)!) });
  const experiment: ReviewExperiment = { version: 'reality-compiler-review-v2', classification: 'development', experimentId: 'unit',
    frozenAt: '2020-01-01T00:00:00Z', change: { description: 'fixture only', patch: ref('prompt.txt') },
    config: { model: SUBSCRIPTION_PRODUCTION_PROFILE.model, effort: 'low', transport: 'official-codex-cli-chatgpt', billing: 'subscription', apiFallback: false,
      timeoutMs: 180000, limitsHash: 'a'.repeat(64), deviceProfile: ref('prompt.txt'), runtimeValidation: ref('prompt.txt'), sandboxValidation: ref('prompt.txt') },
    before: { commit: 'a'.repeat(40), dirtyPatch: null, build: ref('prompt.txt') }, after: { commit: 'b'.repeat(40), dirtyPatch: null, build: ref('prompt.txt') },
    cases: [{ id: 'ordinary', kind: 'prompt', category: 'ordinary', input: ref('prompt.txt'), inputLog: ref('input.json'), intervention: ref('prompt.txt'), repetitions: 1 }] };
  const generation = { version: 'ordinary-generation-v1', frozenAt: '2020-01-02T00:00:00Z', experimentHash: experimentDigest(experiment),
    caseId: 'ordinary', arm: 'before', repetition: 1, attemptId: 'unit', grammar: ref('grammar.json'), sessionSeed: 4021,
    maxBlueprintRounds: 3, chainDeadlineMs: 180000, maxRequestBytes: 8388608 };
  const session = { version: 'ordinary-generation-session-v1', frozenAt: '2020-01-03T00:00:00Z',
    generationHash: sha(canonical(generation)), browserTimeoutMs: 500 };
  const records = new Map<string, Map<string, unknown>>();
  const createSink = (scope: string): ReviewArtifactSink => {
    const files = new Map<string, unknown>(); if (records.has(scope)) throw new Error('DUPLICATE_SINK'); records.set(scope, files);
    return { write(name, value) { if (files.has(name)) throw new Error('OVERWRITE'); files.set(name, structuredClone(value)); return ref('prompt.txt'); },
      append() {}, late() {}, seal() { return ref('prompt.txt'); } };
  };
  const authored = emitterFor(chooseAuthored(prompt)!.world);
  const emit = vi.fn(async (request: Parameters<typeof authored>[0]) => ({ origin: 'fixture' as const, raw: JSON.stringify(await authored(request)),
    usage: null, remoteCompletion: 'not-started' as const }));
  let interacted = false;
  const sample = (): PromptSample => ({ pipeline: { version: 'worldstream-pipeline-v1', currentRunId: 1,
    runs: [{ runId: 1, generation: 1, kind: 'prompt', provenance: 'unknown', droppedStages: 0, startedAtMs: 0,
      endedAtMs: null, elapsedMs: null, outcome: 'pending', stages: [
        { stageId: 1, name: 'first-frame', provenance: 'unknown', outcome: 'completed', startedAtMs: 0, endedAtMs: 1, elapsedMs: 1 },
        ...(interacted ? [{ stageId: 2, name: 'first-interaction' as const, provenance: 'unknown' as const, outcome: 'completed' as const,
          startedAtMs: 1, endedAtMs: 2, elapsedMs: 1 }] : []),
      ] }] }, renderer: { ready: true, frames: 1, drawCalls: 1, triangles: 1 }, authoredNotice: null,
    runtime: { tick: 1, inputs: interacted ? 1 : 0 }, runtimeEvidence: { inputResult: interacted ? 'Applied: fixture' : null, ruleTrace: interacted ? 'fixture' : null, tick: '1' } });
  const binding: LivePromptBrowserBinding = { materializationOrigin: 'fixture', sessionId: 'fixture-session', rawSha256: '', runId: 1, generation: 1, device: { fixture: true },
    sample: vi.fn(async () => sample()), interact: vi.fn(async input => { expect(input).toEqual(Uint8Array.from(bytes.get('input.json')!)); interacted = true; }),
    close: vi.fn(async () => undefined) };
  const bridge: LivePromptProductBridge = { open: vi.fn(async request => { binding.rawSha256 = request.rawSha256; return binding; }) };
  const control = new AbortController();
  const options = { experiment, generation, session, capability: { mode: 'fixture' as const, emit }, bridge,
    sink: createSink('session'), createSink, readArtifact: (path: string) => bytes.get(path)!, signal: control.signal };
  return { options, emit, bridge, binding, records, control, session };
}

it('runs actual planner/compiler core once then binds its derived blueprint to frame and input', async () => {
  const run = setup(), result = await runOrdinaryGenerationSession(run.options);
  expect(result).toMatchObject({ outcome: 'completed', modelCalls: 0, mode: 'fixture', liveMeasurement: 'NOT_RUN', humanObservation: false,
    browserCleanupVerified: true, generated: { emitterInvocations: 2, origin: 'fixture' } });
  expect(run.emit).toHaveBeenCalledTimes(2); expect(run.bridge.open).toHaveBeenCalledOnce(); expect(run.binding.close).toHaveBeenCalledOnce();
  expect(vi.mocked(run.bridge.open).mock.calls[0][0].raw).toBe(JSON.stringify(result.generated!.blueprint));
  expect(run.records.get('session')!.get('materialization-binding.json')).toMatchObject({ generationHash: result.generationHash, origin: 'fixture' });
});
it('refuses a different frozen generation hash before any emitter or browser call', async () => {
  const run = setup(); run.session.generationHash = 'f'.repeat(64);
  await expect(runOrdinaryGenerationSession(run.options)).rejects.toThrow('INVALID_FROZEN_GENERATION_SESSION');
  expect(run.emit).not.toHaveBeenCalled(); expect(run.bridge.open).not.toHaveBeenCalled();
});
it('does not mount after compiler rejection or pre-cancellation', async () => {
  for (const cancelled of [true, false]) {
    const run = setup();
    if (cancelled) run.control.abort(); else run.emit.mockResolvedValue({ origin: 'fixture', raw: '{}', usage: null, remoteCompletion: 'not-started' });
    expect((await runOrdinaryGenerationSession(run.options)).outcome).toBe('failed'); expect(run.bridge.open).not.toHaveBeenCalled();
  }
});
it('refuses fixture output returned through a provider-labelled browser binding and cleans that browser', async () => {
  const run = setup(); run.binding.materializationOrigin = 'provider';
  expect(await runOrdinaryGenerationSession(run.options)).toMatchObject({ outcome: 'failed', error: 'MATERIALIZATION_ORIGIN_MISMATCH', modelCalls: 0 });
  expect(run.binding.close).toHaveBeenCalledOnce();
});
it('preserves browser cleanup failure independently of successful compilation', async () => {
  const run = setup(); vi.mocked(run.binding.close).mockRejectedValue(new Error('fixture failure'));
  expect(await runOrdinaryGenerationSession(run.options)).toMatchObject({ outcome: 'failed', error: 'BROWSER_CLEANUP_UNVERIFIED',
    browserCleanupVerified: false, nextDispatchAllowed: false, generated: { outcome: 'compiled' } });
});
it('refuses a session archive failure before generation', async () => {
  const run = setup(); run.options.sink.write = () => { throw new Error('ARCHIVE'); };
  await expect(runOrdinaryGenerationSession(run.options)).rejects.toThrow('ARCHIVE');
  expect(run.emit).not.toHaveBeenCalled(); expect(run.bridge.open).not.toHaveBeenCalled();
});
it('keeps calls and cleanup unknown when a live generation fails without returning its accounting', async () => {
  const run = setup();
  vi.spyOn(generationModule, 'runOrdinaryGeneration').mockRejectedValue(new Error('ARCHIVE_FAILED'));
  const unreachable = async (): Promise<never> => { throw new Error('UNEXPECTED_DISPATCH'); };
  const result = await runOrdinaryGenerationSession({ ...run.options,
    capability: { mode: 'live', transport: { readiness: unreachable, currentIdentity: unreachable, emit: unreachable } } });
  expect(result).toMatchObject({ outcome: 'failed', error: 'ARCHIVE_FAILED', modelCalls: null, nextDispatchAllowed: false,
    providerTermination: { localCleanup: 'not-verified', remote: 'unknown' } });
  expect(run.bridge.open).not.toHaveBeenCalled();
});
it('does not turn an explicit unknown model count from generation into zero', async () => {
  const run = setup();
  const fixtureResult = await generationModule.runOrdinaryGeneration({ ...run.options, sink: run.options.createSink('fixture-source') });
  vi.spyOn(generationModule, 'runOrdinaryGeneration').mockResolvedValue({ ...fixtureResult, modelCalls: null,
    mode: 'live', outcome: 'failed', origin: 'unknown', error: 'INVALID_GENERATION_PROVENANCE', blueprint: null,
    dispatchCount: 1, termination: { localCleanup: 'not-verified', remote: 'unknown' } });
  const unreachable = async (): Promise<never> => { throw new Error('UNEXPECTED_DISPATCH'); };
  expect(await runOrdinaryGenerationSession({ ...run.options,
    capability: { mode: 'live', transport: { readiness: unreachable, currentIdentity: unreachable, emit: unreachable } } }))
    .toMatchObject({ modelCalls: null, nextDispatchAllowed: false, providerTermination: { remote: 'unknown' } });
  expect(run.bridge.open).not.toHaveBeenCalled();
});
