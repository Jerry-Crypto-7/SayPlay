import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type APIRequestContext, type Browser, type BrowserContextOptions, type Page } from '@playwright/test';

import { browserRenderer } from '../scripts/browser-renderer';

/**
 * Měření feedu na `/play` (P54A T1). Tag `@measure` ho drží mimo běžné
 * `npm run test:e2e`; pouští se ručně proti běžícímu `next start`:
 *
 *   FALLBACK_SMOKE_URL=http://127.0.0.1:3291 npx playwright test e2e/play-feed-perf.spec.ts --project=chromium --grep @measure
 *
 * Šest her z fixtur se publikuje skutečnými dveřmi, řádky feedu dodá
 * `page.route` (do skutečného feedu jde jen verze od režiséra, jako
 * v `play-feed.spec.ts`). Na desktopu 1440×900 a na Pixel 7 s CPU ×4 (CDP)
 * projde 20 přechodů tlačítkem „next“/„previous“, 3 běhy, každý v čerstvém kontextu.
 *
 * Přechod se měří ve stránce, ne v Node (od T8 bez ťuku – aktivní karta hraje
 * náhled robota sama): `t0` = klik, `shownMs` = karta nové hry v `preview`,
 * `swapToPreviewMs` = první snímek, ve kterém se tik náhledu posunul a kreslilo
 * se (baseline T1 měřila klik → plakát → ťuk → první `draw*` nového kontextu).
 * Kontexty a kreslení počítá init skript obalem `getContext` a `draw*`, long
 * tasks `PerformanceObserver`.
 *
 * Test nic netvrdí, jen zapisuje čísla; spadne jen na chybě stránky.
 */

// Vlastní `launchOptions` přepíše ty z konfigurace – bez `browserRenderer()` by plátno kreslil SwiftShader (~3 FPS).
test.use({ launchOptions: { args: [...browserRenderer().args, '--js-flags=--expose-gc', '--enable-precise-memory-info'] } });

const FIXTURES = [
  ['runner.json', 'Feed runner through the canyon'],
  ['platform.json', 'Feed platform over the rooftops'],
  ['flap.json', 'Feed flap between the pipes'],
  ['rhythm.json', 'Feed rhythm on four lanes'],
  ['arena.json', 'Feed arena with hungry fish'],
  ['shooter.json', 'Feed shooter in the asteroid belt'],
] as const;

const PROFILES: readonly { id: string; options: BrowserContextOptions; cpu: number }[] = [
  { id: 'desktop', options: { viewport: { width: 1440, height: 900 } }, cpu: 1 },
  {
    id: 'pixel7-cpu4',
    options: {
      viewport: { width: 412, height: 915 },
      deviceScaleFactor: 2.625,
      isMobile: true,
      hasTouch: true,
      userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Mobile Safari/537.36',
    },
    cpu: 4,
  },
];

/** Dvakrát tam a zpět přes šest her: 20 přechodů (T8 měří heap po dvaceti). */
const MOVES = [1, 1, 1, 1, 1, -1, -1, -1, -1, -1, 1, 1, 1, 1, 1, -1, -1, -1, -1, -1] as const;
const REPEATS = Number(process.env.PERF_REPEATS ?? 3);
const FPS_MS = 2_000;
const LONG_TASK_WINDOW_MS = 500;
const step = (what: string) => console.log(`[feed-perf ${new Date().toISOString().slice(11, 19)}] ${what}`);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface Row {
  readonly versionId: string;
  readonly title: string;
  readonly archetype: string;
  readonly createdAt: string;
  readonly parentId: null;
  readonly remixes: number;
}

interface FeedProbe {
  contexts: { createdAt: number; firstDrawAt: number | null }[];
  getContextCalls: number;
  /** Poslední volání `draw*` na kterémkoli kontextu. */
  lastDrawAt: number;
  longTasks: { start: number; duration: number }[];
  fps(ms: number): Promise<{ fpsP50: number | null; fpsP5: number | null; drawnFps: number }>;
}

