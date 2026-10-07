import { expect, test, type Browser, type BrowserContextOptions, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { startGame } from './play-start';

/**
 * Sonda výkonu hry (P28E T1, audit §7). Tag `@measure` ji drží mimo běžné
 * `npm run test:e2e`; pouští se ručně:
 *
 *   FALLBACK_SMOKE_URL=http://127.0.0.1:3131 npx playwright test e2e/play-perf.spec.ts --project=chromium --grep @measure
 *
 * Tři původní hry a čtyři pohyby P41 × dva profily (desktop 1440×900,
 * emulace Moto G Power: CPU ×4 a síť „Fast 4G“) × 3 opakování, každé
 * v čerstvém kontextu, tedy s prázdnou HTTP cache.
 *
 * **Počítá se na úrovni WebGL, ne v aplikaci.** Init skript obalí `draw*`
 * volání `WebGL2RenderingContext`, takže `calls` a `triangles` za snímek
 * jsou totéž, co by ukázal `renderer.info.render`, jen bez zásahu do kódu hry
 * a stejně pro arkádové i mřížkové plátno. Snímek, ve kterém nepadlo jediné
 * `draw*`, se nekreslil – odtud `drawnFps` vedle `rafFps`: s kreslením na
 * požádání (T2) běží rAF dál, ale snímky se nekreslí.
 *
 * Emulace není telefon: GPU zůstává stroje, na kterém sonda běží, a CPU je
 * jen zpomalené. Report proto nese skutečný řetězec GPU.
 */

const GAMES = [
  { id: 'runner', sentence: 'jumping arcade game with a lot of obstacles', arcade: true },
  { id: 'arena', sentence: 'like agar.io but you are a fish eating smaller fish', arcade: true },
  { id: 'grid-collect', sentence: 'Collect five glowing mushrooms then open a portal.', arcade: false },
  { id: 'drive', sentence: 'game in a car with shooting and racing', arcade: true },
  { id: 'glide', sentence: 'a fish swims through a coral reef', arcade: true },
  { id: 'walker', sentence: 'a cat sneaks past guards to steal a fish', arcade: true },
  { id: 'ball', sentence: 'a penguin plays football against a walrus', arcade: true },
] as const;

/** Předvolba „Fast 4G“ z Chrome DevTools (SDK `NetworkManager`): 9 Mb/s dolů, 1,5 Mb/s nahoru, RTT 60 ms × 2,75. */
const FAST_4G = { offline: false, latency: 165, downloadThroughput: (9_000 * 1000) / 8 * 0.9, uploadThroughput: (1_500 * 1000) / 8 * 0.9 };

const PROFILES: readonly { id: string; options: BrowserContextOptions; cpu: number; network: typeof FAST_4G | null }[] = [
  { id: 'desktop', options: { viewport: { width: 1440, height: 900 } }, cpu: 1, network: null },
  {
    // Předvolba „Moto G Power“ z Chrome DevTools.
    id: 'moto-g-power-emulated',
    options: {
      viewport: { width: 412, height: 823 },
      deviceScaleFactor: 1.75,
      isMobile: true,
      hasTouch: true,
      userAgent: 'Mozilla/5.0 (Linux; Android 11; moto g power (2022)) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Mobile Safari/537.36',
    },
    cpu: 4,
    network: FAST_4G,
  },
];

const REPEATS = Number(process.env.PERF_REPEATS ?? 3);
/** Postup běhu na stdout – měření trvá desítky minut a bez něj nejde poznat, kde stojí. */
const step = (what: string) => console.log(`[perf ${new Date().toISOString().slice(11, 19)}] ${what}`);
const PLAY_MS = 10_000;
const IDLE_MS = 3_000;
/** Měřicí okna odměřuje Node, ne stránka, jejíž hodiny škrcení CPU zpomaluje. */
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface PerfWindow {
  readonly ms: number;
  readonly rafFrames: number;
  readonly drawnFrames: number;
  readonly rafFps: number;
  readonly drawnFps: number;
  /** fps z mediánu a z 95. percentilu délky snímku (p5 fps = 5 % nejhorších snímků). */
  readonly fpsP50: number | null;
  readonly fpsP5: number | null;
  readonly maxFrameMs: number | null;
  readonly callsMedian: number | null;
  readonly callsMax: number | null;
  readonly trianglesMedian: number | null;
  readonly trianglesMax: number | null;
}

declare global {
  interface Window {
    __perf?: {
      firstDrawMs: number | null;
      firstTickMs: number | null;
      begin(): void;
      end(): PerfWindow;
    };
  }
}

/** Běží v prohlížeči před kódem stránky. Musí být soběstačný – serializuje se jako text. */
function installPerfProbe(): void {
  const GL = WebGL2RenderingContext.prototype as unknown as Record<string, (...args: number[]) => void>;
  let calls = 0;
  let triangles = 0;
  const tris = (mode: number, count: number, instances = 1): number =>
    (mode === 4 ? Math.floor(count / 3) : mode === 5 || mode === 6 ? Math.max(0, count - 2) : 0) * instances;
  const wrap = (name: string, count: (args: number[]) => number) => {
    const original = GL[name];
    GL[name] = function (this: unknown, ...args: number[]) {
      calls += 1;
      triangles += count(args);
      if (probe.firstDrawMs === null) probe.firstDrawMs = performance.now();
      return original.apply(this, args);
    };
  };
  wrap('drawArrays', ([mode, , count]) => tris(mode, count));
  wrap('drawElements', ([mode, count]) => tris(mode, count));
  wrap('drawArraysInstanced', ([mode, , count, n]) => tris(mode, count, n));
  wrap('drawElementsInstanced', ([mode, count, , , n]) => tris(mode, count, n));
  wrap('drawRangeElements', ([mode, , , count]) => tris(mode, count));

  let recording = false;
  let started = 0;
  let last = 0;
  let intervals: number[] = [];
  let perFrame: { calls: number; triangles: number }[] = [];
  const quantile = (values: number[], q: number): number | null => {
    if (values.length === 0) return null;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  };
  const tick = (now: number) => {
    // Čísla za předchozí snímek: `draw*` rendereru padla mezi dvěma voláními téhle smyčky.
    if (recording) {
      if (last > 0) intervals.push(now - last);
      perFrame.push({ calls, triangles });
    }
    last = now;
    calls = 0;
    triangles = 0;
    const shell = (window as unknown as { __playShell?: { tick(): number } }).__playShell;
    if (probe.firstTickMs === null && shell !== undefined && shell.tick() > 0) probe.firstTickMs = performance.now();
    requestAnimationFrame(tick);
  };
  const probe = {
    firstDrawMs: null as number | null,
    firstTickMs: null as number | null,
    begin() {
      recording = true;
      started = performance.now();
      last = 0;
      intervals = [];
      perFrame = [];
    },
    end() {
      recording = false;
      const ms = performance.now() - started;
      const drawn = perFrame.filter((frame) => frame.calls > 0);
      const p50 = quantile(intervals, 0.5);
      const p95 = quantile(intervals, 0.95);
      return {
        ms,
        rafFrames: perFrame.length,
        drawnFrames: drawn.length,
        rafFps: (perFrame.length * 1000) / ms,
        drawnFps: (drawn.length * 1000) / ms,
        fpsP50: p50 === null ? null : 1000 / p50,
        fpsP5: p95 === null ? null : 1000 / p95,
        maxFrameMs: intervals.length === 0 ? null : Math.max(...intervals),
        callsMedian: quantile(drawn.map((f) => f.calls), 0.5),
        callsMax: drawn.length === 0 ? null : Math.max(...drawn.map((f) => f.calls)),
        trianglesMedian: quantile(drawn.map((f) => f.triangles), 0.5),
        trianglesMax: drawn.length === 0 ? null : Math.max(...drawn.map((f) => f.triangles)),
      };
    },
  };
  window.__perf = probe;
  requestAnimationFrame(tick);
}

async function measureOnce(browser: Browser, url: string, game: (typeof GAMES)[number], profile: (typeof PROFILES)[number]) {
  const context = await browser.newContext(profile.options);
  const page: Page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(installPerfProbe);
  const cdp = await context.newCDPSession(page);
  if (profile.network !== null) {
    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', profile.network);
  }
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: profile.cpu });
  try {
    step(`${game.id}/${profile.id}: goto`);
    await page.goto(url);
    // Od P33 T11 hra čeká na první dotek: „první tik“ je teď tik po nejrychlejším možném ťuku.
    await startGame(page);
    step('loaded, waiting for first frame and tick');
    await page.waitForFunction(() => window.__perf?.firstTickMs !== null && window.__perf?.firstDrawMs !== null, undefined, { timeout: 120_000 });

    // Hraje robot: arkáda přes „Show me how“ (ukázka v reálném čase), mřížka běží sama.
    // Klik přes DOM, ne `locator.click()`: běžec bez vstupu na škrceném CPU prohraje dřív,
    // než je tlačítko „stabilní“, a Playwright pak na zmizelé tlačítko čeká do konce testu.
    // Pauza (skrytá záložka) se měří před hraním: ukázka arény doběhne do konce dřív než
    // okno hraní a pauza se ukazuje jen za běhu. Umí ji jen arkáda. rAF běží dál, protože
    // záložka skrytá doopravdy není – měří se, jestli se kreslí.
    let robot = 'idle-running';
    let paused: PerfWindow | null = null;
    if (game.arcade) {
      const press = (id: string) =>
        page.evaluate((testId) => {
          const button = document.querySelector(`[data-testid="${testId}"]`) as HTMLButtonElement | null;
          button?.click();
          return button !== null;
        }, id);
      await press('play-replay');
      await page.evaluate(() => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
        document.dispatchEvent(new Event('visibilitychange'));
      });
      if (await page.waitForSelector('[data-testid="play-paused"]', { timeout: 5_000 }).then(() => true, () => false)) {
        await page.evaluate(() => window.__perf!.begin());
        await sleep(IDLE_MS);
        paused = await page.evaluate(() => window.__perf!.end());
      }
      await page.evaluate(() => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
      });
      // Ukázka pauzu sama zruší (`startDemo` pustí hodiny).
      await page.waitForSelector('[data-testid="play-demo-start"]', { timeout: 10_000 }).catch(() => null);
      if (await press('play-demo-start')) robot = 'startDemo';
    }
    step(`playing (${robot}), paused measured: ${paused !== null}`);
    await page.evaluate(() => window.__perf!.begin());
    await sleep(PLAY_MS);
    const playing = await page.evaluate(() => window.__perf!.end());

    // Po konci hry: záznam robota dohraný sondou naráz, pak obrazovka výsledku.
    step('ending by witness');
    const end = await page.evaluate(() => window.__playShell?.playWitness() ?? null);
    await page.evaluate(() => window.__perf!.begin());
    await sleep(IDLE_MS);
    const ended = await page.evaluate(() => window.__perf!.end());

    const facts = await page.evaluate(() => {
      const gl = document.createElement('canvas').getContext('webgl2');
      const debug = gl?.getExtension('WEBGL_debug_renderer_info');
      const resources = (performance.getEntriesByType('resource') as PerformanceResourceTiming[]).map((r) => ({
        path: new URL(r.name).pathname,
        transfer: r.transferSize,
        encoded: r.encodedBodySize,
      }));
      const sum = (test: (path: string) => boolean) => {
        const hit = resources.filter((r) => test(r.path));
        return { count: hit.length, transferBytes: hit.reduce((a, r) => a + r.transfer, 0), encodedBytes: hit.reduce((a, r) => a + r.encoded, 0) };
      };
      return {
        gpu: gl && debug ? String(gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)) : null,
        userAgent: navigator.userAgent,
        dpr: devicePixelRatio,
        viewport: { width: innerWidth, height: innerHeight },
        quality: document.querySelector('[data-testid="arcade-stage"]')?.getAttribute('data-quality') ?? null,
        firstDrawMs: window.__perf!.firstDrawMs,
        firstTickMs: window.__perf!.firstTickMs,
        glb: sum((path) => path.endsWith('.glb')),
        js: sum((path) => path.endsWith('.js')),
        all: sum(() => true),
      };
    });
    return { ...facts, robot, playing, paused, ended, endState: end?.runState ?? null, errors };
  } finally {
    await context.close();
  }
}

