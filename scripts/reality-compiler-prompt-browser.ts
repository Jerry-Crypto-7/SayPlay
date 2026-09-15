import type { Browser, Page } from '@playwright/test';
import { createPreparedPromptRecorder, type PromptEndpoint } from './reality-compiler-prompt-recorder';
import type { ReviewArtifactSink } from './reality-compiler-review-runner';

/** Caller must run a local production server with upstream disabled. The browser
 * additionally blocks act II and every API outside this one prepared session. */
export async function runPreparedPromptSession(options: {
  browser: Browser; baseURL: string; prompt: string; endpoint: PromptEndpoint;
  sink: ReviewArtifactSink; build: unknown; timeoutMs?: number; signal?: AbortSignal;
  /** Explicit scripted smoke driver. It never earns human review credit. */
  driver?: (page: Page) => Promise<void>;
}) {
  const recorder = createPreparedPromptRecorder(options);
  const control = new AbortController();
  let context: Awaited<ReturnType<Browser['newContext']>> | null = null;
  let page: Page | null = null;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const cancel = () => { recorder.fail('SESSION_CANCELLED', 'cancelled'); control.abort(); };
  options.signal?.addEventListener('abort', cancel, { once: true });
  const pending = new Set<Promise<unknown>>();
  const watch = (operation: Promise<unknown>) => {
    pending.add(operation);
    void operation.catch(() => recorder.fail('HTTP_OBSERVATION_FAILED')).finally(() => pending.delete(operation));
  };
  try {
    const timeoutMs = options.timeoutMs ?? 60000;
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) throw new Error('INVALID_TIMEOUT');
    deadline = setTimeout(() => { recorder.fail('SESSION_TIMEOUT', 'interrupted'); control.abort(); }, timeoutMs);
    if (options.signal?.aborted) { cancel(); throw new Error('SESSION_CANCELLED'); }
    const base = new URL(options.baseURL);
    if (base.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(base.hostname) || base.username || base.password || base.pathname !== '/')
      throw new Error('LOCAL_PRODUCTION_SERVER_REQUIRED');
    const creating = options.browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });
    void creating.then(created => { if (control.signal.aborted) void created.close().catch(() => undefined); }, () => undefined);
    context = await untilAborted(creating, control.signal);
    page = await untilAborted(context.newPage(), control.signal); page.setDefaultTimeout(Math.min(timeoutMs, 30000));
    page.once('close', () => { recorder.fail('BROWSER_CLOSED', 'interrupted'); control.abort(); });
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin !== base.origin) { recorder.http({ event: 'external-request-blocked', origin: url.origin }); await route.abort(); return; }
      if (!url.pathname.startsWith('/api/')) { await route.continue(); return; }
      let body: unknown = null;
      try { body = request.postData() ? request.postDataJSON() : null; } catch { /* policy rejects malformed input */ }
      if (!recorder.allow(request.method(), url.pathname, body)) {
        await route.fulfill({ status: 503, json: { error: { code: 'PREPARED_MEASUREMENT_ONLY' } } }); return;
      }
      if (request.method() === 'POST') {
        try {
          recorder.http({ event: 'raw-session-request', method: request.method(), path: url.pathname,
            raw: request.postData(), bytes: Buffer.byteLength(request.postData() ?? '', 'utf8') });
          const response = await route.fetch({ maxRedirects: 0, timeout: Math.min(timeoutMs, 30000) });
          const raw = await response.text();
          if (Buffer.byteLength(raw) > 1024 * 1024) throw new Error('HTTP_RESPONSE_LIMIT');
          const headers = response.headers();
          recorder.accepted(response.status(), raw, { serverTiming: headers['server-timing'] ?? null,
            requestId: headers['x-worldstream-request-id'] ?? null });
          await route.fulfill({ response, body: raw });
        } catch { recorder.fail('SESSION_HTTP_FAILED'); await route.abort().catch(() => undefined); }
      } else await route.continue();
    });
    page.on('response', response => {
      const url = new URL(response.url());
      if (url.origin !== base.origin || !url.pathname.startsWith('/api/')) return;
      watch((async () => {
        const headers = await response.allHeaders();
        recorder.http({ path: url.pathname, search: url.search, method: response.request().method(), status: response.status(),
          contentType: headers['content-type'] ?? null, serverTiming: headers['server-timing'] ?? null,
          requestId: headers['x-worldstream-request-id'] ?? null, bodyArchived: false });
      })());
    });
    await untilAborted(page.goto(options.baseURL), control.signal);
    recorder.artifact('device.json', await untilAborted(page.evaluate(() => {
      const gl = document.createElement('canvas').getContext('webgl2');
      const debug = gl?.getExtension('WEBGL_debug_renderer_info');
      const renderer = gl && debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) as string : null;
      gl?.getExtension('WEBGL_lose_context')?.loseContext();
      return { userAgent: navigator.userAgent, logicalProcessors: navigator.hardwareConcurrency,
        viewport: { width: innerWidth, height: innerHeight }, dpr: devicePixelRatio, renderer };
    }), control.signal));
    await untilAborted(page.getByTestId('prompt-input').fill(options.prompt), control.signal);
    const activePage = page;
    const driver = options.driver ?? (async (target: Page) => { await target.getByTestId('prompt-submit').click(); });
    // Run the driver concurrently so long scripted interaction cannot suppress
    // periodic evidence capture. The deadline also bounds a stuck driver.
    watch(Promise.resolve().then(() => driver(activePage)).catch(() => recorder.fail('SCRIPTED_DRIVER_FAILED')));
    while (!recorder.terminal && !control.signal.aborted) {
      const sample = await untilAborted(page.evaluate(() => {
        const stage = window.__worldstreamStage, observation = window.__realityCompiler?.snapshot();
        return { pipeline: window.__worldstreamMetrics?.snapshot() ?? null,
          renderer: stage ? { ready: stage.ready(), frames: stage.frames(), drawCalls: stage.quality()?.drawCalls ?? 0,
            triangles: stage.slots().reduce((sum, slot) => sum + (slot.attached ? slot.triangles : 0), 0) } : null,
          authoredNotice: document.querySelector('[data-testid="world-authored"]')?.textContent ?? null,
          runtimeEvidence: { inputResult: document.querySelector('[data-testid="runtime-input-result"]')?.textContent ?? null,
            ruleTrace: document.querySelector('[data-testid="runtime-rule-trace"]')?.textContent ?? null,
            tick: document.querySelector('[data-testid="runtime-tick"]')?.getAttribute('data-tick') ?? null },
          runtime: observation ? { tick: observation.runtime.tick, inputs: observation.inputs.length } : null };
      }), control.signal);
      recorder.observe(sample);
      if (!recorder.terminal) await untilAborted(new Promise(resolve => setTimeout(resolve, 100)), control.signal);
    }
  } catch (error) {
    recorder.fail(error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : 'PROMPT_SESSION_FAILED');
  } finally {
    if (deadline) clearTimeout(deadline);
    options.signal?.removeEventListener('abort', cancel);
    control.abort();
    const cleanup = new AbortController(), cleanupDeadline = setTimeout(() => cleanup.abort(), 3000);
    try {
      if (context) await untilAborted(context.close(), cleanup.signal).catch(() => {
        recorder.http({ event: 'context-close-failed-or-timed-out', terminationVerified: false });
      });
      await untilAborted(Promise.allSettled([...pending]), cleanup.signal).catch(() => {
        recorder.http({ event: 'pending-observers-or-driver', completionUnknown: true });
      });
    } finally { clearTimeout(cleanupDeadline); }
  }
  return recorder.finish();
}

function untilAborted<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(new Error('SESSION_INTERRUPTED')); };
    operation.then(value => { signal.removeEventListener('abort', abort); resolve(value); }, error => {
      signal.removeEventListener('abort', abort); reject(error);
    });
    if (signal.aborted) { abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
  });
}