declare global {
  interface Window {
    __feedProbe?: FeedProbe;
  }
}

/** Běží v prohlížeči před kódem stránky. Musí být soběstačný – serializuje se jako text. */
function installFeedProbe(): void {
  const seen = new WeakMap<object, { createdAt: number; firstDrawAt: number | null }>();
  let drawsThisFrame = 0;
  const probe = {
    contexts: [] as { createdAt: number; firstDrawAt: number | null }[],
    getContextCalls: 0,
    lastDrawAt: 0,
    longTasks: [] as { start: number; duration: number }[],
    fps(ms: number) {
      return new Promise<{ fpsP50: number | null; fpsP5: number | null; drawnFps: number }>((resolve) => {
        const intervals: number[] = [];
        let drawn = 0;
        let last = 0;
        const started = performance.now();
        const quantile = (q: number) => {
          if (intervals.length === 0) return null;
          const sorted = [...intervals].sort((a, b) => a - b);
          return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
        };
        drawsThisFrame = 0;
        const tick = (now: number) => {
          if (last > 0) intervals.push(now - last);
          if (drawsThisFrame > 0) drawn += 1;
          drawsThisFrame = 0;
          last = now;
          if (now - started < ms) {
            requestAnimationFrame(tick);
            return;
          }
          const p50 = quantile(0.5);
          const p95 = quantile(0.95);
          resolve({ fpsP50: p50 === null ? null : 1000 / p50, fpsP5: p95 === null ? null : 1000 / p95, drawnFps: (drawn * 1000) / (now - started) });
        };
        requestAnimationFrame(tick);
      });
    },
  };
  const getContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, kind: string, ...rest: unknown[]) {
    const context = (getContext as (...args: unknown[]) => unknown).call(this, kind, ...rest);
    if ((kind === 'webgl2' || kind === 'webgl') && context !== null && typeof context === 'object') {
      probe.getContextCalls += 1;
      if (!seen.has(context)) {
        const entry = { createdAt: performance.now(), firstDrawAt: null as number | null };
        seen.set(context, entry);
        probe.contexts.push(entry);
      }
    }
    return context;
  } as typeof HTMLCanvasElement.prototype.getContext;
  for (const proto of [WebGL2RenderingContext.prototype, WebGLRenderingContext.prototype] as unknown as Record<string, (...args: unknown[]) => unknown>[]) {
    for (const name of ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced', 'drawRangeElements']) {
      const original = proto[name];
      if (typeof original !== 'function') continue;
      proto[name] = function (this: object, ...args: unknown[]) {
        drawsThisFrame += 1;
        probe.lastDrawAt = performance.now();
        const entry = seen.get(this);
        if (entry !== undefined && entry.firstDrawAt === null) entry.firstDrawAt = performance.now();
        return original.apply(this, args);
      };
    }
  }
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) probe.longTasks.push({ start: entry.startTime, duration: entry.duration });
    }).observe({ type: 'longtask', buffered: true });
  } catch {
    // Prohlížeč bez long tasks: pole zůstane prázdné a report to přizná nulou.
  }
  window.__feedProbe = probe;
}

async function publish(request: APIRequestContext): Promise<Row[]> {
  const rows: Row[] = [];
  for (const [index, [fixture, title]] of FIXTURES.entries()) {
    const base = JSON.parse(readFileSync(join(process.cwd(), 'src/play/arcade/__fixtures__', fixture), 'utf8')) as Record<string, unknown>;
    const response = await request.post('/api/play/games', { data: { spec: { ...base, title } } });
    expect(response.status(), await response.text()).toBeLessThan(300);
    const body = (await response.json()) as { versionId: string; archetype: string };
    rows.push({ versionId: body.versionId, title, archetype: body.archetype, createdAt: new Date(Date.now() - index * 1000).toISOString(), parentId: null, remixes: 0 });
  }
  return rows;
}

