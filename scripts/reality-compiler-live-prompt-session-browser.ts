/** Explicit blueprint materialization through actual product POST/GET/SSE and
 * renderer/runtime. It never runs intent/compiler/repair or provider requests. */
import { createHash, randomUUID } from 'node:crypto';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import { z } from 'zod';
import { blueprintSchema } from '../src/worldstream/schema';
import { findBlueprintReferenceIssues } from '../src/worldstream/references';
import { buildRuntimeWorld } from '../src/ir/build';
import { sampleLivePromptPage, type LivePromptProductBridge } from './reality-compiler-live-prompt-session';

export const materializationInputSchema = z.strictObject({ version: z.literal('materialization-ui-input-v1'),
  actions: z.array(z.strictObject({ actionLabel: z.string().min(1).max(200),
    expectedApplied: z.string().min(1).max(200) })).min(1).max(10) });

export function validateMaterializationRaw(raw: string) {
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > 8 * 1024 * 1024) throw new Error('MATERIALIZATION_RAW_LIMIT');
  let value: unknown; try { value = JSON.parse(raw); } catch { throw new Error('MATERIALIZATION_INVALID_JSON'); }
  const parsed = blueprintSchema.safeParse(value);
  if (!parsed.success) throw new Error('MATERIALIZATION_INVALID_BLUEPRINT');
  if (findBlueprintReferenceIssues(parsed.data).length) throw new Error('MATERIALIZATION_INVALID_REFERENCES');
  if (!buildRuntimeWorld(parsed.data.world.sim).ok) throw new Error('MATERIALIZATION_UNSUPPORTED_RUNTIME');
  return parsed.data;
}

function aborted<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(new Error('MATERIALIZATION_CANCELLED')); };
    operation.then(value => { signal.removeEventListener('abort', abort); resolve(value); },
      error => { signal.removeEventListener('abort', abort); reject(error); });
    if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
  });
}

/** Fresh local context per call, no access to the real session API. All model
 * routes and external requests are blocked. `record` must bound/archive evidence
 * in the caller's attempt sink; no credentials, cookies or headers are recorded. */