const median = (values: readonly (number | null)[]): number | null => {
  const numbers = values.filter((v): v is number => v !== null).sort((a, b) => a - b);
  if (numbers.length === 0) return null;
  const mid = Math.floor(numbers.length / 2);
  return numbers.length % 2 === 1 ? numbers[mid] : (numbers[mid - 1] + numbers[mid]) / 2;
};

type Run = Awaited<ReturnType<typeof measureOnce>>;

function summarise(runs: readonly Run[]) {
  const m = (pick: (run: Run) => number | null) => median(runs.map(pick));
  return {
    firstDrawMs: m((r) => r.firstDrawMs),
    firstTickMs: m((r) => r.firstTickMs),
    fpsP50: m((r) => r.playing.fpsP50),
    fpsP5: m((r) => r.playing.fpsP5),
    maxFrameMs: m((r) => r.playing.maxFrameMs),
    drawnFpsPlaying: m((r) => r.playing.drawnFps),
    drawnFpsPaused: m((r) => r.paused?.drawnFps ?? null),
    drawnFpsEnded: m((r) => r.ended.drawnFps),
    callsMedian: m((r) => r.playing.callsMedian),
    trianglesMedian: m((r) => r.playing.trianglesMedian),
    glbTransferBytes: m((r) => r.glb.transferBytes),
    jsTransferBytes: m((r) => r.js.transferBytes),
    allTransferBytes: m((r) => r.all.transferBytes),
    glbShareOfTransfer: m((r) => (r.all.transferBytes > 0 ? r.glb.transferBytes / r.all.transferBytes : null)),
  };
}

