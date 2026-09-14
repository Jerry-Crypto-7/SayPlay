/** Full ordinary intent/compiler/repair dependency-injection seam. No launcher,
 * network, credential access or product session belongs to this module. */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { canonical } from '../src/ir/worlddoc';
import { buildIntentRequest, readPlannerEmission } from '../src/model/worldstream-intent';
import { compileWithRepair, MAX_BLUEPRINT_ROUNDS, type BlueprintOutcome } from '../src/model/worldstream-repair';
import type { Grammar, UpstreamRequest } from '../src/model/prompt';
import type { PhaseObserver } from '../src/model/phase-observer';
import type { WorldstreamBlueprint } from '../src/worldstream/schema';
import { experimentSchema, experimentDigest, verifyReviewArtifacts, type ReviewExperiment } from './reality-compiler-review-protocol';
import type { ReviewArtifactSink } from './reality-compiler-review-runner';
import type { LivePromptReadiness, LivePromptResponse } from './reality-compiler-live-prompt-runner';
import { assessProductionReadiness, SUBSCRIPTION_PRODUCTION_PROFILE, type ProductionValidationIdentity } from './subscription-production-profile';

const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
const vocabulary = z.array(z.string().min(1).max(200)).min(1).max(200);
const grammarSchema = z.strictObject({ surfaceEvents: vocabulary, conditions: vocabulary, actions: vocabulary,
  simFields: vocabulary, lookFields: vocabulary });
export const ordinaryGenerationSchema = z.strictObject({
  version: z.literal('ordinary-generation-v1'), frozenAt: z.iso.datetime(), experimentHash: z.string().regex(/^[a-f0-9]{64}$/),
  caseId: id, arm: z.enum(['before', 'after']), repetition: z.number().int().min(1).max(30), attemptId: id,
  grammar: z.strictObject({ path: z.string().min(1).max(200), sha256: z.string().regex(/^[a-f0-9]{64}$/) }),
  sessionSeed: z.number().int().min(0).max(2147483647), maxBlueprintRounds: z.literal(3),
  /** Additional frozen orchestration/archive bounds, not production process claims. */
  chainDeadlineMs: z.literal(180000), maxRequestBytes: z.literal(8388608),
});
export interface OrdinaryGenerationTransport {
  readiness(signal: AbortSignal): Promise<LivePromptReadiness>;
  currentIdentity(signal: AbortSignal): Promise<ProductionValidationIdentity>;
  /** Enforce remainingBudgetMs as well as fixed production limits; cancellation
   * must clean this call before any later dispatch. This interface is no launcher. */
  emit(request: { request: UpstreamRequest; config: ReviewExperiment['config']; remainingBudgetMs: number }, signal: AbortSignal,
    providerStarted: () => void): Promise<LivePromptResponse>;
}
type FixtureResponse = { origin: 'fixture'; raw: string; usage: null; remoteCompletion: 'not-started' };
export type OrdinaryGenerationCapability = { mode: 'live'; transport: OrdinaryGenerationTransport }
  | { mode: 'fixture'; emit(request: UpstreamRequest, signal: AbortSignal): Promise<FixtureResponse> };

function bounded<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(new Error('GENERATION_INTERRUPTED')); };
    operation.then(value => { signal.removeEventListener('abort', abort); resolve(value); },
      error => { signal.removeEventListener('abort', abort); reject(error); });
    if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
  });
}
function responseEvidence(value: LivePromptResponse | FixtureResponse) {
  if (typeof value?.raw !== 'string') return { error: 'INVALID_GENERATION_RESPONSE' };
  const bytes = Buffer.byteLength(value.raw), sha256 = hash(value.raw);
  if (bytes > SUBSCRIPTION_PRODUCTION_PROFILE.maxOutputBytes) return { error: 'GENERATION_OUTPUT_LIMIT', bytes, sha256, bodyArchived: false };
  const usage = value.usage;
  if (usage !== null && (typeof usage !== 'object' || Array.isArray(usage) || Object.keys(usage).length > 64 ||
    Object.entries(usage).some(([key, number]) => key.length > 100 || !Number.isFinite(number) || number < 0)))
    return { error: 'INVALID_GENERATION_USAGE', bytes, sha256, raw: value.raw };
  return { origin: ['live', 'fixture', 'prepared', 'cache', 'nearest', 'scripted'].includes(value.origin) ? value.origin : 'unknown',
    raw: value.raw, bytes, sha256, usage: structuredClone(usage),
    remoteCompletion: ['confirmed', 'unknown', 'not-started'].includes(value.remoteCompletion) ? value.remoteCompletion : null };
}