export function createPromptMaterializationBridge(options: {
  browser: Browser; baseURL: string; prompt: string; origin: 'provider' | 'fixture';
  record(event: unknown): void;
}): LivePromptProductBridge {
  options = { ...options };
  const base = new URL(options.baseURL);
  if (base.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname) ||
    base.username || base.password || base.pathname !== '/' || base.search || base.hash) throw new Error('LOCAL_PRODUCTION_SERVER_REQUIRED');
  if (!['provider', 'fixture'].includes(options.origin) || !options.prompt.trim() || options.prompt.length > 2000)
    throw new Error('INVALID_MATERIALIZATION_CONFIG');
  return { async open(request, signal) {
    if (request.prompt !== options.prompt) throw new Error('MATERIALIZATION_PROMPT_MISMATCH');
    const raw = request.raw, rawSha256 = createHash('sha256').update(raw).digest('hex');
    if (rawSha256 !== request.rawSha256) throw new Error('MATERIALIZATION_RAW_HASH_MISMATCH');
    const blueprint = validateMaterializationRaw(raw);
    if (signal.aborted) throw new Error('MATERIALIZATION_CANCELLED');
    const sessionId = randomUUID(), path = `/api/worldstream/sessions/${sessionId}`;
    let context: BrowserContext | null = null, page: Page | null = null, submitted = false, eventsRead = false, requests = 0;
    let policyFault: string | null = null, closed = false, closing: Promise<void> | null = null;
    const record = (event: unknown) => options.record({ materializationOrigin: options.origin, sessionId, event });
    const close = (): Promise<void> => {
      if (closing) return closing;
      closing = Promise.resolve().then(async () => {
        if (context) await context.close();
        closed = true; record({ kind: 'context-closed', verified: true });
      });
      return closing;
    };
    try {
      const creating = options.browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });
      void creating.then(value => { if (signal.aborted && !context) void value.close().catch(() => undefined); }, () => undefined);
      context = await aborted(creating, signal);
      page = await aborted(context.newPage(), signal); page.setDefaultTimeout(15000);
      const notice = options.origin === 'fixture'
        ? 'SCRIPTED FIXTURE — blueprint materialization only. Zero model calls. No live or human measurement.'
        : 'PROVIDER BLUEPRINT — materialization only. Intent/compiler/repair generation chain is not measured. No human review.';
      await page.addInitScript(({ notice, origin }) => {
        const install = () => {
          if (!document.body || document.getElementById('materialization-disclosure')) return;
          const label = document.createElement('p'); label.id = 'materialization-disclosure';
          label.dataset.testid = 'materialization-disclosure'; label.dataset.origin = origin; label.textContent = notice;
          label.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:2147483647;background:#201a10;color:#fff;padding:8px;margin:0;font:14px sans-serif;pointer-events:none';
          document.body.append(label);
        };
        new MutationObserver(install).observe(document, { childList: true, subtree: true });
        document.addEventListener('DOMContentLoaded', install);
      }, { notice, origin: options.origin });
      await context.route('**/*', async route => {
        const incoming = route.request(), url = new URL(incoming.url());
        if (url.origin !== base.origin) { record({ kind: 'external-blocked', origin: url.origin }); await route.abort(); return; }
        if (!url.pathname.startsWith('/api/')) { await route.continue(); return; }
        if (++requests > 16) { policyFault = 'MATERIALIZATION_REQUEST_LIMIT'; await route.abort(); return; }
        const method = incoming.method();
        record({ kind: 'http-request', method, path: url.pathname, search: url.search,
          raw: incoming.postData(), bytes: Buffer.byteLength(incoming.postData() ?? '') });
        let body: unknown = null; try { body = incoming.postDataJSON(); } catch { /* GET has no body */ }
        if (!submitted && method === 'POST' && url.pathname === '/api/worldstream/sessions' && !url.search &&
          body && typeof body === 'object' && Object.keys(body).length === 1 && (body as { prompt?: unknown }).prompt === options.prompt) {
          submitted = true;
          const response = { sessionId, events: `${path}/events`, snapshot: path };
          record({ kind: 'http-response', status: 202, response, rawSha256 });
          await route.fulfill({ status: 202, json: response }); return;
        }
        if (submitted && method === 'GET' && url.pathname === path && !url.search) {
          record({ kind: 'http-response', status: 200, blueprintRawSha256: rawSha256 });
          await route.fulfill({ status: 200, json: { sessionId, phase: 'complete', sequence: 2, representations: [], blueprint } }); return;
        }
        if (submitted && !eventsRead && method === 'GET' && url.pathname === `${path}/events` &&
          (url.search === '' || url.search === '?since=0')) {
          eventsRead = true;
          const frame = (sequence: number, type: string, payload: unknown) => `data: ${JSON.stringify({ sessionId, sequence,
            type, at: '1970-01-01T00:00:00.000Z', payload })}\n\n`;
          const sse = frame(1, 'blueprint.ready', { blueprint }) + frame(2, 'session.complete', {});
          record({ kind: 'sse-response', bytes: Buffer.byteLength(sse), sha256: createHash('sha256').update(sse).digest('hex'),
            raw: sse, scriptedEnvelope: true });
          await route.fulfill({ status: 200, contentType: 'text/event-stream', body: sse }); return;
        }
        policyFault = 'UNMEASURED_REQUEST_BLOCKED'; record({ kind: 'api-blocked', method, path: url.pathname });
        await route.fulfill({ status: 503, json: { error: { code: policyFault } } });
      });
      record({ kind: 'materialization-open', slot: structuredClone(request.slot), build: structuredClone(request.build), rawSha256,
        scope: 'full blueprint materialization; no intent/compiler/repair chain', modelCalls: 0, scriptedEnvelope: true });
      await aborted(page.goto(base.href), signal);
      const device = await aborted(page.evaluate(() => {
        const gl = document.createElement('canvas').getContext('webgl2'), debug = gl?.getExtension('WEBGL_debug_renderer_info');
        const renderer = gl && debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) as string : null;
        gl?.getExtension('WEBGL_lose_context')?.loseContext();
        return { userAgent: navigator.userAgent, viewport: { width: innerWidth, height: innerHeight }, dpr: devicePixelRatio, renderer };
      }), signal);
      await aborted(page.getByTestId('prompt-input').fill(options.prompt), signal);
      await aborted(page.getByTestId('prompt-submit').click(), signal);
      await aborted(page.waitForFunction(() => (window.__worldstreamMetrics?.snapshot().runs.length ?? 0) === 1), signal);
      const initial = await aborted(sampleLivePromptPage(page), signal), run = initial.pipeline!.runs[0];
      const active = page;
      return { materializationOrigin: options.origin, sessionId, rawSha256, runId: run.runId, generation: run.generation, device,
        async sample(activeSignal) {
          if (policyFault) throw new Error(policyFault);
          if (closed || active.isClosed()) throw new Error('BROWSER_CLOSED');
          const disclosure = await aborted(active.getByTestId('materialization-disclosure').textContent(), activeSignal);
          if (disclosure !== notice) throw new Error('MATERIALIZATION_DISCLOSURE_MISSING');
          return aborted(sampleLivePromptPage(active), activeSignal);
        },
        async interact(inputLog, activeSignal) {
          if (inputLog.byteLength > 16384) throw new Error('MATERIALIZATION_INPUT_LIMIT');
          const input = materializationInputSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(inputLog)));
          for (const action of input.actions) {
            if (activeSignal.aborted) throw new Error('MATERIALIZATION_CANCELLED');
            await aborted(active.getByTestId('runtime-action').selectOption({ label: action.actionLabel }), activeSignal);
            await aborted(active.getByTestId('runtime-act').click(), activeSignal);
            await aborted(active.waitForFunction(expected => document.querySelector('[data-testid="runtime-input-result"]')?.textContent?.includes(expected), action.expectedApplied), activeSignal);
            record({ kind: 'scripted-ui-action', action });
          }
        }, close };
    } catch (error) {
      // Caller deadline also bounds this cleanup; late completion is retained by
      // its sink and cannot convert a failed observation into success.
      try { record({ kind: 'materialization-open-failed', error: error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : 'OPEN_FAILED' }); }
      catch { /* A failing archive must never prevent resource cleanup. */ }
      try { await close(); } catch { /* Preserve original failure; never claim a successful binding. */ }
      throw error;
    }
  } };
}
