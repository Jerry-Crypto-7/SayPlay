import type { Browser, Page } from '@playwright/test';
import { handleSourceRequest } from '../src/app/api/worldstream/source/handler';
import { runSourceProposal, serverGrammar } from '../src/worldstream/sessions';
import { parameterProposalHash, PARAMETER_KEYS } from '../src/worldstream/source-parameters';
import type { UpstreamRequest } from '../src/model/prompt';
import type { ReviewAttempt } from './reality-compiler-review-protocol';
import { experimentSchema, verifyReviewArtifacts } from './reality-compiler-review-protocol';
import type { ProductionValidationIdentity } from './subscription-production-profile';
import { assertReviewTransportReady, createReviewSessionRecorder, type ReviewArtifactSink,
  type ReviewSlot, type ReviewUIEvent, type TransportReadiness } from './reality-compiler-review-runner';

declare global {
  interface Window {
    __reviewSessionEvents?: ReviewUIEvent[];
    __reviewSessionOverflow?: boolean;
  }
}

type Transport = {
  mode: 'manual-live'; reviewerId: string;
  /** Caller-owned validated dispatcher. This bridge does not validate WSL by
   * accepting a boolean, launch a CLI, or inspect any credential store. */
  readiness(signal?: AbortSignal): Promise<TransportReadiness>;
  /** Re-read from the trusted current dispatcher, never from the archived report. */
  currentIdentity(signal?: AbortSignal): Promise<ProductionValidationIdentity>;
  emit(request: UpstreamRequest, signal: AbortSignal): Promise<{ output: unknown; usage: ReviewAttempt['usage'] }>;
} | {
  mode: 'fixture-smoke';
  fixture(request: UpstreamRequest): Promise<unknown>;
};

/** One source request/proposal per attempt. Human uses the existing source UI,
 * including confirmation, runtime inputs and timer intervention. No operation in
 * this module clicks source-submit/source-confirm or selects parameter controls.
 * Fixture drivers belong to separate explicitly scripted test/measure code. */
