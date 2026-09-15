/** Ordinary prompt provider seam. No launcher, browser, API fallback or human credit.
 * A caller-owned capability must validate the actual production profile; accepting
 * its report here does not perform that validation or authorize credentials. */
import { createHash } from 'node:crypto';
import { canonical } from '../src/ir/worlddoc';
import { experimentDigest, experimentSchema, verifyReviewArtifacts, type ReviewExperiment } from './reality-compiler-review-protocol';
import type { ReviewArtifactSink } from './reality-compiler-review-runner';
import { assessProductionReadiness, SUBSCRIPTION_PRODUCTION_PROFILE,
  type ProductionValidationIdentity, type ProductionProfileValidation } from './subscription-production-profile';

export interface LivePromptReadiness {
  config: ReviewExperiment['config'];
  validation: ProductionProfileValidation;
}
export interface LivePromptResponse {
  origin: 'live';
  raw: string;
  usage: Record<string, number> | null;
  /** CLI completion is distinct from remote inference completion. */
  remoteCompletion: 'confirmed' | 'unknown';
}
export interface ValidatedLivePromptTransport {
  readiness(signal: AbortSignal): Promise<LivePromptReadiness>;
  /** Read the trusted current dispatcher identity, never the report's own identity. */
  currentIdentity(signal: AbortSignal): Promise<ProductionValidationIdentity>;
  /** Must enforce frozen process/input/output limits and report start immediately
   * before provider dispatch. No oracle, input log or intervention is passed. */
  generate(request: { prompt: string; config: ReviewExperiment['config'] },
    signal: AbortSignal, providerStarted: () => void): Promise<LivePromptResponse>;
}

function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error('OPERATION_ABORTED'));
    // Attach handlers even if the operation synchronously caused cancellation.
    operation.then(value => { signal.removeEventListener('abort', abort); resolve(value); },
      error => { signal.removeEventListener('abort', abort); reject(error); });
    if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
  });
}

