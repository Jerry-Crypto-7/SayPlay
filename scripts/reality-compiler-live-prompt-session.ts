/** Development orchestration. Product mounting is a trusted caller capability,
 * not an HTTP injection endpoint or proof of production transport readiness. */
import { createHash } from 'node:crypto';
import type { Page } from '@playwright/test';
import { z } from 'zod';
import { canonical } from '../src/ir/worlddoc';
import type { PromptSample } from './reality-compiler-prompt-recorder';
import { experimentDigest, experimentSchema, verifyReviewArtifacts } from './reality-compiler-review-protocol';
import { runLivePromptProvider, type ValidatedLivePromptTransport } from './reality-compiler-live-prompt-runner';
import type { ReviewArtifactSink } from './reality-compiler-review-runner';

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
export const livePromptScheduleSchema = z.strictObject({
  version: z.literal('live-prompt-schedule-v1'),
  frozenAt: z.iso.datetime(), experimentHash: z.string().regex(/^[a-f0-9]{64}$/),
  browserTimeoutMs: z.number().int().min(1).max(120000),
  slots: z.array(z.strictObject({ id, caseId: id, arm: z.enum(['before', 'after']),
    repetition: z.number().int().min(1).max(30), retryOf: id.nullable() })).min(1).max(120),
});
export type LivePromptSessionSlot = z.infer<typeof livePromptScheduleSchema>['slots'][number];
type Slot = LivePromptSessionSlot;

export interface LivePromptBrowserBinding {
  materializationOrigin: 'provider' | 'fixture';
  sessionId: string;
  /** Product bridge must bind this raw response to this fresh pipeline run. */
  rawSha256: string;
  runId: number;
  generation: number;
  device: unknown;
  sample(signal: AbortSignal): Promise<PromptSample>;
  /** Applies the frozen input log; never reports human interaction. */
  interact(inputLog: Uint8Array, signal: AbortSignal): Promise<void>;
  close(): Promise<void>;
}
export interface LivePromptProductBridge {
  /** Must create an isolated fresh product session, validate/lower raw with the
   * existing compiler and disable all extra generation/fallback requests.
   * Caller owns the server integration; a returned object is not attestation. */
  open(request: { raw: string; rawSha256: string; prompt: string; slot: Slot; build: unknown }, signal: AbortSignal): Promise<LivePromptBrowserBinding>;
}

/** Actual Page telemetry, reusable by a product bridge after it binds a session.
 * This reads rendered evidence; it does not launch or synthesize a world. */
export async function sampleLivePromptPage(page: Page): Promise<PromptSample> {
  return page.evaluate(() => {
    const stage = window.__worldstreamStage, observation = window.__realityCompiler?.snapshot();
    return { pipeline: window.__worldstreamMetrics?.snapshot() ?? null,
      renderer: stage ? { ready: stage.ready(), frames: stage.frames(), drawCalls: stage.quality()?.drawCalls ?? 0,
        triangles: stage.slots().reduce((sum, slot) => sum + (slot.attached ? slot.triangles : 0), 0) } : null,
      authoredNotice: document.querySelector('[data-testid="world-authored"]')?.textContent ?? null,
      runtime: observation ? { tick: observation.runtime.tick, inputs: observation.inputs.length } : null,
      runtimeEvidence: { inputResult: document.querySelector('[data-testid="runtime-input-result"]')?.textContent ?? null,
        ruleTrace: document.querySelector('[data-testid="runtime-rule-trace"]')?.textContent ?? null,
        tick: document.querySelector('[data-testid="runtime-tick"]')?.getAttribute('data-tick') ?? null } };
  });
}

function bounded<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(new Error('SESSION_INTERRUPTED')); };
    operation.then(value => { signal.removeEventListener('abort', abort); resolve(value); },
      error => { signal.removeEventListener('abort', abort); reject(error); });
    if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
  });
}
const digest = (raw: string) => createHash('sha256').update(raw).digest('hex');

/** Trusted caller materialization observer. The caller must bind provider versus
 * fixture provenance; observing frames never attests to how a blueprint arose. */