const heap = (page: Page): Promise<number> =>
  page.evaluate(() => {
    (window as unknown as { gc?: () => void }).gc?.();
    return (performance as unknown as { memory: { usedJSHeapSize: number } }).memory.usedJSHeapSize;
  });

/**
 * První snímek běžícího náhledu cílové hry (T8): `__playFeed()` ukazuje cílovou
 * hru v `preview` (`shownAt`), pak snímek, ve kterém se tik posunul a kreslilo
 * se – jeho `lastDrawAt`. Sleduje se po snímcích ve stránce, ne dotazy z Node.
 */
async function waitPreview(page: Page, row: Row): Promise<{ shownAt: number; firstFrameAt: number }> {
  return page.evaluate(
    (versionId) =>
      new Promise<{ shownAt: number; firstFrameAt: number }>((resolve, reject) => {
        const started = performance.now();
        let shown: { at: number; tick: number } | null = null;
        const frame = () => {
          const now = window.__playFeed?.();
          if (shown === null && now?.versionId === versionId && now.mode === 'preview' && document.querySelector('[data-testid="feed-current"] .play-shell') !== null) {
            shown = { at: performance.now(), tick: now.tick };
          }
          const drawn = window.__feedProbe!.lastDrawAt;
          if (shown !== null && now !== undefined && now.tick > shown.tick && drawn > shown.at) {
            resolve({ shownAt: shown.at, firstFrameAt: drawn });
            return;
          }
          if (performance.now() - started > 60_000) reject(new Error(`no running preview of ${versionId}`));
          else requestAnimationFrame(frame);
        };
        requestAnimationFrame(frame);
      }),
    row.versionId,
  );
}

async function measureOnce(browser: Browser, rows: readonly Row[], profile: (typeof PROFILES)[number]) {
  const context = await browser.newContext(profile.options);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(installFeedProbe);
  await page.route('**/api/play/games?recent=*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ games: rows, next: null }) }));
  const cdp = await context.newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: profile.cpu });
  try {
    await page.goto('/play');
    // Feed stojí pod polem pro větu; hra hraje, jen když je feed aspoň z poloviny vidět (`onScreen`).
    await page.getByTestId('feed-current').waitFor({ timeout: 60_000 });
    await page.evaluate(() => document.querySelector('[data-testid="feed-current"]')?.scrollIntoView({ block: 'start' }));
    await waitPreview(page, rows[0]);
    await sleep(1_000);
    const heapBefore = await heap(page);
    const transitions: unknown[] = [];
    let at = 0;
    for (const move of MOVES) {
      at += move;
      const row = rows[at];
      const t0 = await page.evaluate((testId) => {
        const at0 = performance.now();
        (document.querySelector(`[data-testid="${testId}"]`) as HTMLButtonElement).click();
        return at0;
      }, move > 0 ? 'feed-next' : 'feed-prev');
      const { shownAt, firstFrameAt } = await waitPreview(page, row);
      // FPS běžícího náhledu robota – scéna i logika jako při hraní, bez ťuku.
      const fps = await page.evaluate((ms) => window.__feedProbe!.fps(ms), FPS_MS);
      const longTasks = await page.evaluate(({ from, span }) => window.__feedProbe!.longTasks.filter((t) => t.duration > 50 && t.start >= from && t.start < from + span), {
        from: t0,
        span: LONG_TASK_WINDOW_MS,
      });
      transitions.push({
        to: row.title,
        shownMs: shownAt - t0,
        swapToPreviewMs: firstFrameAt - t0,
        longTasksAfterSwap: longTasks.length,
        longestTaskAfterSwapMs: Math.max(0, ...longTasks.map((t) => t.duration)),
        ...fps,
      });
    }
    const heapAfter = await heap(page);
    const counts = await page.evaluate(() => ({
      getContextCalls: window.__feedProbe!.getContextCalls,
      contextsCreated: window.__feedProbe!.contexts.length,
      canvasesInDom: document.querySelectorAll('canvas').length,
      feedContexts: window.__playFeed?.().contexts ?? null,
      snapshotsInDom: document.querySelectorAll('[data-testid="feed-shot"]').length,
    }));
    return { transitions, heapBefore, heapAfter, ...counts, errors };
  } finally {
    await context.close();
  }
}

