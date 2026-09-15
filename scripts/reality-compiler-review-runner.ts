/** Source-only development session recorder. No browser automation or launcher. */
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonical } from '../src/ir/worlddoc';
import { PARAMETER_KEYS, type ParameterKey } from '../src/worldstream/source-parameters';
import type { PipelineMetricsSnapshot } from '../src/worldstream/pipeline-metrics';
import type { SourceObservation } from '../src/worldstream/browser-measurement';
import { attemptSchema, experimentDigest, experimentSchema, validateReviewRun,
  type ReviewAttempt, type ReviewExperiment } from './reality-compiler-review-protocol';
import { productionValidationSchema, requireProductionReadiness, SUBSCRIPTION_PRODUCTION_PROFILE,
  type ProductionValidationIdentity } from './subscription-production-profile';

type Artifact = ReviewAttempt['journal'];
export interface ReviewArtifactSink {
  /** Must reject overwrite. References are relative to the experiment root. */
  write(name: string, value: unknown): Artifact;
  append(event: unknown): void;
  /** Late provider completion must not change the sealed attempt's journal hash. */
  late(event: unknown): void;
  seal(): Artifact;
}
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
export function createReviewArtifactSink(directory: string, relativeDirectory: string): ReviewArtifactSink {
  if (!/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/.test(relativeDirectory)) throw new Error('INVALID_ARTIFACT_DIRECTORY');
  // The caller creates the trusted parent. A new directory cannot overwrite an
  // earlier attempt. This function never reads outside that directory.
  mkdirSync(directory);
  const journal: string[] = [];
  let sealed = false;
  const line = (value: unknown) => `${JSON.stringify(value)}\n`;
  const checkedName = (name: string) => {
    if (!/^[a-zA-Z0-9_-]+\.json$/.test(name)) throw new Error('INVALID_ARTIFACT_NAME');
    return name;
  };
  return {
    write(name, value) {
      const text = `${JSON.stringify(value, null, 2)}\n`;
      writeFileSync(join(directory, checkedName(name)), text, { flag: 'wx' });
      return { path: `${relativeDirectory}/${name}`, sha256: sha(text) };
    },
    append(value) {
      if (sealed) throw new Error('JOURNAL_ALREADY_SEALED');
      const text = line(value); appendFileSync(join(directory, 'journal.jsonl'), text); journal.push(text);
    },
    late(value) { appendFileSync(join(directory, 'late-provider.jsonl'), line(value)); },
    seal() {
      if (sealed) throw new Error('JOURNAL_ALREADY_SEALED');
      sealed = true;
      return { path: `${relativeDirectory}/journal.jsonl`, sha256: sha(journal.join('')) };
    },
  };
}

export interface ReviewUIEvent {
  sequence: number;
  browserAtMs: number;
  trusted: boolean;
  kind: 'source-submit' | 'review-shown' | 'parameter-change' | 'confirm' | 'discard' | 'source-cancel' | 'input-change';
  key?: ParameterKey;
  value?: string;
}
export interface ReviewSlot {
  caseId: string; arm: 'before' | 'after'; repetition: number; attempt: number; retryOf: string | null; id: string;
}
export interface TransportReadiness {
  config: ReviewExperiment['config'];
  validation: unknown;
}
/** Only an integration seam: the caller must actually validate the current WSL
 * dispatcher/runtime/sandbox. Neither this record nor its hashes prove that. */
export function assertReviewTransportReady(experiment: ReviewExperiment, readiness: TransportReadiness | null,
  reviewerId: string | null, currentIdentity: ProductionValidationIdentity): void {
  if (!reviewerId?.trim()) throw new Error('PARAMETER_REVIEW_REQUIRED');
  requireProductionReadiness(readiness?.validation, currentIdentity);
  if (!readiness) throw new Error('SUBSCRIPTION_PRODUCTION_NOT_VALIDATED');
  const validation = productionValidationSchema.parse(readiness.validation);
  if (validation.stages.runtimeProbe.reportSha256 !== experiment.config.runtimeValidation.sha256 ||
    validation.stages.productionSandbox.reportSha256 !== experiment.config.sandboxValidation.sha256)
    throw new Error('FROZEN_VALIDATION_EVIDENCE_MISMATCH');
  if (canonical(readiness.config) !== canonical(experiment.config)) throw new Error('FROZEN_CONFIG_MISMATCH');
  const profile = SUBSCRIPTION_PRODUCTION_PROFILE, config = experiment.config;
  if (config.model !== profile.model || config.effort !== profile.effort || config.billing !== profile.billing ||
    config.apiFallback !== profile.apiFallback || config.transport !== 'official-codex-cli-chatgpt' || config.timeoutMs !== profile.jobDeadlineMs)
    throw new Error('PRODUCTION_PROFILE_CONFIG_MISMATCH');
}