export async function runInteractiveReviewSession(options: {
  browser: Browser; baseURL: string; experiment: unknown; slot: ReviewSlot; transport: Transport;
  sink: ReviewArtifactSink; readArtifact(path: string): Uint8Array; previousRun?: unknown;
  humanTimeoutMs?: number; signal?: AbortSignal;
  /** Fixture-only driver; ignored in manual-live mode. No human credit. */
  onFixturePage?: (page: Page) => void | Promise<void>;
}) {
  const experiment = experimentSchema.parse(options.experiment);
  const recorder = createReviewSessionRecorder({ experiment, slot: options.slot, mode: options.transport.mode,
    reviewerId: options.transport.mode === 'manual-live' ? options.transport.reviewerId : null,
    sink: options.sink, previousRun: options.previousRun });
  const control = new AbortController();
  const cancel = () => { recorder.fail('SESSION_CANCELLED', 'cancelled'); control.abort(); };
  options.signal?.addEventListener('abort', cancel, { once: true });
  let context: Awaited<ReturnType<Browser['newContext']>> | null = null;
  let page: Page | null = null;
  const timeoutMs = options.humanTimeoutMs ?? 30 * 60_000;
  const started = performance.now();
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let draining = Promise.resolve<unknown>(undefined);
  let readinessSequence = 0;
  const checkTransport = async () => {
    if (options.transport.mode !== 'manual-live') return;
    const readiness = structuredClone(await untilAborted(options.transport.readiness(control.signal), control.signal));
    const currentIdentity = structuredClone(await untilAborted(options.transport.currentIdentity(control.signal), control.signal));
    options.sink.write(`transport-readiness-${++readinessSequence}.json`, { readiness, currentIdentity,
      limitation: 'Trusted caller contract only; report provenance and current dispatcher identity must be verified by the caller.' });
    assertReviewTransportReady(experiment, readiness, options.transport.reviewerId, currentIdentity);
  };
  const drain = () => {
    const next = draining.then(async () => {
    if (!page || page.isClosed()) return;
    const sample = await page.evaluate(() => ({ events: window.__reviewSessionEvents?.splice(0) ?? [],
      overflow: window.__reviewSessionOverflow === true,
      observation: window.__realityCompiler?.snapshot() ?? null,
      pipeline: window.__worldstreamMetrics?.snapshot() ?? null }));
    if (sample.overflow) recorder.fail('UI_EVENT_BUFFER_OVERFLOW');
    sample.events.forEach(event => recorder.event(event));
    recorder.observe(sample.observation, sample.pipeline);
    return sample;
    });
    draining = next.catch(() => undefined);
    return next;
  };
  try {
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 30 * 60_000) throw new Error('INVALID_HUMAN_TIMEOUT');
    deadline = setTimeout(() => { recorder.fail('HUMAN_SESSION_TIMEOUT', 'interrupted'); control.abort(); }, timeoutMs);
    if (options.signal?.aborted) { cancel(); throw new Error('SESSION_CANCELLED'); }
    const url = new URL(options.baseURL);
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('LOCAL_PRODUCTION_SERVER_REQUIRED');
    const frozenArtifacts = new Map<string, Uint8Array>();
    verifyReviewArtifacts(experiment, path => {
      const bytes = Uint8Array.from(options.readArtifact(path)); frozenArtifacts.set(path, bytes); return bytes;
    });
    if (options.transport.mode === 'manual-live') {
      await checkTransport();
    }
    const entry = experiment.cases.find(candidate => candidate.id === options.slot.caseId)!;
    const text = new TextDecoder('utf-8', { fatal: true }).decode(frozenArtifacts.get(entry.input.path)!);
    const expectedInputs: unknown = JSON.parse(new TextDecoder().decode(frozenArtifacts.get(entry.inputLog.path)!));
    const expectedIntervention = JSON.parse(new TextDecoder().decode(frozenArtifacts.get(entry.intervention.path)!)) as {
      ruleId: string; durationTicks: number; forkTick: number; observationTick: number;
    };
    if (!Array.isArray(expectedInputs) || typeof expectedIntervention?.ruleId !== 'string' ||
      !['durationTicks', 'forkTick', 'observationTick'].every(key => Number.isSafeInteger(expectedIntervention[key as keyof typeof expectedIntervention])))
      throw new Error('FROZEN_TASK_ARTIFACT_INVALID');
    const grammar = serverGrammar(); if (typeof grammar === 'string') throw new Error('GRAMMAR_UNAVAILABLE');
    context = await options.browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
    page = await context.newPage();
    page.setDefaultTimeout(30_000);
    page.once('close', () => { recorder.fail('BROWSER_CLOSED', 'interrupted'); control.abort(); });
    await page.addInitScript(({ keys }) => {
      window.__reviewSessionEvents = [];
      let sequence = 0, visible = false;
      const emit = (kind: ReviewUIEvent['kind'], event?: Event, extra?: { key?: typeof keys[number]; value?: string }) => {
        const events = window.__reviewSessionEvents!;
        if (events.length >= 2048) { window.__reviewSessionOverflow = true; return; }
        events.push({ sequence: ++sequence, browserAtMs: performance.now(), trusted: event?.isTrusted === true, kind, ...extra });
      };
      document.addEventListener('submit', event => {
        if ((event.target as Element).querySelector('[data-testid="source-submit"]')) emit('source-submit', event);
      }, true);
      document.addEventListener('change', event => {
        const target = event.target as HTMLSelectElement;
        const key = keys.find(key => target.dataset.testid === `parameter-${key}`);
        if (key) emit('parameter-change', event, { key, value: target.value });
      }, true);
      document.addEventListener('input', event => {
        const target = event.target as HTMLElement;
        if (['source-input', 'source-supplement'].includes(target.dataset.testid ?? '')) emit('input-change', event);
      }, true);
      document.addEventListener('click', event => {
        const target = (event.target as Element).closest('button');
        if (target?.dataset.testid === 'source-confirm') emit('confirm', event);
        if (target?.dataset.testid === 'source-cancel') emit('source-cancel', event);
        if (target?.closest('[data-testid="source-parameter-review"]') && target.textContent === 'Discard proposal') emit('discard', event);
      }, true);
      new MutationObserver(() => {
        const present = document.querySelector('[data-testid="source-parameter-review"]') !== null;
        if (present && !visible) emit('review-shown');
        visible = present;
      }).observe(document, { childList: true, subtree: true });
    }, { keys: [...PARAMETER_KEYS] });
    await context.route('**/api/**', async route => {
      if (new URL(route.request().url()).pathname !== '/api/worldstream/source' || route.request().method() !== 'POST') {
        await route.fulfill({ status: 503, json: { kind: 'rejected', code: 'REVIEW_SESSION_SOURCE_ONLY' } }); return;
      }
      try {
        await drain();
        const body = route.request().postDataJSON() as Record<string, unknown>;
        if (body.text !== text || body.title !== entry.id || body.origin !== 'provided' || body.rights !== 'unreviewed' || body.supplement !== undefined)
          throw new Error('FROZEN_SOURCE_REQUEST_MISMATCH');
        recorder.beginRequest(body, route.request().postData() ?? '');
        if (control.signal.aborted) throw new Error('SESSION_CANCELLED');
        const response = await handleSourceRequest(new Request(route.request().url(), { method: 'POST',
          headers: { 'Content-Type': 'application/json' }, body: route.request().postData(), signal: control.signal }),
        (source, revision, _deps, supplement) => runSourceProposal(source, revision, { grammar, emit: async request => {
          if (request.model !== experiment.config.model) throw new Error('FROZEN_MODEL_MISMATCH');
          if (options.transport.mode === 'manual-live') {
            // Manual review sessions can remain open for minutes. Recheck the
            // actual caller-owned dispatcher immediately before a provider call.
            await checkTransport();
          }
          const finish = recorder.providerStarted(request);
          try {
            if (options.transport.mode === 'fixture-smoke') {
              const output = await options.transport.fixture(request); finish({ output }); return output;
            }
            const result = await options.transport.emit(request, control.signal);
            finish(result); return result.output;
          } catch (error) { finish({ error: 'PROVIDER_FAILED' }); throw error; }
        } }, supplement), options.transport.mode === 'fixture-smoke' ? 'fixture' : 'live');
        const raw = await response.text();
        const result = JSON.parse(raw);
        const hash = result.kind === 'proposed'
          ? await parameterProposalHash(result.sim, [result.source, ...(result.supplements ?? [])], result.evidence) : null;
        recorder.proposal(result, hash, Buffer.byteLength(raw, 'utf8'), { status: response.status, raw,
          serverTiming: response.headers.get('server-timing') });
        await route.fulfill({ status: response.status, body: raw, contentType: 'application/json',
          headers: { 'Cache-Control': 'no-store', ...(response.headers.get('server-timing') ? { 'Server-Timing': response.headers.get('server-timing')! } : {}) } });
      } catch (error) {
        const code = error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : 'SOURCE_BRIDGE_FAILED';
        recorder.fail(code);
        await route.fulfill({ status: 503, json: { kind: 'rejected', code } }).catch(() => undefined);
      }
    });
    await page.goto(options.baseURL);
    await page.getByText('Build from a source', { exact: true }).click();
    await page.getByLabel('Source title', { exact: true }).fill(entry.id);
    await page.getByTestId('source-input').fill(text);
    await page.evaluate(({ mode, ruleId, durationTicks, forkTick, observationTick }) => {
      const banner = document.createElement('aside');
      banner.textContent = `${mode === 'manual-live' ? 'DEVELOPMENT: manually submit, review all parameters, and confirm' : 'SCRIPTED FIXTURE: 0 inference / 0 human observations'} · ` +
        `Then execute the frozen input log and compare ${ruleId} at ${durationTicks} ticks, fork ${forkTick}, observation ${observationTick}. No semantic certification.`;
      banner.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:10000;padding:10px;background:#102b30;color:white;font:14px sans-serif;pointer-events:none';
      document.body.append(banner);
    }, { mode: options.transport.mode, ...expectedIntervention });
    // Fixture-only integration/test exposure; the runner itself has no
    // UI-confirmation action and no fixture-to-human conversion path.
    if (options.transport.mode === 'fixture-smoke' && options.onFixturePage)
      await untilAborted(Promise.resolve(options.onFixturePage(page)), control.signal);
    while (!recorder.terminal && !page.isClosed()) {
      if (control.signal.aborted) { cancel(); break; }
      const sample = await drain();
      const displayed = sample?.pipeline?.runs.at(-1)?.stages.some(stage => stage.name === 'first-frame' && stage.outcome === 'completed');
      if (sample?.observation?.project.comparison && displayed) recorder.complete(expectedInputs, expectedIntervention);
      if (performance.now() - started >= timeoutMs) { recorder.fail('HUMAN_SESSION_TIMEOUT', 'interrupted'); control.abort(); break; }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  } catch (error) {
    recorder.fail(error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : 'REVIEW_SESSION_FAILED');
  } finally {
    if (deadline) clearTimeout(deadline);
    options.signal?.removeEventListener('abort', cancel);
    control.abort();
    const cleanup = new AbortController();
    const cleanupDeadline = setTimeout(() => cleanup.abort(), 3000);
    try {
      await untilAborted(drain(), cleanup.signal).catch(() => undefined);
      if (context) await untilAborted(Promise.resolve().then(() => context!.close()), cleanup.signal).catch(() => {
        // Keep the original outcome/reason. A crashed browser cannot suppress
        // the terminal attempt artifact or falsely claim successful cleanup.
        options.sink.append({ event: 'context-close-failed-or-timed-out',
          atMs: performance.now() - started, processTerminationVerified: false });
        recorder.fail('CONTEXT_CLOSE_FAILED', 'interrupted');
      });
    } finally { clearTimeout(cleanupDeadline); }
  }
  return recorder.finish();
}

/** An interrupted caller can stop waiting without claiming to terminate a
 * provider/dispatcher operation that ignores AbortSignal. */
function untilAborted<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(new Error('SESSION_CANCELLED')); };
    // The operation has already started. Always observe its eventual rejection,
    // even if it synchronously caused cancellation before returning its promise.
    operation.then(value => { signal.removeEventListener('abort', abort); resolve(value); }, error => {
      signal.removeEventListener('abort', abort); reject(error);
    });
    if (signal.aborted) { abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
  });
}