export async function runOrdinaryGeneration(options: { experiment: unknown; generation: unknown; capability: OrdinaryGenerationCapability;
  sink: ReviewArtifactSink; readArtifact(path: string): Uint8Array; signal?: AbortSignal }) {
  options = { ...options, experiment: structuredClone(options.experiment), generation: structuredClone(options.generation),
    capability: options.capability.mode === 'fixture' ? { mode: 'fixture', emit: options.capability.emit.bind(options.capability) }
      : { mode: 'live', transport: { readiness: options.capability.transport.readiness.bind(options.capability.transport),
        currentIdentity: options.capability.transport.currentIdentity.bind(options.capability.transport), emit: options.capability.transport.emit.bind(options.capability.transport) } } };
  const sink = options.sink, capability = options.capability, started = performance.now(), control = new AbortController();
  let sealed = false, observedProviderStarts = 0, error: string | null = null, calls = 0, compiled: BlueprintOutcome | null = null;
  let totalInputBytes = 0, totalOutputBytes = 0, dispatchCount = 0;
  let digest: string | null = null, configHash: string | null = null, promptSha256: string | null = null;
  let blueprint: WorldstreamBlueprint | null = null, deadlineAt: number | null = null;
  const completions: ('confirmed' | 'unknown' | 'not-started')[] = [];
  const phases: { name: string; startedAtMs: number; elapsedMs: number | null; outcome: string }[] = [];
  const log = (event: string, value: unknown) => {
    try { const row = { event, atMs: performance.now() - started, value }; if (sealed) sink.late(row); else sink.append(row); }
    catch (caught) { error ??= 'ARCHIVE_FAILED'; control.abort(); throw caught; }
  };
  const cancel = () => { error ??= 'GENERATION_CANCELLED'; control.abort(); };
  const check = () => {
    if (deadlineAt !== null && performance.now() >= deadlineAt) { error ??= 'GENERATION_TIMEOUT'; control.abort(); }
    if (control.signal.aborted || error) throw new Error(error ?? 'GENERATION_INTERRUPTED');
  };
  options.signal?.addEventListener('abort', cancel, { once: true });
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const phase: PhaseObserver = name => {
    const entry = { name, startedAtMs: performance.now() - started, elapsedMs: null as number | null, outcome: 'pending' };
    phases.push(entry); log('phase-start', entry);
    return outcome => { entry.elapsedMs = performance.now() - started - entry.startedAtMs; entry.outcome = outcome; log('phase-finish', entry); };
  };
  log('generation-start', { mode: capability.mode, classification: 'development', scope: 'ordinary-intent-compiler-repair' });
  try {
    const experiment = experimentSchema.parse(options.experiment), generation = ordinaryGenerationSchema.parse(options.generation);
    digest = hash(canonical(generation));
    configHash = hash(canonical(experiment.config));
    if (generation.experimentHash !== experimentDigest(experiment) || Date.parse(generation.frozenAt) < Date.parse(experiment.frozenAt) ||
      Date.parse(generation.frozenAt) > Date.now()) throw new Error('INVALID_FROZEN_GENERATION');
    const entry = experiment.cases.find(value => value.id === generation.caseId);
    if (!entry || entry.kind !== 'prompt' || generation.repetition > entry.repetitions) throw new Error('INVALID_GENERATION_SLOT');
    if (experiment.config.model !== SUBSCRIPTION_PRODUCTION_PROFILE.model || experiment.config.timeoutMs !== SUBSCRIPTION_PRODUCTION_PROFILE.jobDeadlineMs ||
      generation.maxBlueprintRounds !== MAX_BLUEPRINT_ROUNDS) throw new Error('GENERATION_PROFILE_MISMATCH');
    const artifacts = new Map<string, Uint8Array>();
    verifyReviewArtifacts(experiment, path => { const value = Uint8Array.from(options.readArtifact(path)); artifacts.set(path, value); return value; });
    const grammarBytes = Uint8Array.from(options.readArtifact(generation.grammar.path));
    if (grammarBytes.length > 65536 || hash(grammarBytes) !== generation.grammar.sha256) throw new Error('GENERATION_GRAMMAR_MISMATCH');
    const grammar: Grammar = grammarSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(grammarBytes)));
    const prompt = new TextDecoder('utf-8', { fatal: true }).decode(artifacts.get(entry.input.path)!);
    promptSha256 = hash(prompt);
    sink.write('generation.json', { experiment, generation, generationHash: digest, mode: capability.mode });
    sink.write('grammar.json', grammar); sink.write('prompt.json', { prompt, sha256: hash(prompt) });
    deadlineAt = started + generation.chainDeadlineMs;
    deadline = setTimeout(() => { error ??= 'GENERATION_TIMEOUT'; control.abort(); }, Math.max(1, deadlineAt - performance.now()));
    if (options.signal?.aborted) cancel(); check();
    const emit = async (request: UpstreamRequest): Promise<unknown> => {
      check();
      const number = ++calls, stage = number === 1 ? 'intent' : number === 2 ? 'compiler' : 'repair';
      if (number > 1 + generation.maxBlueprintRounds || request.model !== experiment.config.model) throw new Error('GENERATION_CALL_CONTRACT');
      const frozenRequest = structuredClone(request), serialized = JSON.stringify(frozenRequest), inputBytes = Buffer.byteLength(serialized);
      if (inputBytes > generation.maxRequestBytes) {
        sink.write(`request-${number}.json`, { error: 'GENERATION_INPUT_LIMIT', bytes: inputBytes, sha256: hash(serialized), bodyArchived: false });
        throw new Error('GENERATION_INPUT_LIMIT');
      }
      sink.write(`request-${number}.json`, { number, stage, request: frozenRequest, bytes: inputBytes, sha256: hash(serialized), config: experiment.config });
      totalInputBytes += inputBytes;
      if (capability.mode === 'live') {
        if (completions.some(value => value !== 'confirmed')) throw new Error('PRIOR_REMOTE_TERMINATION_UNVERIFIED');
        const readiness = structuredClone(await bounded(Promise.resolve().then(() => capability.transport.readiness(control.signal)), control.signal));
        const identity = structuredClone(await bounded(Promise.resolve().then(() => capability.transport.currentIdentity(control.signal)), control.signal));
        const assessment = assessProductionReadiness(readiness.validation, identity);
        sink.write(`readiness-${number}.json`, { readiness, identity, assessment });
        if (!assessment.ready) throw new Error('SUBSCRIPTION_PRODUCTION_NOT_VALIDATED');
        if (canonical(readiness.config) !== canonical(experiment.config)) throw new Error('FROZEN_CONFIG_MISMATCH');
        if (readiness.validation.stages.runtimeProbe.reportSha256 !== experiment.config.runtimeValidation.sha256 ||
          readiness.validation.stages.productionSandbox.reportSha256 !== experiment.config.sandboxValidation.sha256) throw new Error('FROZEN_VALIDATION_EVIDENCE_MISMATCH');
      }
      check(); log('call-dispatch', { number, stage, mode: capability.mode });
      let didStart = false, providerStartedAt: number | null = null;
      if (capability.mode === 'live') { dispatchCount++; completions.push('unknown'); }
      const operation = Promise.resolve().then<LivePromptResponse | FixtureResponse>(() => {
        check();
        const remainingBudgetMs = Math.max(1, Math.floor(deadlineAt! - performance.now()));
        sink.write(`dispatch-budget-${number}.json`, { remainingBudgetMs, scope: 'remaining overall chain deadline, fixed production job limit unchanged' });
        check();
        return capability.mode === 'fixture' ? capability.emit(structuredClone(frozenRequest), control.signal)
          : capability.transport.emit({ request: structuredClone(frozenRequest), config: structuredClone(experiment.config), remainingBudgetMs }, control.signal, () => {
            if (sealed || control.signal.aborted || didStart) { error ??= 'INVALID_PROVIDER_START'; control.abort(); throw new Error('INVALID_PROVIDER_START'); }
            didStart = true; providerStartedAt = performance.now(); observedProviderStarts++; log('provider-start', { number, observedProviderStarts });
          });
      });
      void operation.then(value => {
        // Count every known raw response before sealing, including cancellation
        // races and rejected bodies. A genuinely later result stays separate.
        if (!sealed && typeof value?.raw === 'string') totalOutputBytes += Buffer.byteLength(value.raw);
        if (sealed || control.signal.aborted) log('late-response', { number, evidence: responseEvidence(value) });
      },
        () => { if (sealed || control.signal.aborted) log('late-response-error', { number, error: 'PROVIDER_REJECTED' }); }).catch(() => undefined);
      const response = await bounded(operation, control.signal).catch(() => {
        log('call-failed', { number, error: error ?? 'GENERATION_EMITTER_FAILED' });
        throw new Error(error ?? 'GENERATION_EMITTER_FAILED');
      }), providerElapsedMs = providerStartedAt === null ? null : performance.now() - providerStartedAt;
      const evidence = responseEvidence(response);
      sink.write(`response-${number}.json`, { ...evidence, providerElapsedMs });
      if ('error' in evidence) throw new Error(evidence.error);
      if (response.origin !== (capability.mode === 'live' ? 'live' : 'fixture') ||
        (capability.mode === 'live' ? !didStart || !['unknown', 'confirmed'].includes(response.remoteCompletion)
          : response.usage !== null || response.remoteCompletion !== 'not-started')) throw new Error('INVALID_GENERATION_PROVENANCE');
      if (capability.mode === 'live') completions[dispatchCount - 1] = response.remoteCompletion as 'unknown' | 'confirmed';
      check();
      const parseStarted = performance.now();
      try { return JSON.parse(response.raw); }
      catch { throw new Error('GENERATION_INVALID_JSON'); }
      finally { log('response-parse', { number, elapsedMs: performance.now() - parseStarted }); }
    };
    const finishIntent = phase('intent-emitter');
    let intentRaw: unknown;
    try { intentRaw = await emit(buildIntentRequest(prompt)); finishIntent('completed'); }
    catch (caught) { finishIntent('failed'); throw caught; }
    check(); const intentStarted = performance.now(), plan = readPlannerEmission(intentRaw);
    sink.write('intent-validation.json', plan);
    log('intent-validation', { elapsedMs: performance.now() - intentStarted, accepted: plan.ok });
    if (!plan.ok) throw new Error('INTENT_REJECTED');
    compiled = await compileWithRepair({ plan: plan.value, grammar, sessionSeed: generation.sessionSeed,
      maxRounds: generation.maxBlueprintRounds, emit, observePhase: phase, now: () => performance.now() });
    check();
    // Do not serialize arbitrary thrown provider objects or their secret-bearing messages.
    const unavailableCode = compiled.kind === 'unavailable' && compiled.cause instanceof Error &&
      /^(GENERATION_|INVALID_|FROZEN_|SUBSCRIPTION_|PRIOR_)[A-Z_]{1,80}$/.test(compiled.cause.message) ? compiled.cause.message : 'COMPILER_EMITTER_UNAVAILABLE';
    sink.write('compiler-outcome.json', compiled.kind === 'unavailable' ? { kind: compiled.kind, rounds: compiled.rounds, error: unavailableCode } : compiled);
    if (compiled.kind !== 'compiled') throw new Error(compiled.kind === 'unavailable' ? unavailableCode : 'COMPILER_REJECTED');
    blueprint = compiled.result.value;
    sink.write('blueprint.json', blueprint);
  } catch (caught) {
    error ??= caught instanceof Error && /^[A-Z_]+$/.test(caught.message) ? caught.message : 'ORDINARY_GENERATION_FAILED';
  } finally {
    if (deadline) clearTimeout(deadline); options.signal?.removeEventListener('abort', cancel); control.abort();
  }
  const result = { version: 'ordinary-generation-result-v1', classification: 'development', mode: capability.mode,
    generationHash: digest, configHash, promptSha256, origin: blueprint && !error ? capability.mode === 'live' ? 'live' : 'fixture' : 'unknown',
    outcome: error ? 'failed' : 'compiled', error,
    modelCalls: dispatchCount === observedProviderStarts ? observedProviderStarts : null,
    observedProviderStarts, emitterInvocations: calls, dispatchCount,
    inputBytes: totalInputBytes, outputBytes: totalOutputBytes,
    byteScope: 'JSON UpstreamRequest and raw response UTF-8 observed before sealing, including rejected/oversize raw responses; not CLI wire bytes. Later responses remain separate evidence.',
    usage: null, usd: null, phases, phaseScope: 'Core wrapper durations include readiness/emission/parsing; never standalone model timing.', rounds: compiled?.rounds ?? [], blueprint,
    blueprintSha256: blueprint ? hash(JSON.stringify(blueprint)) : null,
    termination: { localCleanup: dispatchCount === 0 ? 'not-started' : 'not-verified',
      remote: dispatchCount === 0 ? 'not-started' : completions.every(value => value === 'confirmed') ? 'confirmed' : 'unknown' },
    remoteCompletions: completions, liveMeasurement: 'NOT_RUN', humanObservation: false, semanticReview: 'NOT_RUN', protocolAttempt: null,
    elapsedMs: performance.now() - started,
    limitations: ['Actual core intent/compiler/repair orchestration; no product/browser latency or independent semantic evidence.',
      'Production readiness is a trusted caller contract, not origin attestation.',
      'Cancellation cannot preempt synchronous compiler validation or prove remote inference termination.',
      'Fixture model calls are zero; stored/fixture answers never earn live credit.',
      'A dispatched call without a start callback makes modelCalls unknown; observedProviderStarts remains the callback count.',
      'Per-call usage is archived; aggregate usage remains null rather than inventing a cross-call contract.'], journal: sink.seal() };
  sealed = true; sink.write('result.json', result); return result;
}