type Run = Awaited<ReturnType<typeof measureOnce>>;
type Transition = Record<string, number | string | null>;

const stats = (values: readonly (number | null)[]) => {
  const numbers = values.filter((v): v is number => typeof v === 'number').sort((a, b) => a - b);
  if (numbers.length === 0) return null;
  const mid = Math.floor(numbers.length / 2);
  const median = numbers.length % 2 === 1 ? numbers[mid] : (numbers[mid - 1] + numbers[mid]) / 2;
  return { median: Math.round(median * 10) / 10, min: Math.round(numbers[0] * 10) / 10, max: Math.round(numbers[numbers.length - 1] * 10) / 10 };
};

function summarise(runs: readonly Run[]) {
  const all = runs.flatMap((run) => run.transitions as Transition[]);
  const pick = (key: string) => stats(all.map((t) => t[key] as number | null));
  return {
    transitions: all.length,
    shownMs: pick('shownMs'),
    swapToPreviewMs: pick('swapToPreviewMs'),
    longTasksAfterSwap: pick('longTasksAfterSwap'),
    longestTaskAfterSwapMs: pick('longestTaskAfterSwapMs'),
    transitionsWithLongTask: all.filter((t) => (t.longTasksAfterSwap as number) > 0).length,
    fpsP50: pick('fpsP50'),
    fpsP5: pick('fpsP5'),
    drawnFps: pick('drawnFps'),
    getContextCalls: stats(runs.map((r) => r.getContextCalls)),
    contextsCreated: stats(runs.map((r) => r.contextsCreated)),
    heapBeforeMb: stats(runs.map((r) => r.heapBefore / 2 ** 20)),
    heapAfterMb: stats(runs.map((r) => r.heapAfter / 2 ** 20)),
    heapGrowthMb: stats(runs.map((r) => (r.heapAfter - r.heapBefore) / 2 ** 20)),
  };
}

test('@measure feed: swap to first frame, long tasks, FPS and WebGL contexts × desktop and Pixel 7 CPU×4', async ({ browser, request }) => {
  test.setTimeout(60 * 60_000);
  const day = new Date().toISOString().slice(0, 10);
  const out = process.env.PERF_OUT ?? join('evals', 'play', 'feed', `baseline-${day}.json`);
  mkdirSync(join(out, '..'), { recursive: true });
  const rows = await publish(request);
  const report: Record<string, unknown> = {
    version: 'p54a-feed-perf-v2',
    measuredAt: new Date().toISOString(),
    browser: browser.version(),
    note:
      'Phone profile is emulation: Pixel 7 viewport with touch, CPU throttled ×4 via CDP on this machine\'s GPU. Per transition: click on next (the active card switches at once, the glide follows) → the new game\'s card in preview mode (shownMs) → first frame where the preview tick advanced and something was drawn (swapToPreviewMs). FPS = 2 s of the running bot preview. Summary = median/min/max over all transitions of all runs.',
    repeats: REPEATS,
    moves: MOVES,
    games: rows.map((row) => row.title),
    results: {} as Record<string, unknown>,
  };
  const results = report.results as Record<string, unknown>;
  const save = () => writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  const only = (list: string | undefined, id: string) => list === undefined || list.split(',').includes(id);
  for (const profile of PROFILES.filter((p) => only(process.env.PERF_PROFILES, p.id))) {
    const runs: Run[] = [];
    for (let i = 0; i < REPEATS; i += 1) {
      step(`${profile.id} run ${String(i + 1)}/${String(REPEATS)}`);
      runs.push(await measureOnce(browser, rows, profile));
      results[profile.id] = { profile: profile.id, cpuThrottle: profile.cpu, summary: summarise(runs), runs };
      save();
    }
    for (const run of runs) expect.soft(run.errors).toEqual([]);
  }
});