export async function runLivePromptProvider(options: {
  experiment: unknown; caseId: string; arm: 'before' | 'after'; repetition: number;
  attemptId: string; sink: ReviewArtifactSink; readArtifact(path: string): Uint8Array;
  transport?: ValidatedLivePromptTransport; signal?: AbortSignal;
}) {
  // Isolate externally mutable metadata before the first asynchronous operation.
  options = { ...options, experiment: structuredClone(options.experiment) };
  const sink = options.sink, started = performance.now();
  let sealed = false, modelCalls = 0, dispatched = false;
  let error: string | null = null;
  let outcome: 'provider-completed' | 'failed' | 'cancelled' | 'interrupted' = 'failed';
  let response: LivePromptResponse | null = null;
  let inputBytes: number | null = null, outputBytes: number | null = null;
  let providerAt: number | null = null, providerMs: number | null = null, preflightMs: number | null = null;
  let digest: string | null = null;
  const control = new AbortController();
  const log = (event: string, value: unknown) => {
    const entry = { event, atMs: performance.now() - started, value };
    if (sealed) sink.late(entry); else sink.append(entry);
  };
  const stop = (code: string, state: typeof outcome) => {
    if (error === null) { error = code; outcome = state; log('attempt-stop', { error, outcome }); }
    control.abort();
  };
  const cancel = () => stop('SESSION_CANCELLED', 'cancelled');
  options.signal?.addEventListener('abort', cancel, { once: true });
  let deadline: ReturnType<typeof setTimeout> | undefined;
  log('attempt-start', { attemptId: options.attemptId, caseId: options.caseId, arm: options.arm,
    repetition: options.repetition, scope: 'ordinary-prompt-provider-only', semanticReview: 'NOT_RUN' });
  try {
    const experiment = experimentSchema.parse(options.experiment);
    digest = experimentDigest(experiment);
    sink.write('manifest.json', experiment);
    const entry = experiment.cases.find(value => value.id === options.caseId);
    if (!entry || entry.kind !== 'prompt' || !options.attemptId.trim() ||
      !['before', 'after'].includes(options.arm) || !Number.isSafeInteger(options.repetition) ||
      options.repetition < 1 || options.repetition > entry.repetitions) throw new Error('INVALID_PROMPT_SLOT');
    if (Date.now() < Date.parse(experiment.frozenAt)) throw new Error('ATTEMPT_BEFORE_FREEZE');
    if (experiment.config.timeoutMs > 30 * 60_000) throw new Error('INVALID_TIMEOUT');
    deadline = setTimeout(() => stop('SESSION_TIMEOUT', 'interrupted'), experiment.config.timeoutMs);
    if (options.signal?.aborted) { cancel(); throw new Error('SESSION_CANCELLED'); }
    if (!options.transport) throw new Error('VALIDATED_PRODUCTION_TRANSPORT_REQUIRED');
    const transport = options.transport;
    const artifacts = new Map<string, Uint8Array>();
    verifyReviewArtifacts(experiment, path => {
      const bytes = Uint8Array.from(options.readArtifact(path)); artifacts.set(path, bytes); return bytes;
    });
    const prompt = new TextDecoder('utf-8', { fatal: true }).decode(artifacts.get(entry.input.path)!);
    inputBytes = Buffer.byteLength(prompt);
    sink.write('input.json', { prompt, bytes: inputBytes, sha256: createHash('sha256').update(prompt).digest('hex') });
    const checkTransport = async (beforeDispatch: boolean) => {
    const readiness = structuredClone(await abortable(Promise.resolve().then(() => transport.readiness(control.signal)), control.signal));
    sink.write(beforeDispatch ? 'transport-readiness-before-dispatch.json' : 'transport-readiness.json', readiness);
    const identity = structuredClone(await abortable(Promise.resolve().then(() => transport.currentIdentity(control.signal)), control.signal));
    const assessment = assessProductionReadiness(readiness.validation, identity);
    sink.write(beforeDispatch ? 'production-readiness-before-dispatch.json' : 'production-readiness-assessment.json', { identity, assessment });
    if (!assessment.ready) throw new Error('SUBSCRIPTION_PRODUCTION_NOT_VALIDATED');
    if (readiness.validation.stages.runtimeProbe.reportSha256 !== experiment.config.runtimeValidation.sha256 ||
      readiness.validation.stages.productionSandbox.reportSha256 !== experiment.config.sandboxValidation.sha256)
      throw new Error('FROZEN_VALIDATION_EVIDENCE_MISMATCH');
    if (canonical(readiness.config) !== canonical(experiment.config)) throw new Error('FROZEN_CONFIG_MISMATCH');
    if (experiment.config.model !== SUBSCRIPTION_PRODUCTION_PROFILE.model ||
      experiment.config.timeoutMs !== SUBSCRIPTION_PRODUCTION_PROFILE.jobDeadlineMs)
      throw new Error('FROZEN_PRODUCTION_PROFILE_MISMATCH');
    };
    await checkTransport(false);
    if (control.signal.aborted) throw new Error('OPERATION_ABORTED');
    // Persist before dispatch, including attempts that never reach provider-start.
    const request = { prompt, config: structuredClone(experiment.config) };
    sink.write('provider-request.json', request);
    const operation = Promise.resolve().then(async () => {
      // Artifact persistence and asynchronous preflight can outlive validation.
      // Recheck the actual caller capability immediately before dispatch. The
      // dispatcher itself must still enforce identity at its exec boundary.
      await checkTransport(true);
      if (control.signal.aborted) throw new Error('OPERATION_ABORTED');
      preflightMs = performance.now() - started;
      log('transport-dispatch', { inputBytes }); dispatched = true;
      return transport.generate(request, control.signal, () => {
        if (sealed || control.signal.aborted || modelCalls !== 0) {
          log('invalid-provider-start', null);
          stop('INVALID_PROVIDER_START', 'failed'); throw new Error('INVALID_PROVIDER_START');
        }
        modelCalls = 1; providerAt = performance.now(); log('provider-start', { modelCalls });
      });
    });
    const boundedResponse = (value: LivePromptResponse) => {
      if (typeof value?.raw !== 'string') return { error: 'INVALID_LIVE_PROVIDER_RESPONSE' };
      const bytes = Buffer.byteLength(value.raw);
      // Hash/count oversize evidence; never persist an unbounded raw body.
      if (bytes > SUBSCRIPTION_PRODUCTION_PROFILE.maxOutputBytes) return {
        error: 'PROVIDER_OUTPUT_LIMIT', bytes, sha256: createHash('sha256').update(value.raw).digest('hex'), bodyArchived: false,
      };
      // Bound arbitrary callback metadata as well as raw output. Only recognized
      // usage fields survive into evidence, after strict validation below.
      const usage = value.usage;
      if (usage !== null && (typeof usage !== 'object' || Array.isArray(usage) ||
        Object.keys(usage).length > 64 || Object.entries(usage).some(([key, n]) =>
          key.length > 100 || typeof n !== 'number' || !Number.isFinite(n) || n < 0)))
        return { error: 'INVALID_LIVE_PROVIDER_RESPONSE', bytes, raw: value.raw };
      return { origin: ['live', 'prepared', 'cache', 'nearest', 'scripted'].includes(value.origin) ? value.origin : 'unknown',
        raw: value.raw, usage, remoteCompletion: ['confirmed', 'unknown'].includes(value.remoteCompletion) ? value.remoteCompletion : null };
    };
    void operation.then(value => { if (sealed) log('late-provider-response', boundedResponse(value)); },
      () => { if (sealed) log('late-provider-error', { error: 'PROVIDER_REJECTED' }); });
    const value = await abortable(operation, control.signal);
    // Archive the original response, including rejected provenance and failures.
    const evidence = boundedResponse(value);
    sink.write('provider-response.json', evidence);
    if ('error' in evidence) throw new Error(evidence.error);
    if (modelCalls !== 1) throw new Error('PROVIDER_START_REQUIRED');
    if (!value || value.origin !== 'live' || typeof value.raw !== 'string' ||
      !['confirmed', 'unknown'].includes(value.remoteCompletion) ||
      (value.usage !== null && (typeof value.usage !== 'object' || Array.isArray(value.usage) ||
        Object.values(value.usage).some(n => typeof n !== 'number' || !Number.isFinite(n) || n < 0))))
      throw new Error('INVALID_LIVE_PROVIDER_RESPONSE');
    response = { origin: 'live', raw: value.raw, usage: structuredClone(value.usage), remoteCompletion: value.remoteCompletion };
    outputBytes = Buffer.byteLength(value.raw);
    providerMs = performance.now() - providerAt!;
    outcome = 'provider-completed'; log('provider-completed', { outputBytes, providerMs });
  } catch (caught) {
    stop(caught instanceof Error && /^[A-Z_]+$/.test(caught.message) ? caught.message : 'PROMPT_PROVIDER_FAILED', 'failed');
  } finally {
    if (deadline) clearTimeout(deadline);
    options.signal?.removeEventListener('abort', cancel);
    control.abort();
  }
  const result = {
    version: 'live-prompt-provider-v1', classification: 'development', attemptId: options.attemptId,
    caseId: options.caseId, arm: options.arm, repetition: options.repetition, experimentHash: digest,
    outcome, error, origin: response ? 'live' : 'unknown', dispatched, modelCalls,
    inputBytes, outputBytes, byteScope: 'UTF-8 ordinary prompt and returned raw output; not CLI wire bytes',
    usage: response?.usage ?? null, usd: null,
    remoteCompletion: response?.remoteCompletion ?? (dispatched ? 'unknown' : 'not-started'),
    elapsedMs: performance.now() - started, stagesMs: { preflight: preflightMs, provider: providerMs, parse: null, validation: null,
      lowering: null, mesh: null, frame: null, interaction: null, compare: null },
    protocolAttempt: null, liveMeasurement: 'NOT_RUN', humanObservation: false, semanticReview: 'NOT_RUN',
    limitations: ['Provider-only: no product session, frame, interaction or prompt fulfillment evidence.',
      'Caller attestation does not independently validate the production profile.',
      'Abort does not prove remote inference termination.', 'Attempt scheduling and retry-chain validation are caller-owned.'],
    journal: sink.seal(),
  };
  sealed = true; sink.write('result.json', result); return result;
}
