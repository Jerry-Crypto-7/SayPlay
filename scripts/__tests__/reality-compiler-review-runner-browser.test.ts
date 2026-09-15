import { createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import type { Browser } from '@playwright/test';
import { runInteractiveReviewSession } from '../reality-compiler-review-runner-browser';
import type { ReviewArtifactSink } from '../reality-compiler-review-runner';
import type { ReviewExperiment } from '../reality-compiler-review-protocol';
import { productionValidationSchema, SUBSCRIPTION_PRODUCTION_PROFILE } from '../subscription-production-profile';

function setup() {
  const bytes = new TextEncoder().encode('{}');
  const ref = { path: 'fixture.json', sha256: createHash('sha256').update(bytes).digest('hex') };
  const experiment: ReviewExperiment = {
    version: 'reality-compiler-review-v2', classification: 'development', experimentId: 'unit-only', frozenAt: '2020-01-01T00:00:00Z',
    change: { description: 'Synthetic unit readiness failure', patch: ref },
    config: { model: 'unit-model', effort: 'low', transport: 'official-codex-cli-chatgpt', billing: 'subscription', apiFallback: false,
      timeoutMs: 180000, limitsHash: ref.sha256, deviceProfile: ref, runtimeValidation: ref, sandboxValidation: ref },
    before: { commit: 'a'.repeat(40), dirtyPatch: null, build: ref }, after: { commit: 'b'.repeat(40), dirtyPatch: null, build: ref },
    cases: [{ id: 'source', kind: 'source', category: 'complete', input: ref, inputLog: ref, intervention: ref, repetitions: 1 }],
  };
  const files = new Map<string, unknown>(), events: unknown[] = [];
  const sink: ReviewArtifactSink = { write(name, value) { files.set(name, value); return { ...ref, path: name }; },
    append(event) { events.push(event); }, late() {}, seal() { return ref; } };
  const newContext = vi.fn(); const emit = vi.fn();
  return { files, events, emit, newContext, experiment, options: {
    browser: { newContext } as unknown as Browser, baseURL: 'http://127.0.0.1:3119', experiment,
    slot: { id: 'attempt-1', caseId: 'source', arm: 'before' as const, repetition: 1, attempt: 1, retryOf: null }, sink,
    readArtifact: () => bytes, humanTimeoutMs: 1000,
    transport: { mode: 'manual-live' as const, reviewerId: 'unit-only', readiness: async () => ({ config: experiment.config, validation: null }),
      currentIdentity: vi.fn(async () => ({ validationRunId: 'unit-only', launcherSha256: 'a'.repeat(64), runtimeSha256: 'b'.repeat(64) })), emit },
  } };
}

it('archives missing production readiness before creating a browser or calling a provider', async () => {
  const test = setup(); const result = await runInteractiveReviewSession(test.options);
  expect(result.protocolAttempt).toMatchObject({ outcome: 'failed', error: 'SUBSCRIPTION_PRODUCTION_NOT_VALIDATED', modelCalls: 0 });
  expect(test.newContext).not.toHaveBeenCalled(); expect(test.emit).not.toHaveBeenCalled();
  expect(test.files.has('attempt.json')).toBe(true);
});
it('archives pre-aborted sessions without calling readiness, browser or provider', async () => {
  const test = setup(); const control = new AbortController(); control.abort();
  const readiness = vi.fn(test.options.transport.readiness);
  const result = await runInteractiveReviewSession({ ...test.options, signal: control.signal, transport: { ...test.options.transport, readiness } });
  expect(result.protocolAttempt).toMatchObject({ outcome: 'cancelled', parameterReview: null, modelCalls: 0 });
  expect(readiness).not.toHaveBeenCalled(); expect(test.newContext).not.toHaveBeenCalled(); expect(test.emit).not.toHaveBeenCalled();
});
it('captures readiness before current identity can mutate the caller-owned object', async () => {
  const test = setup();
  const shared = { config: structuredClone(test.experiment.config), validation: null as unknown };
  const result = await runInteractiveReviewSession({ ...test.options, transport: { ...test.options.transport,
    readiness: async () => shared,
    currentIdentity: async () => {
      shared.validation = { kind: 'mutated-after-readiness' };
      shared.config.model = 'mutated-after-readiness';
      return { validationRunId: 'unit-only', launcherSha256: 'a'.repeat(64), runtimeSha256: 'b'.repeat(64) };
    } } });
  expect(test.files.get('transport-readiness-1.json')).toMatchObject({ readiness: { validation: null, config: { model: 'unit-model' } } });
  expect(result.protocolAttempt).toMatchObject({ outcome: 'failed', error: 'SUBSCRIPTION_PRODUCTION_NOT_VALIDATED', modelCalls: 0 });
  expect(test.newContext).not.toHaveBeenCalled(); expect(test.emit).not.toHaveBeenCalled();
});
it.each(['readiness', 'currentIdentity'] as const)('forwards cancellation to pending trusted dispatcher %s work', async operation => {
  const test = setup(); const control = new AbortController();
  let forwarded: AbortSignal | undefined;
  let cancelled = false;
  const pending = (signal?: AbortSignal): Promise<never> => {
    forwarded = signal;
    return new Promise((_, reject) => {
      signal?.addEventListener('abort', () => { cancelled = true; reject(new Error('DISPATCHER_CANCELLED')); }, { once: true });
      queueMicrotask(() => control.abort());
    });
  };
  const result = await runInteractiveReviewSession({ ...test.options, signal: control.signal,
    transport: { ...test.options.transport, [operation]: pending } });
  expect(forwarded?.aborted).toBe(true); expect(cancelled).toBe(true);
  expect(result.protocolAttempt).toMatchObject({ outcome: 'cancelled', error: 'SESSION_CANCELLED', modelCalls: 0 });
  expect(test.newContext).not.toHaveBeenCalled(); expect(test.emit).not.toHaveBeenCalled();
});
it('rechecks current dispatcher identity before provider work and archives changed evidence (synthetic unit fixture only)', async () => {
  const test = setup();
  test.experiment.config.model = SUBSCRIPTION_PRODUCTION_PROFILE.model;
  const identity = { validationRunId: 'synthetic-unit-only', launcherSha256: 'a'.repeat(64), runtimeSha256: 'b'.repeat(64) };
  const validation = productionValidationSchema.parse({ kind: 'subscription-production-profile-validation', version: 1,
    profile: { ...SUBSCRIPTION_PRODUCTION_PROFILE }, identity,
    stages: Object.fromEntries(Object.entries(productionValidationSchema.shape.stages.shape).map(([name, schema]) =>
      [name, { status: 'PASS', reportSha256: test.experiment.config.runtimeValidation.sha256, checks: Object.fromEntries(Object.keys(schema.shape.checks.shape).map(key => [key, true])) }])) });
  const contents = new Map<string, Uint8Array>();
  const artifact = (path: string, text: string) => {
    const bytes = new TextEncoder().encode(text); contents.set(path, bytes);
    return { path, sha256: createHash('sha256').update(bytes).digest('hex') };
  };
  test.experiment.cases[0] = { ...test.experiment.cases[0], input: artifact('source.txt', 'A museum has a visitor and a timer.'),
    inputLog: artifact('log.json', '[]'), intervention: artifact('intervention.json', JSON.stringify({ ruleId: 'timer', durationTicks: 200, forkTick: 0, observationTick: 1 })) };
  const body = { text: 'A museum has a visitor and a timer.', title: 'source', origin: 'provided', rights: 'unreviewed' };
  const locator = { click: vi.fn(), fill: vi.fn() };
  let handler: (route: unknown) => Promise<void> = async () => {};
  const fulfill = vi.fn();
  const page = { isClosed: () => false, setDefaultTimeout: vi.fn(), once: vi.fn(), addInitScript: vi.fn(),
    goto: async () => handler({ request: () => ({ url: () => 'http://127.0.0.1:3119/api/worldstream/source',
      method: () => 'POST', postDataJSON: () => body, postData: () => JSON.stringify(body) }), fulfill }),
    getByText: () => locator, getByLabel: () => locator, getByTestId: () => locator,
    evaluate: async () => ({ events: [{ sequence: 1, browserAtMs: 1, trusted: true, kind: 'source-submit' }], overflow: false, observation: null, pipeline: null }) };
  const close = vi.fn();
  test.newContext.mockResolvedValue({ newPage: async () => page, route: (_pattern: string, callback: typeof handler) => { handler = callback; }, close });
  const currentIdentity = vi.fn().mockResolvedValueOnce(identity).mockResolvedValue({ ...identity, runtimeSha256: 'c'.repeat(64) });
  const result = await runInteractiveReviewSession({ ...test.options,
    readArtifact: path => contents.get(path) ?? test.options.readArtifact(),
    transport: { ...test.options.transport, currentIdentity, readiness: async () => ({ config: test.experiment.config, validation }) } });
  expect(currentIdentity).toHaveBeenCalledTimes(2);
  expect(test.emit).not.toHaveBeenCalled();
  expect(result.protocolAttempt).toMatchObject({ outcome: 'failed', modelCalls: 0 });
  expect(test.files.get('transport-readiness-2.json')).toMatchObject({ currentIdentity: { runtimeSha256: 'c'.repeat(64) } });
  expect(close).toHaveBeenCalledOnce();
});
it('stops waiting for an unresponsive readiness callback and records interruption', async () => {
  const test = setup();
  const result = await runInteractiveReviewSession({ ...test.options, humanTimeoutMs: 10,
    transport: { ...test.options.transport, readiness: () => new Promise(() => {}) } });
  expect(result.protocolAttempt).toMatchObject({ outcome: 'interrupted', error: 'HUMAN_SESSION_TIMEOUT' });
  expect(test.newContext).not.toHaveBeenCalled(); expect(test.emit).not.toHaveBeenCalled();
});
it('consumes late readiness rejection when readiness synchronously cancels the session', async () => {
  const test = setup(); const control = new AbortController();
  const result = await runInteractiveReviewSession({ ...test.options, signal: control.signal,
    transport: { ...test.options.transport, readiness: () => {
      control.abort();
      return new Promise((_, reject) => setTimeout(() => reject(new Error('LATE_READINESS_FAILURE')), 5));
    } } });
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(result.protocolAttempt).toMatchObject({ outcome: 'cancelled', modelCalls: 0 });
  expect(test.newContext).not.toHaveBeenCalled(); expect(test.emit).not.toHaveBeenCalled();
});
it('rejects nonlocal server URLs and changed artifact bytes without inference', async () => {
  const test = setup();
  const remote = await runInteractiveReviewSession({ ...test.options, baseURL: 'https://example.com' });
  expect(remote.protocolAttempt?.error).toBe('LOCAL_PRODUCTION_SERVER_REQUIRED');
  const changed = setup();
  const invalid = await runInteractiveReviewSession({ ...changed.options, readArtifact: () => new Uint8Array() });
  expect(invalid.protocolAttempt?.outcome).toBe('failed');
  expect(changed.emit).not.toHaveBeenCalled(); expect(changed.newContext).not.toHaveBeenCalled();
});

it('bounds a fixture driver that ignores cancellation and still seals evidence when browser close fails', async () => {
  const test = setup();
  const contents = new Map<string, Uint8Array>();
  const artifact = (path: string, text: string) => {
    const bytes = new TextEncoder().encode(text); contents.set(path, bytes);
    return { path, sha256: createHash('sha256').update(bytes).digest('hex') };
  };
  test.experiment.cases[0] = { ...test.experiment.cases[0], input: artifact('source.txt', 'fixture source'),
    inputLog: artifact('log.json', '[]'), intervention: artifact('intervention.json', JSON.stringify({ ruleId: 'timer', durationTicks: 200, forkTick: 0, observationTick: 1 })) };
  const locator = { click: vi.fn(), fill: vi.fn() };
  const page = { isClosed: () => false, setDefaultTimeout: vi.fn(), once: vi.fn(), addInitScript: vi.fn(),
    goto: vi.fn(), getByText: () => locator, getByLabel: () => locator, getByTestId: () => locator,
    evaluate: async () => ({ events: [], overflow: false, observation: null, pipeline: null }) };
  const close = vi.fn(async () => { throw new Error('simulated browser crash'); });
  test.newContext.mockResolvedValue({ newPage: async () => page, route: vi.fn(), close });
  const driver = vi.fn(() => new Promise<void>(() => {}));
  const result = await runInteractiveReviewSession({ ...test.options, humanTimeoutMs: 100,
    readArtifact: path => contents.get(path) ?? test.options.readArtifact(),
    transport: { mode: 'fixture-smoke', fixture: vi.fn() }, onFixturePage: driver });
  expect(driver).toHaveBeenCalledOnce(); expect(close).toHaveBeenCalledOnce();
  expect(result).toMatchObject({ protocolAttempt: null, result: { outcome: 'interrupted', error: 'HUMAN_SESSION_TIMEOUT' } });
  expect(test.events).toContainEqual(expect.objectContaining({ event: 'context-close-failed-or-timed-out' }));
  expect(test.files.has('fixture-result.json')).toBe(true);
});