test('@measure play performance: legacy and P41 movements × desktop and emulated mid phone', async ({ browser, request }) => {
  test.setTimeout(60 * 60_000);
  const out = process.env.PERF_OUT ?? join('evals', 'play', 'perf', `baseline-${new Date().toISOString().slice(0, 10)}.json`);
  mkdirSync(join(out, '..'), { recursive: true });
  const report: Record<string, unknown> = {
    version: 'p28e-play-perf-v1',
    measuredAt: new Date().toISOString(),
    browser: browser.version(),
    note: 'Mobile profile is emulation: CPU throttled ×4 and Fast 4G via CDP on this machine\'s GPU, not a phone. Values per cell are medians of the runs.',
    repeats: REPEATS,
    results: {} as Record<string, unknown>,
  };
  const results = report.results as Record<string, unknown>;
  const save = () => writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);

  // Zúžení pro ladění: `PERF_GAMES=runner`, `PERF_PROFILES=desktop`.
  const only = (list: string | undefined, id: string) => list === undefined || list.split(',').includes(id);
  for (const game of GAMES.filter((g) => only(process.env.PERF_GAMES, g.id))) {
    step(`publishing ${game.id}`);
    const response = await request.post('/api/play/games', { data: { sentence: game.sentence } });
    expect(response.status(), await response.text()).toBeLessThan(300);
    const url = ((await response.json()) as { url: string }).url;
    for (const profile of PROFILES.filter((p) => only(process.env.PERF_PROFILES, p.id))) {
      const runs: Run[] = [];
      for (let i = 0; i < REPEATS; i += 1) {
        runs.push(await measureOnce(browser, url, game, profile));
        results[`${game.id}/${profile.id}`] = { game: game.id, sentence: game.sentence, profile: profile.id, cpuThrottle: profile.cpu, network: profile.network, median: summarise(runs), runs };
        save();
      }
      for (const run of runs) expect.soft(run.errors).toEqual([]);
      if (['drive', 'glide', 'walker', 'ball'].includes(game.id) && profile.id === 'moto-g-power-emulated') {
        expect.soft(summarise(runs).fpsP50, `${game.id}: median FPS in phone emulation`).not.toBeNull();
        expect.soft(summarise(runs).fpsP50!, `${game.id}: median FPS in phone emulation`).toBeGreaterThanOrEqual(40);
        for (const run of runs) {
          expect.soft(run.robot).toBe('startDemo');
          expect.soft(run.endState).toBe('won');
          expect.soft(run.playing.drawnFrames).toBeGreaterThan(0);
        }
      }
    }
  }
});