export async function observeBrowser(options: { bridge: LivePromptProductBridge; raw: string; slot: Slot; build: unknown;
  prompt: string; inputLog: Uint8Array; timeoutMs: number; sink: ReviewArtifactSink; signal?: AbortSignal; fixture?: boolean }) {
  const started = performance.now(), control = new AbortController();
  let binding: LivePromptBrowserBinding | null = null, sealed = false, cleanupVerified = false;
  let error: string | null = null, frameMs: number | null = null, interactionMs: number | null = null;
  let samples = 0, driverCompleted = false;
  const log = (event: string, value: unknown) => {
    const entry = { event, atMs: performance.now() - started, value };
    if (sealed) options.sink.late(entry); else options.sink.append(entry);
  };
  const stop = (code: string) => { error ??= code; control.abort(); };
  const cancel = () => stop('SESSION_CANCELLED');
  options.signal?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(() => stop('BROWSER_TIMEOUT'), options.timeoutMs);
  log('browser-start', { slot: options.slot, rawSha256: digest(options.raw), build: options.build });
  try {
    if (options.signal?.aborted) cancel();
    if (control.signal.aborted) throw new Error('SESSION_CANCELLED');
    const opening = Promise.resolve().then(() => {
      if (control.signal.aborted) throw new Error('SESSION_INTERRUPTED');
      return options.bridge.open({ raw: options.raw, rawSha256: digest(options.raw), prompt: options.prompt,
        slot: structuredClone(options.slot), build: structuredClone(options.build) }, control.signal);
    });
    void opening.then(value => {
      if (control.signal.aborted && !binding) {
        log('late-browser-open', { sessionId: value.sessionId });
        void value.close().then(() => log('late-browser-close', { closed: true }), () => log('late-browser-close', { closed: false }));
      }
    }, () => { if (sealed) log('late-browser-open-error', null); });
    binding = await bounded(opening, control.signal);
    if (binding.materializationOrigin !== (options.fixture ? 'fixture' : 'provider')) throw new Error('MATERIALIZATION_ORIGIN_MISMATCH');
    if (!id.safeParse(binding.sessionId).success || binding.rawSha256 !== digest(options.raw) ||
      !Number.isSafeInteger(binding.runId) || binding.runId < 1 || !Number.isSafeInteger(binding.generation) || binding.generation < 0)
      throw new Error('INVALID_BROWSER_BINDING');
    options.sink.write('device.json', binding.device);
    log('session-bound', { sessionId: binding.sessionId, runId: binding.runId, generation: binding.generation });
    let driver: Promise<void> | null = null;
    let priorInteractions = new Set<number>();
    while (!control.signal.aborted) {
      const operation = Promise.resolve().then(() => binding!.sample(control.signal));
      void operation.then(() => { if (sealed) log('late-browser-sample', { bodyArchived: false }); },
        () => { if (sealed) log('late-browser-sample-error', null); });
      const sample = structuredClone(await bounded(operation, control.signal));
      if (++samples > 1200 || Buffer.byteLength(JSON.stringify(sample)) > 256 * 1024) throw new Error('BROWSER_EVIDENCE_LIMIT');
      log('browser-sample', sample);
      const runs = sample.pipeline?.runs ?? [];
      if (runs.length !== 1) throw new Error('UNEXPECTED_PIPELINE_HISTORY');
      const run = runs[0];
      if (run.runId !== binding.runId || run.generation !== binding.generation || run.kind !== 'prompt' || run.droppedStages !== 0)
        throw new Error('BROWSER_RUN_MISMATCH');
      // Product telemetry currently calls non-authored prompt origin unknown.
      // Retain that observation; raw provider binding does not relabel telemetry.
      if (!['live', 'unknown'].includes(run.provenance) || sample.authoredNotice ||
        run.stages.some(stage => ['prepared', 'fixture'].includes(stage.provenance) || (stage.provenance === 'cache' && stage.name !== 'mesh')))
        throw new Error('NON_LIVE_BROWSER_PROVENANCE');
      if (run.outcome === 'failed' || run.outcome === 'cancelled') throw new Error('BROWSER_PIPELINE_FAILED');
      const completed = (name: string) => run.stages.some(stage => stage.name === name && stage.outcome === 'completed');
      const rendered = sample.renderer?.ready && sample.renderer.frames > 0 && sample.renderer.drawCalls > 0 && sample.renderer.triangles > 0;
      if (frameMs === null && rendered && completed('first-frame')) {
        frameMs = performance.now() - started;
        priorInteractions = new Set(run.stages.filter(stage => stage.name === 'first-interaction' && stage.outcome === 'completed').map(stage => stage.stageId));
        // Interaction starts after the fresh frame, so stale pre-mount input
        // telemetry cannot satisfy the endpoint without an executed driver.
        driver = Promise.resolve().then(() => binding!.interact(Uint8Array.from(options.inputLog), control.signal));
        void driver.then(() => { driverCompleted = true; log('interaction-driver-completed', null); },
          () => { log('interaction-driver-failed', null); stop('INTERACTION_DRIVER_FAILED'); });
      }
      if (frameMs !== null && driverCompleted && run.stages.some(stage => stage.name === 'first-interaction' &&
        stage.outcome === 'completed' && !priorInteractions.has(stage.stageId)) &&
        sample.runtimeEvidence?.inputResult?.includes('Applied:') && Boolean(sample.runtimeEvidence.ruleTrace)) {
        interactionMs = performance.now() - started; break;
      }
      await bounded(new Promise(resolve => setTimeout(resolve, 50)), control.signal);
    }
  } catch (caught) {
    error ??= caught instanceof Error && /^[A-Z_]+$/.test(caught.message) ? caught.message : 'BROWSER_SESSION_FAILED';
  } finally {
    clearTimeout(timer); options.signal?.removeEventListener('abort', cancel); control.abort();
    const cleanup = new AbortController(), cleanupTimer = setTimeout(() => cleanup.abort(), 3000);
    try {
      if (binding) { await bounded(Promise.resolve().then(() => binding!.close()), cleanup.signal); cleanupVerified = true; }
    } catch { error ??= 'BROWSER_CLEANUP_UNVERIFIED'; }
    finally { clearTimeout(cleanupTimer); }
  }
  const result = { outcome: error ? 'failed' : 'completed', error, sessionId: binding?.sessionId ?? null,
    frameMs, interactionMs, samples, cleanupVerified, elapsedMs: performance.now() - started,
    materializationOrigin: options.fixture ? 'fixture' : 'provider', scripted: true,
    modelCalls: options.fixture ? 0 : null, usage: null, usd: null, scope: 'blueprint-materialization-only',
    humanObservation: false, semanticReview: 'NOT_RUN', liveMeasurement: 'NOT_RUN', journal: options.sink.seal() };
  sealed = true; options.sink.write('result.json', result); return result;
}

