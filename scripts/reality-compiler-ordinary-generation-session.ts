/** One frozen full-core generation followed by an actual product materialization.
 * No launcher, implicit retry or promotion of fixtures to live evidence. */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { canonical } from '../src/ir/worlddoc';
import { ordinaryGenerationSchema, runOrdinaryGeneration, type OrdinaryGenerationCapability } from './reality-compiler-ordinary-generation';
import { observeBrowser, type LivePromptProductBridge } from './reality-compiler-live-prompt-session';
import { experimentDigest, experimentSchema, verifyReviewArtifacts } from './reality-compiler-review-protocol';
import type { ReviewArtifactSink } from './reality-compiler-review-runner';

const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
export const ordinaryGenerationSessionSchema = z.strictObject({
  version: z.literal('ordinary-generation-session-v1'), frozenAt: z.iso.datetime(),
  generationHash: z.string().regex(/^[a-f0-9]{64}$/), browserTimeoutMs: z.number().int().min(1).max(120000),
});

export async function runOrdinaryGenerationSession(options: { experiment: unknown; generation: unknown; session: unknown;
  capability: OrdinaryGenerationCapability; bridge: LivePromptProductBridge;
  sink: ReviewArtifactSink; createSink(scope: 'generation' | 'browser'): ReviewArtifactSink;
  readArtifact(path: string): Uint8Array; signal?: AbortSignal }) {
  const started = performance.now();
  options = { ...options };
  const capability: OrdinaryGenerationCapability = options.capability.mode === 'fixture'
    ? { mode: 'fixture', emit: options.capability.emit.bind(options.capability) }
    : { mode: 'live', transport: { readiness: options.capability.transport.readiness.bind(options.capability.transport),
      currentIdentity: options.capability.transport.currentIdentity.bind(options.capability.transport),
      emit: options.capability.transport.emit.bind(options.capability.transport) } };
  const bridge = { open: options.bridge.open.bind(options.bridge) };
  const experiment = experimentSchema.parse(structuredClone(options.experiment));
  const generation = ordinaryGenerationSchema.parse(structuredClone(options.generation));
  const session = ordinaryGenerationSessionSchema.parse(structuredClone(options.session));
  const generationHash = sha(canonical(generation)), configHash = sha(canonical(experiment.config));
  if (session.generationHash !== generationHash || generation.experimentHash !== experimentDigest(experiment) ||
    Date.parse(session.frozenAt) < Date.parse(generation.frozenAt) || Date.parse(session.frozenAt) > Date.now())
    throw new Error('INVALID_FROZEN_GENERATION_SESSION');
  const entry = experiment.cases.find(value => value.id === generation.caseId);
  if (!entry || entry.kind !== 'prompt') throw new Error('INVALID_GENERATION_SESSION_CASE');
  const artifacts = new Map<string, Uint8Array>();
  const readArtifact = (path: string) => {
    if (!artifacts.has(path)) artifacts.set(path, Uint8Array.from(options.readArtifact(path)));
    return Uint8Array.from(artifacts.get(path)!);
  };
  verifyReviewArtifacts(experiment, readArtifact);
  // Freeze grammar now too, before any asynchronous operation or user callback.
  verifyReviewArtifacts({ grammar: generation.grammar }, readArtifact);
  const prompt = new TextDecoder('utf-8', { fatal: true }).decode(readArtifact(entry.input.path));
  const inputLog = readArtifact(entry.inputLog.path), mode = capability.mode;
  options.sink.write('session.json', { session, sessionHash: sha(canonical(session)), generation, experiment, mode });
  let generated: Awaited<ReturnType<typeof runOrdinaryGeneration>> | null = null;
  let generationAttempted = false;
  let browser: Awaited<ReturnType<typeof observeBrowser>> | null = null;
  let error: string | null = null;
  try {
    const generationSink = options.createSink('generation');
    generationAttempted = true;
    generated = await runOrdinaryGeneration({ experiment, generation, capability,
      sink: generationSink, readArtifact, signal: options.signal });
    if (generated.outcome !== 'compiled' || !generated.blueprint) throw new Error(generated.error ?? 'GENERATION_NOT_COMPILED');
    const raw = JSON.stringify(generated.blueprint);
    if (generated.generationHash !== generationHash || generated.configHash !== configHash || generated.promptSha256 !== sha(prompt) ||
      generated.blueprintSha256 !== sha(raw) || generated.origin !== (mode === 'fixture' ? 'fixture' : 'live'))
      throw new Error('GENERATION_MATERIALIZATION_BINDING_MISMATCH');
    if (options.signal?.aborted) throw new Error('GENERATION_SESSION_CANCELLED');
    options.sink.write('materialization-binding.json', { generationHash, blueprintSha256: sha(raw), promptSha256: sha(prompt),
      origin: generated.origin, derivation: 'Validated compiler output; original per-call provider/fixture responses remain in the generation archive.' });
    browser = await observeBrowser({ bridge, raw, prompt, inputLog, fixture: mode === 'fixture',
      slot: { id: generation.attemptId, caseId: generation.caseId, arm: generation.arm, repetition: generation.repetition, retryOf: null },
      build: experiment[generation.arm], timeoutMs: session.browserTimeoutMs, sink: options.createSink('browser'), signal: options.signal });
    if (browser.outcome !== 'completed') error = browser.error ?? 'GENERATION_BROWSER_FAILED';
  } catch (caught) {
    error = caught instanceof Error && /^[A-Z_]+$/.test(caught.message) ? caught.message : 'GENERATION_SESSION_FAILED';
  }
  const result = { version: 'ordinary-generation-session-result-v1', classification: 'development',
    outcome: error ? 'failed' : 'completed', error, generationHash, configHash, mode, generated, browser,
    elapsedMs: performance.now() - started,
    modelCalls: generated?.modelCalls ?? (mode === 'live' && generationAttempted ? null : 0), usage: null, usd: null,
    // The transport does not provide a local cleanup receipt. Browser cleanup
    // cannot fill that gap or authorize another provider dispatch.
    nextDispatchAllowed: mode === 'fixture' && browser?.cleanupVerified === true && !options.signal?.aborted,
    providerTermination: generated?.termination ?? (mode === 'live' && generationAttempted
      ? { localCleanup: 'not-verified', remote: 'unknown' } : null), browserCleanupVerified: browser?.cleanupVerified ?? null,
    liveMeasurement: 'NOT_RUN', humanObservation: false, semanticReview: 'NOT_RUN', protocolAttempt: null,
    limitations: ['One attempt; no retry schedule, live benchmark or independent semantic credit.',
      'Compiler-derived blueprint is not a verbatim provider response.',
      'Unknown provider process cleanup remains separate from browser cleanup.'], journal: options.sink.seal() };
  options.sink.write('result.json', result); return result;
}
