/** Prepared browser diagnostics only. Never emits a live benchmark attempt. */
import { createHash } from 'node:crypto';
import type { PipelineMetricsSnapshot } from '../src/worldstream/pipeline-metrics';
import type { ReviewArtifactSink } from './reality-compiler-review-runner';

export interface PromptSample {
  pipeline: PipelineMetricsSnapshot | null;
  renderer: { ready: boolean; frames: number; drawCalls: number; triangles: number } | null;
  authoredNotice: string | null;
  runtime: { tick: number; inputs: number } | null;
  runtimeEvidence?: { inputResult: string | null; ruleTrace: string | null; tick: string | null };
}
export type PromptEndpoint = 'display' | 'interaction';
export function createPreparedPromptRecorder(options: {
  prompt: string; endpoint: PromptEndpoint; sink: ReviewArtifactSink; build: unknown;
  now?: () => number;
}) {
  const now = options.now ?? (() => performance.now());
  const started = now();
  let ended = false, submitted = false, sampleCount = 0, requestCount = 0;
  let sessionId: string | null = null, match: 'exact' | 'nearest' | null = null;
  let outcome: 'completed' | 'failed' | 'cancelled' | 'interrupted' | null = null;
  let error: string | null = null, latest: PromptSample | null = null;
  let latestJson = '', previousTime = 0;
  const time = () => {
    const value = now() - started;
    if (!Number.isFinite(value) || value < previousTime) throw new Error('INVALID_RECORDER_CLOCK');
    previousTime = value; return value;
  };
  const log = (event: string, value: unknown) => {
    const entry = { event, atMs: time(), value };
    if (ended) options.sink.late(entry); else options.sink.append(entry);
  };
  const fail = (code: string, state: Exclude<typeof outcome, 'completed' | null> = 'failed') => {
    if (!outcome) { outcome = state; error = code; log('terminal', { outcome, error }); }
  };
  const references = [options.sink.write('input.json', {
    prompt: options.prompt, sha256: createHash('sha256').update(options.prompt).digest('hex'),
    endpoint: options.endpoint, build: options.build,
  })];
  log('started', { scope: 'prepared-only', scripted: true });
  return {
    get terminal() { return outcome !== null; },
    get sessionId() { return sessionId; },
    fail,
    artifact(name: string, value: unknown) {
      if (ended) throw new Error('ALREADY_FINISHED');
      references.push(options.sink.write(name, value));
    },
    /** Exactly one prepared request. Every other write is denied before dispatch. */
    allow(method: string, path: string, body: unknown): boolean {
      requestCount++;
      if (requestCount > 64) { fail('REQUEST_LIMIT'); return false; }
      let allowed = false;
      if (!outcome && method === 'POST' && path === '/api/worldstream/sessions' && !submitted &&
        body !== null && typeof body === 'object' && !Array.isArray(body) &&
        Object.keys(body).length === 1 && (body as { prompt?: unknown }).prompt === options.prompt) {
        allowed = true; submitted = true;
      } else if (!outcome && method === 'GET' && sessionId !== null &&
        (path === `/api/worldstream/sessions/${sessionId}` || path === `/api/worldstream/sessions/${sessionId}/events`)) allowed = true;
      const liveBlocked = method === 'POST' && path === '/api/worldstream/sessions' &&
        body !== null && typeof body === 'object' && (body as { live?: unknown }).live === true;
      log('request-policy', { method, path, body, allowed, liveBlocked });
      // The product automatically requests act II. Blocking it is intentional,
      // not a failed prepared display; duplicate first-act requests are failures.
      if (!allowed && !liveBlocked && !outcome) fail('UNMEASURED_REQUEST_BLOCKED');
      return allowed;
    },
    accepted(status: number, raw: string, metadata: unknown) {
      log('session-response', { status, raw, metadata, bytes: Buffer.byteLength(raw) });
      if (outcome) return;
      if (!submitted) { fail('RESPONSE_WITHOUT_REQUEST'); return; }
      let body: Record<string, unknown>;
      try { body = JSON.parse(raw); } catch { fail('INVALID_SESSION_RESPONSE'); return; }
      const origin = body.authored as { match?: unknown } | undefined;
      if (status !== 202 || typeof body.sessionId !== 'string' || !/^[a-zA-Z0-9-]{1,100}$/.test(body.sessionId) ||
        !origin || !['exact', 'nearest'].includes(String(origin.match)) ||
        body.events !== `/api/worldstream/sessions/${body.sessionId}/events` ||
        body.snapshot !== `/api/worldstream/sessions/${body.sessionId}`) { fail('PREPARED_SESSION_REQUIRED'); return; }
      sessionId = body.sessionId; match = origin.match as typeof match;
    },
    http(value: unknown) { log('http-observation', value); },
    observe(sample: PromptSample) {
      if (outcome) return;
      if (++sampleCount > 1200) { fail('SAMPLE_LIMIT'); return; }
      const serialized = JSON.stringify(sample);
      if (serialized !== latestJson) { log('browser-sample', sample); latestJson = serialized; }
      latest = structuredClone(sample);
      const runs = sample.pipeline?.runs ?? [];
      if (runs.length > 1 || runs.some(run => run.kind !== 'prompt' || run.droppedStages > 0)) { fail('UNEXPECTED_PIPELINE_HISTORY'); return; }
      const run = runs[0];
      if (!run) return;
      if (run.outcome === 'cancelled') { fail('BROWSER_CANCELLED', 'cancelled'); return; }
      if (run.outcome === 'failed') { fail('PIPELINE_FAILED'); return; }
      if (run.provenance !== 'prepared') return;
      const complete = (name: string) => run.stages.some(stage => stage.name === name && stage.outcome === 'completed');
      const rendered = sample.renderer?.ready && sample.renderer.frames > 0 && sample.renderer.drawCalls > 0 && sample.renderer.triangles > 0;
      const notice = match === 'exact' ? sample.authoredNotice?.includes('authored ahead of time') && !sample.authoredNotice?.includes('closest')
        : match === 'nearest' && sample.authoredNotice?.includes('closest') && sample.authoredNotice.includes('not been verified');
      if (sessionId && rendered && notice && complete('first-frame') &&
        (options.endpoint === 'display' || (complete('first-interaction') &&
          sample.runtimeEvidence?.inputResult?.includes('Applied:') && Boolean(sample.runtimeEvidence.ruleTrace)))) {
        outcome = 'completed'; log('terminal', { outcome, endpoint: options.endpoint });
      }
    },
    finish() {
      if (ended) throw new Error('ALREADY_FINISHED');
      if (!outcome) fail('SESSION_ENDED_WITHOUT_ENDPOINT', 'interrupted');
      const result = {
        version: 'prepared-prompt-browser-v1' as const, classification: 'development-smoke' as const,
        outcome, error, endpoint: options.endpoint, origin: match ? 'prepared' : 'unknown', match,
        scripted: true, humanObservation: false, humanConfirmations: 0, protocolAttempt: null,
        modelCalls: 0, usage: null, usd: null, liveMeasurement: 'NOT_RUN', semanticReview: 'NOT_RUN',
        elapsedMs: time(), sessionId, latest, sampleCount, requestCount,
        serverBackgroundPhases: null,
        limitations: ['Prepared selection is not prompt fulfillment.', 'First-frame means application render, not scanout.',
          'No source-review or live latency claim.', 'HTTP 202 headers do not measure background generation.',
          'Cancelled browser observation does not prove server session termination.'],
        references, journal: options.sink.seal(),
      };
      ended = true; options.sink.write('result.json', result); return result;
    },
  };
}