/** Explicit fixture-only materialization smoke. Cannot earn provider or live
 * schedule credit and never calls a transport. The bridge must display its label. */
export async function runPromptMaterializationFixture(options: { bridge: LivePromptProductBridge; raw: string;
  prompt: string; slot: LivePromptSessionSlot; build: unknown; inputLog: Uint8Array; timeoutMs: number;
  sink: ReviewArtifactSink; signal?: AbortSignal }) {
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 120000) throw new Error('INVALID_TIMEOUT');
  const result = await observeBrowser({ ...options, slot: structuredClone(options.slot), build: structuredClone(options.build),
    inputLog: Uint8Array.from(options.inputLog), fixture: true });
  return { ...result, classification: 'development-smoke', materializationOrigin: 'fixture', scripted: true,
    modelCalls: 0, usage: null, usd: null, protocolAttempt: null };
}

/** Sequential, bounded, predeclared retries. A successful retry never erases its
 * predecessor; cancellation stops future dispatch and records skipped slots.
 * Every sink must be fresh and reject overwrite; persistence failure stops work. */
export async function runLivePromptSchedule(options: { experiment: unknown; schedule: unknown;
  sink: ReviewArtifactSink; createSink(id: string, scope: 'provider' | 'browser'): ReviewArtifactSink;
  readArtifact(path: string): Uint8Array; transport?: ValidatedLivePromptTransport;
  bridge?: LivePromptProductBridge; signal?: AbortSignal }) {
  options = { ...options };
  const experiment = experimentSchema.parse(structuredClone(options.experiment));
  const schedule = livePromptScheduleSchema.parse(structuredClone(options.schedule));
  if (schedule.experimentHash !== experimentDigest(experiment) || Date.parse(schedule.frozenAt) < Date.parse(experiment.frozenAt) ||
    Date.parse(schedule.frozenAt) > Date.now()) throw new Error('INVALID_FROZEN_SCHEDULE');
  const ids = new Map<string, Slot>(), roots = new Set<string>(), retried = new Set<string>();
  for (const slot of schedule.slots) {
    const entry = experiment.cases.find(value => value.id === slot.caseId);
    if (ids.has(slot.id) || !entry || entry.kind !== 'prompt' || slot.repetition > entry.repetitions) throw new Error('INVALID_SCHEDULE_SLOT');
    const key = `${slot.caseId}/${slot.arm}/${slot.repetition}`;
    if (slot.retryOf) {
      const parent = ids.get(slot.retryOf);
      if (!parent || retried.has(parent.id) || `${parent.caseId}/${parent.arm}/${parent.repetition}` !== key) throw new Error('INVALID_RETRY_CHAIN');
      retried.add(parent.id);
    } else { if (roots.has(key)) throw new Error('DUPLICATE_SCHEDULE_SLOT'); roots.add(key); }
    ids.set(slot.id, slot);
  }
  const artifacts = new Map<string, Uint8Array>();
  verifyReviewArtifacts(experiment, path => { const bytes = Uint8Array.from(options.readArtifact(path)); artifacts.set(path, bytes); return bytes; });
  options.sink.write('schedule.json', { ...schedule, scheduleHash: digest(canonical(schedule)), experiment });
  const results: { id: string; retryOf: string | null; outcome: string; error: string | null; provider: unknown; browser: unknown }[] = [];
  let dispatchFence = false;
  for (const slot of schedule.slots) {
    const parent = slot.retryOf ? results.find(value => value.id === slot.retryOf) : null;
    const parentProvider = parent?.provider as Awaited<ReturnType<typeof runLivePromptProvider>> | null;
    const parentBrowser = parent?.browser as Awaited<ReturnType<typeof observeBrowser>> | null;
    const retryUnsafe = parent && ((parentProvider?.dispatched && parentProvider.remoteCompletion !== 'confirmed') ||
      (parentBrowser && !parentBrowser.cleanupVerified));
    const skipped = options.signal?.aborted ? 'SCHEDULE_CANCELLED' : dispatchFence ? 'PRIOR_TERMINATION_UNVERIFIED'
      : parent && parent.outcome !== 'failed' ? 'RETRY_NOT_NEEDED'
      : retryUnsafe ? 'RETRY_TERMINATION_UNVERIFIED' : null;
    options.sink.append({ event: 'slot-start', slot, skipped });
    if (skipped) { results.push({ id: slot.id, retryOf: slot.retryOf, outcome: 'skipped', error: skipped, provider: null, browser: null }); continue; }
    let raw: string | null = null;
    const providerSink = options.createSink(slot.id, 'provider');
    const sink: ReviewArtifactSink = { ...providerSink, write(name, value) {
      const ref = providerSink.write(name, value);
      if (name === 'provider-response.json' && value && typeof value === 'object' && 'raw' in value && typeof value.raw === 'string') raw = value.raw;
      return ref;
    } };
    // Avoid spending a provider call for a schedule that cannot reach a browser.
    if (!options.bridge) {
      options.sink.append({ event: 'slot-failed', slot, error: 'PRODUCT_BROWSER_BRIDGE_REQUIRED' });
      results.push({ id: slot.id, retryOf: slot.retryOf, outcome: 'failed', error: 'PRODUCT_BROWSER_BRIDGE_REQUIRED', provider: null, browser: null }); continue;
    }
    const provider = await runLivePromptProvider({ experiment, ...slot, attemptId: slot.id, sink,
      readArtifact: path => Uint8Array.from(artifacts.get(path)!), transport: options.transport, signal: options.signal });
    const entry = experiment.cases.find(value => value.id === slot.caseId)!;
    const browser = provider.outcome === 'provider-completed' && raw !== null ? await observeBrowser({ bridge: options.bridge,
      raw, slot, prompt: new TextDecoder('utf-8', { fatal: true }).decode(artifacts.get(entry.input.path)!),
      build: experiment[slot.arm], inputLog: artifacts.get(entry.inputLog.path)!,
      timeoutMs: schedule.browserTimeoutMs, sink: options.createSink(slot.id, 'browser'), signal: options.signal }) : null;
    const error = provider.error ?? browser?.error ?? (browser ? null : 'BROWSER_NOT_RUN');
    if ((error && provider.dispatched && provider.remoteCompletion !== 'confirmed') || (browser && !browser.cleanupVerified)) dispatchFence = true;
    const result = { id: slot.id, retryOf: slot.retryOf, outcome: error ? 'failed' : 'completed', error, provider, browser };
    results.push(result); options.sink.append({ event: 'slot-finished', result });
  }
  const result = { version: 'live-prompt-session-v1', classification: 'development', results,
    protocolAttempt: null, humanObservation: false, semanticReview: 'NOT_RUN', liveMeasurement: 'NOT_RUN', usd: null,
    limitations: ['Materialization-only seam: a single raw provider response is not the full intent/compiler/repair production generation chain.',
      'Product bridge and device/build identity are trusted caller claims.',
      'No independent prompt fulfillment or human evidence.', 'Frame means application rendering, not scanout.',
      'Browser close does not prove server or remote inference termination.'], journal: options.sink.seal() };
  options.sink.write('result.json', result); return result;
}