export function createReviewSessionRecorder(options: {
  experiment: unknown; slot: ReviewSlot; mode: 'manual-live' | 'fixture-smoke';
  reviewerId: string | null; sink: ReviewArtifactSink; now?: () => number; date?: () => Date;
  previousRun?: unknown;
}) {
  const experiment = experimentSchema.parse(options.experiment);
  const entry = experiment.cases.find(candidate => candidate.id === options.slot.caseId);
  if (!entry || entry.kind !== 'source') throw new Error('SOURCE_SESSION_CASE_REQUIRED');
  const previous = options.previousRun === undefined ? [] : validateReviewRun(experiment, options.previousRun).run.attempts;
  const previousSlot = previous.filter(attempt => attempt.caseId === options.slot.caseId && attempt.arm === options.slot.arm &&
    attempt.repetition === options.slot.repetition).at(-1);
  if (!options.slot.id.trim() || previous.some(attempt => attempt.id === options.slot.id) ||
    !['before', 'after'].includes(options.slot.arm) || !Number.isSafeInteger(options.slot.repetition) ||
    options.slot.repetition < 1 || options.slot.repetition > entry.repetitions ||
    options.slot.attempt !== (previousSlot?.attempt ?? 0) + 1 || options.slot.retryOf !== (previousSlot?.id ?? null))
    throw new Error('INVALID_PLANNED_ATTEMPT');
  const now = options.now ?? (() => performance.now());
  const start = now(), startedAt = (options.date?.() ?? new Date()).toISOString();
  if (Date.parse(startedAt) < Date.parse(experiment.frozenAt)) throw new Error('ATTEMPT_BEFORE_FREEZE');
  const sink = options.sink;
  const at = () => Math.max(0, now() - start);
  let closed = false, sequence = 0, requestStarted = false, submitObserved = false;
  let pendingHash: string | null = null, shownAt: number | null = null, shownBrowserAt: number | null = null;
  let lastBrowserAt = -1;
  let proposal: Artifact | null = null, proposalHash: string | null = null;
  const checked = new Set<ParameterKey>();
  let review: ReviewAttempt['parameterReview'] = null;
  let terminal: ReviewAttempt['outcome'] | null = null, error: string | null = null;
  let pipeline: PipelineMetricsSnapshot | null = null, observation: SourceObservation | null = null;
  let inputBytes: number | null = null, outputBytes: number | null = null;
  let providerMs = 0, modelCalls = 0, inFlight = 0;
  let providerFailure = false, usage: ReviewAttempt['usage'] = null;
  const references: Artifact[] = [];
  const log = (event: string, detail: unknown = null) => sink.append({ event, atMs: at(), detail });
  log('attempt-start', { ...options.slot, experimentHash: experimentDigest(experiment), mode: options.mode,
    humanIdentityVerified: false, semanticReview: 'NOT_RUN' });
  function fail(code: string, outcome: ReviewAttempt['outcome'] = 'failed') {
    if (closed || terminal) return;
    terminal = outcome; error = code; log('attempt-stop', { outcome, code });
  }
  return {
    experiment,
    get terminal() { return terminal; },
    get error() { return error; },
    event(event: ReviewUIEvent) {
      if (closed || terminal) return;
      if (!Number.isSafeInteger(event.sequence) || event.sequence !== sequence + 1) {
        fail('UI_EVENT_SEQUENCE_INVALID'); return;
      }
      if (!Number.isFinite(event.browserAtMs) || event.browserAtMs < 0 || event.browserAtMs < lastBrowserAt) {
        fail('UI_EVENT_CLOCK_INVALID'); return;
      }
      sequence = event.sequence;
      lastBrowserAt = event.browserAtMs;
      log('ui-event', event);
      if (event.kind === 'source-cancel') { fail('USER_CANCELLED', 'cancelled'); return; }
      if (event.kind === 'input-change' && requestStarted) { fail('FROZEN_INPUT_CHANGED'); return; }
      if (event.kind === 'source-submit') { submitObserved = event.trusted; return; }
      if (event.kind === 'review-shown' && pendingHash && shownAt === null) {
        shownAt = at(); shownBrowserAt = event.browserAtMs; return;
      }
      if (options.mode !== 'manual-live' || !event.trusted || !pendingHash || shownAt === null) return;
      if (event.kind === 'parameter-change' && event.key && PARAMETER_KEYS.includes(event.key)) {
        if (event.value === 'supported') checked.add(event.key); else checked.delete(event.key);
      }
      if (event.kind === 'confirm' || event.kind === 'discard') {
        if (event.kind === 'confirm' && checked.size !== PARAMETER_KEYS.length) { fail('PARAMETER_REVIEW_REQUIRED'); return; }
        const decidedAtMs = at();
        const browserWaitMs = event.browserAtMs - shownBrowserAt!;
        // Keep the true browser-clock interval even if both events arrive in one
        // polling batch. Anchor its end to receipt time; absolute endpoints are
        // approximate, but no drain delay is subtracted from the human interval.
        if (browserWaitMs > decidedAtMs) { fail('UI_CLOCK_OUTSIDE_ATTEMPT'); return; }
        const alignedShownAtMs = decidedAtMs - browserWaitMs;
        const record = sink.write('parameter-review.json', { reviewerId: options.reviewerId, proposalHash: pendingHash,
          humanIdentityVerified: false, method: 'observed native browser events; no runner confirmation actions',
          clockAlignment: 'Decision anchored to recorder receipt; browser interval preserved; absolute endpoints approximate.',
          shownAtReceiptMs: shownAt, shownBrowserAtMs: shownBrowserAt, decidedBrowserAtMs: event.browserAtMs,
          shownAtMs: alignedShownAtMs, decidedAtMs, confirmed: [...checked], event });
        review = { actor: 'human', reviewerId: options.reviewerId ?? '', proposalHash: pendingHash,
          shownAtMs: alignedShownAtMs, decidedAtMs, confirmed: [...checked],
          decision: event.kind === 'confirm' ? 'confirmed' : 'rejected', record };
        // One proposal has one recorded decision. Repeated DOM events cannot
        // fabricate another confirmation or replace an earlier decision.
        pendingHash = null;
        if (event.kind === 'discard') { terminal = 'review-rejected'; log('review-rejected'); }
      }
    },
    beginRequest(body: unknown, wireBody = JSON.stringify(body)) {
      if (closed || terminal) throw new Error(error ?? 'SESSION_FINISHED');
      if (requestStarted) { fail('ONE_SOURCE_REQUEST_PER_ATTEMPT'); throw new Error('ONE_SOURCE_REQUEST_PER_ATTEMPT'); }
      if (options.mode === 'manual-live' && !submitObserved) { fail('MANUAL_SOURCE_SUBMIT_REQUIRED'); throw new Error('MANUAL_SOURCE_SUBMIT_REQUIRED'); }
      requestStarted = true; inputBytes = Buffer.byteLength(wireBody, 'utf8');
      references.push(sink.write('source-request.json', { body, raw: wireBody })); log('source-request');
    },
    providerStarted(request: unknown) {
      if (closed || terminal || !requestStarted) throw new Error('SOURCE_REQUEST_REQUIRED');
      const index = references.filter(reference => /provider-request-/.test(reference.path)).length + 1;
      references.push(sink.write(`provider-request-${index}.json`, request));
      if (options.mode === 'manual-live') { modelCalls++; inFlight++; }
      const began = at(); log('provider-start', { index, inference: options.mode === 'manual-live',
        inputBytes: Buffer.byteLength(JSON.stringify(request), 'utf8') });
      let ended = false;
      return (result: { output?: unknown; usage?: ReviewAttempt['usage']; error?: string }) => {
        if (ended) return; ended = true;
        const durationMs = at() - began;
        if (closed) { sink.late({ event: 'provider-finish', index, durationMs, ...result }); return; }
        if (options.mode === 'manual-live') { inFlight--; providerMs += durationMs; }
        providerFailure ||= result.error !== undefined;
        if (result.usage) {
          usage ??= {};
          for (const [key, value] of Object.entries(result.usage)) usage[key] = (usage[key] ?? 0) + value;
        }
        references.push(sink.write(`provider-response-${index}.json`, result));
        log('provider-finish', { index, durationMs, error: result.error ?? null,
          outputBytes: result.output === undefined ? null : Buffer.byteLength(JSON.stringify(result.output), 'utf8') });
      };
    },
    proposal(body: unknown, hash: string | null, responseBytes: number,
      wire?: { status: number; raw: string; serverTiming: string | null }) {
      if (closed || terminal) return;
      references.push(sink.write('source-response.json', body)); outputBytes = responseBytes;
      if (wire) references.push(sink.write('source-http.json', wire));
      const kind = (body as { kind?: unknown } | null)?.kind;
      if (kind === 'needsClarification') { terminal = 'clarification-required'; log('clarification-required'); return; }
      if (kind !== 'proposed' || !hash) { fail('SOURCE_NOT_PROPOSED'); return; }
      proposal = sink.write('proposal.json', body); proposalHash = hash; pendingHash = hash;
      log('proposal-ready', { proposalHash: hash });
    },
    observe(next: SourceObservation | null, timing: PipelineMetricsSnapshot | null) {
      if (closed) return;
      observation = next; pipeline = timing;
      if (options.mode === 'manual-live' && next && (!review || review.decision !== 'confirmed' ||
        next.project.parameterConfirmation.proposalHash !== proposalHash)) fail('PARAMETER_REVIEW_REQUIRED');
    },
    complete(expectedInputs: unknown, expectedIntervention: { ruleId: string; durationTicks: number; forkTick: number; observationTick: number }) {
      if (closed || terminal) return;
      if (!observation?.project.comparison) { fail('COMPARISON_REQUIRED'); return; }
      if (canonical(observation.inputs) !== canonical(expectedInputs)) { fail('FROZEN_INPUT_LOG_MISMATCH'); return; }
      const comparison = observation.project.comparison;
      if (Object.entries(expectedIntervention).some(([key, value]) => comparison[key as keyof typeof comparison] !== value)) {
        fail('FROZEN_INTERVENTION_MISMATCH'); return;
      }
      if (options.mode === 'manual-live' && (!review || review.decision !== 'confirmed')) { fail('PARAMETER_REVIEW_REQUIRED'); return; }
      terminal = 'completed'; log('comparison-observed');
    },
    fail,
    finish() {
      if (closed) throw new Error('SESSION_ALREADY_FINISHED');
      if (!terminal) fail('SESSION_INTERRUPTED', 'interrupted');
      references.push(sink.write('client-observation.json', observation));
      references.push(sink.write('client-pipeline.json', pipeline));
      const elapsedMs = at(); log('attempt-finish', { outcome: terminal, error }); closed = true;
      const journal = sink.seal();
      const stageDuration = (names: string[]) => {
        const stages = pipeline?.runs.flatMap(run => run.stages).filter(stage => names.includes(stage.name)) ?? [];
        return stages.length && stages.every(stage => stage.outcome === 'completed' && stage.elapsedMs !== null)
          ? stages.reduce((sum, stage) => sum + stage.elapsedMs!, 0) : null;
      };
      const base = { ...options.slot, experimentHash: experimentDigest(experiment), config: experiment.config,
        origin: options.mode === 'manual-live' ? 'live' as const : 'prepared' as const, startedAt, elapsedMs,
        outcome: terminal!, error, journal, proposalHash, proposal, supplements: [],
        parameterReview: review, humanWaitMs: review ? review.decidedAtMs - review.shownAtMs : null,
        stagesMs: { preflight: null, provider: modelCalls > 0 && inFlight === 0 && !providerFailure ? providerMs : null,
          parse: stageDuration(['response-parse']), validation: stageDuration(['validation']), acceptance: stageDuration(['acceptance']),
          lowering: stageDuration(['lowering']), mesh: stageDuration(['mesh']), frame: stageDuration(['first-frame']),
          interaction: stageDuration(['first-interaction']), compare: stageDuration(['compare']) },
        inputBytes, outputBytes, modelCalls, usage, usd: null, remoteCompletion: modelCalls === 0 ? 'not-started' as const :
          inFlight === 0 && !providerFailure ? 'confirmed' as const : 'unknown' as const, semanticReview: 'NOT_RUN' as const };
      // A synthetic smoke run never emits a review-v2 completed-human attempt.
      // Keep its full artifacts under a different explicit classification.
      if (options.mode === 'fixture-smoke') {
        const result = { version: 'review-runner-fixture-v1', scripted: true, humanObservation: false,
          humanConfirmations: 0, modelCalls: 0, protocolAttempt: null, result: { ...base, parameterReview: null }, references };
        sink.write('fixture-result.json', result); return result;
      }
      const attempt = attemptSchema.parse(base);
      const run = { version: 'reality-compiler-review-run-v2', experimentHash: experimentDigest(experiment), status: 'IN_PROGRESS', attempts: [...previous, attempt] };
      validateReviewRun(experiment, run);
      sink.write('attempt.json', attempt); sink.write('run.json', run);
      return { version: 'review-runner-session-v1', humanIdentityVerified: false, semanticReview: 'NOT_RUN', protocolAttempt: attempt, references };
    },
  };
}
