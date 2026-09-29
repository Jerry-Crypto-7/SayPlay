/**
 * Snímky a časy sady vět P32 (P32D T2).
 *
 *   node scripts/p32/shots.mjs --base http://127.0.0.1:3354 --set evals/play/p32/sentences.json \
 *     --out evals/play/p32/runs/<label> [--live] [--limit N] [--fps-seconds 20] [--playable-timeout-ms 60000] \
 *     [--desktop-cpu-throttle 1]
 *
 * Pro každou větu v čistém kontextu Chromia (vlastní cache):
 * 1. Desktop 1280×720: `/play`, věta, klik na „Play it“. Harness pak opakovaně
 *    posílá úhyb a skok a čeká na sondu `data-input-tick` / `data-input-at`
 *    na `arcade-stage` (`ArcadePlay.tsx`) – tik, ve kterém jádro zpracovalo
 *    skutečný vstup. `timeToPlayableMs` = od kliknutí k němu. **Bez sondy je
 *    věta chyba**, žádná náhrada prvním snímkem: ten přijde dřív, než hra
 *    poslouchá, a vypadal by jako rozumné číslo.
 *    `timeToFirstFrameMs` = od kliknutí k prvnímu WebGL volání kreslení na
 *    plátně nové hry. Obě chvíle zapisuje prohlížeč (`Date.now()`), stejné
 *    hodiny jako klik.
 *    S `--live` pak počká na AI verzi (nejdéle 120 s) a vyfotí ji.
 * 2. Studené otevření odkazu `/play/<id>` v novém kontextu (`open`): tytéž
 *    dva časy od začátku navigace. `/play` před kliknutím načte hru feedu a
 *    s ní většinu kódu, takže čas od kliknutí studený start neukáže.
 * 3. Pixel 7 se 4× zpomaleným CPU (CDP `Emulation.setCPUThrottlingRate`):
 *    první snímek od navigace, snímek téže hry (a AI verze) a `fpsMedian` –
 *    medián snímků za sekundu přes `--fps-seconds`. Po celou dobu hraje robot
 *    („Show me how“): po konci běhu kreslí plátno jen na požádání a prázdná
 *    smyčka by ukázala 60.
 *
 * Položka sady se `spec` místo věty (P32D T4 – hra s fyzikálními tělesy) se
 * publikuje přímo `POST /api/play/games {spec}` a měří se jen body 2 a 3.
 *
 * Síťový log z desktopu (od kliknutí) a ze studeného otevření (`open.network`,
 * od navigace) nese kategorii načítání: html, js, api, glb, panorama, rapier,
 * audio, other – z něj baseline skládá fáze.
 *
 * Výstup: `<out>/result.json` a PNG. Exit 1, když některá věta skončila chybou.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { chromium, devices } from '@playwright/test';

export const USAGE =
  'usage: node scripts/p32/shots.mjs --base <url> --set <sentences.json> --out <dir> [--live] [--limit N] [--fps-seconds 20] [--playable-timeout-ms 60000] [--desktop-cpu-throttle 1]';

const AI_WAIT_MS = 120_000;
const SETTLE_MS = 1500;
const CPU_THROTTLING = 4;
const GAME_PATH = /^\/play\/[0-9a-f]+$/;

const TEXT_FLAGS = { '--base': 'base', '--set': 'set', '--out': 'out' };
const NUMBER_FLAGS = { '--limit': 'limit', '--fps-seconds': 'fpsSeconds', '--playable-timeout-ms': 'playableTimeoutMs', '--desktop-cpu-throttle': 'desktopCpuThrottle' };

export function parseArgs(argv) {
  const options = { base: null, set: null, out: null, live: false, limit: null, fpsSeconds: 20, playableTimeoutMs: 60_000, desktopCpuThrottle: 1 };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--live') options.live = true;
    else if (flag in TEXT_FLAGS) {
      const value = argv[++i];
      if (value === undefined || value.startsWith('--')) throw new Error(`${flag} needs a value\n${USAGE}`);
      options[TEXT_FLAGS[flag]] = value;
    } else if (flag in NUMBER_FLAGS) {
      const value = Number(argv[++i]);
      if (!Number.isInteger(value) || value <= 0) throw new Error(`${flag} needs a positive whole number\n${USAGE}`);
      options[NUMBER_FLAGS[flag]] = value;
    } else throw new Error(`unknown flag ${flag}\n${USAGE}`);
  }
  for (const [flag, key] of Object.entries(TEXT_FLAGS)) if (options[key] === null) throw new Error(`missing ${flag}\n${USAGE}`);
  options.base = options.base.replace(/\/+$/, '');
  return options;
}

/**
 * Věty sady: `{ sentences: [text | { id, text } | { id, spec }] }` (tvar P32-0 T7) nebo holé pole.
 * Položka se `spec` (P32D T4) je hotový GameSpec – offline věta hru s fyzikálními tělesy nedá.
 */
export function loadSentences(file) {
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  const list = Array.isArray(raw) ? raw : raw.sentences;
  if (!Array.isArray(list) || list.length === 0) throw new Error(`${file}: no sentences`);
  return list.map((entry, index) => {
    const id = `s${String(index + 1)}`;
    if (typeof entry === 'string') return { id, text: entry };
    const named = typeof entry.id === 'string' ? entry.id : id;
    if (entry.spec !== undefined && entry.spec !== null && typeof entry.spec === 'object') return { id: named, text: null, spec: entry.spec };
    const text = entry.text ?? entry.sentence;
    if (typeof text !== 'string') throw new Error(`${file}: sentence ${id} has no text`);
    return { id: named, text };
  });
}

/** Fáze načítání, do které požadavek patří. */
export function categoryOf(url, resourceType) {
  const path = new URL(url).pathname;
  if (resourceType === 'document') return 'html';
  if (path.startsWith('/api/')) return 'api';
  if (/\.glb$/i.test(path)) return 'glb';
  if (/\.wasm$/i.test(path) || /rapier/i.test(path)) return 'rapier';
  if (path.includes('/env/') || /\.(hdr|exr|ktx2)$/i.test(path)) return 'panorama';
  if (path.includes('/audio/') || resourceType === 'media') return 'audio';
  if (resourceType === 'script' || /\.js$/i.test(path)) return 'js';
  return 'other';
}

/** Stejná volba rendereru jako `scripts/browser-renderer.ts` (ten je TypeScript a holý Node ho nenačte). */
function rendererArgs(env = process.env) {
  const mode = env.E2E_RENDERER ?? (process.platform === 'win32' && !env.CI ? 'native' : 'software');
  if (mode === 'software') return { mode, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] };
  return { mode, args: process.platform === 'win32' ? ['--use-gl=angle', '--use-angle=d3d11'] : [] };
}

/**
 * Běží v prohlížeči před každým dokumentem. Klik na „Play it“ (nebo na AI
 * verzi) zapíše čas a zapamatuje si plátna, která už existují (hra feedu
 * nahoře na `/play`); první volání kreslení na jiném plátně uvnitř
 * `arcade-stage` je první snímek nové hry. Přímé otevření `/play/<id>` měří
 * od načtení. `sessionStorage` přežije i tvrdou navigaci.
 */
function instrument() {
  const CLICK = 'p32-click-at';
  const DRAW = 'p32-first-draw';
  const GRID = 'p32-grid-input';
  const STAGES = '[data-testid="arcade-stage"], [data-testid="play-grid-stage"]';
  const pendingClick = sessionStorage.getItem(CLICK) !== null && sessionStorage.getItem(DRAW) === null;
  window.__p32Known = new WeakSet();
  window.__p32Armed = pendingClick;
  if (!pendingClick && /^\/play\/[0-9a-f]+$/.test(location.pathname)) {
    sessionStorage.removeItem(DRAW);
    window.__p32Armed = true;
  }
  // Mřížková hra nemá `arcade-stage`: vstup zpracuje runtime synchronně při klepnutí
  // na kartu cíle a zapíše ho s tikem do `__playShell.inputs()`. Hlídá se každý snímek.
  const watchGrid = (until) => {
    if (sessionStorage.getItem(GRID) !== null || Date.now() > until) return;
    // Jen nová hra: mřížková hra feedu na `/play` má vlastní `__playShell`.
    const onGame = /^\/play\/[0-9a-f]+$/.test(location.pathname) && document.querySelector('[data-testid="play-grid-stage"]') !== null;
    const log = onGame ? window.__playShell?.inputs?.() : null;
    if (log && log.length > 0) {
      sessionStorage.setItem(GRID, JSON.stringify({ at: Date.now(), tick: typeof log[0].tick === 'number' ? log[0].tick : null }));
      return;
    }
    requestAnimationFrame(() => watchGrid(until));
  };
  if (pendingClick) watchGrid(Date.now() + 120_000);
  else if (window.__p32Armed) {
    sessionStorage.removeItem(GRID);
    watchGrid(Date.now() + 120_000);
  }
  document.addEventListener(
    'click',
    (event) => {
      if (!(event.target instanceof Element) || event.target.closest('[data-testid="play-create"], [data-testid="upgrade-action"]') === null) return;
      sessionStorage.setItem(CLICK, String(Date.now()));
      sessionStorage.removeItem(DRAW);
      sessionStorage.removeItem(GRID);
      window.__p32Known = new WeakSet(document.querySelectorAll('canvas'));
      window.__p32Armed = true;
      watchGrid(Date.now() + 120_000);
    },
    true,
  );
  const hook = (proto) => {
    for (const name of ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced', 'drawRangeElements']) {
      const original = proto[name];
      if (typeof original !== 'function') continue;
      proto[name] = function (...args) {
        if (window.__p32Armed) {
          const canvas = this.canvas;
          if (canvas instanceof HTMLCanvasElement && !window.__p32Known.has(canvas) && canvas.closest(STAGES) !== null) {
            window.__p32Armed = false;
            sessionStorage.setItem(DRAW, String(Date.now()));
          }
        }
        return original.apply(this, args);
      };
    }
  };
  hook(WebGLRenderingContext.prototype);
  if (typeof WebGL2RenderingContext !== 'undefined') hook(WebGL2RenderingContext.prototype);
}

async function stored(page, key) {
  const value = await page.evaluate((name) => sessionStorage.getItem(name), key).catch(() => null);
  return value === null ? null : Number(value);
}

async function firstDrawAt(page, deadline) {
  while (Date.now() < deadline) {
    const at = await stored(page, 'p32-first-draw');
    if (at !== null) return at;
    await page.waitForTimeout(50);
  }
  return null;
}

/**
 * Posílá vstup, dokud sonda neřekne, že ho jádro zpracovalo. Arkáda: držený
 * úhyb (plošinovka, aréna a řízení čtou drženou osu), skok/ťuk mezerníkem a
 * občas ťuk na scénu (míření); sonda `data-input-at` na `arcade-stage`.
 * Mřížka: klepnutí na první kartu cíle; sonda je záznam vstupů runtime.
 * Vrací `{ at, tick, probe }` nebo `null` po lhůtě.
 */
async function inputUntilProbe(page, clickAt, deadline) {
  const stage = page.locator('[data-testid="arcade-stage"]').first();
  const card = page.locator('[data-testid^="play-target-"]').first();
  for (let round = 1; Date.now() < deadline; round += 1) {
    const probe = await page
      .evaluate((since) => {
        for (const element of document.querySelectorAll('[data-testid="arcade-stage"][data-input-at]')) {
          const at = Number(element.getAttribute('data-input-at'));
          if (at >= since) return { at, tick: Number(element.getAttribute('data-input-tick')), probe: 'arcade-stage' };
        }
        const grid = sessionStorage.getItem('p32-grid-input');
        return grid === null ? null : { ...JSON.parse(grid), probe: 'grid-input-log' };
      }, clickAt)
      .catch(() => null);
    if (probe !== null) return probe;
    if (await card.isVisible().catch(() => false)) {
      await card.click({ timeout: 1000 }).catch(() => {});
      await page.waitForTimeout(50);
      continue;
    }
    await page.keyboard.down('ArrowRight');
    await page.waitForTimeout(60);
    await page.keyboard.up('ArrowRight');
    await page.keyboard.press(' ');
    if (round % 4 === 0) {
      const box = await stage.boundingBox().catch(() => null);
      if (box !== null) await page.mouse.click(box.x + box.width / 2, box.y + box.height * 0.6).catch(() => {});
    }
  }
  return null;
}

async function clickIfVisible(page, testId) {
  const target = page.getByTestId(testId);
  if (!(await target.isVisible().catch(() => false))) return false;
  await target.click({ timeout: 1000 }).catch(() => {});
  return true;
}

async function measureFps(page, seconds) {
  const sampling = page.evaluate(
    (span) =>
      new Promise((resolve) => {
        const samples = [];
        let frames = 0;
        let from = performance.now();
        const end = from + span * 1000;
        const frame = (now) => {
          frames += 1;
          if (now - from >= 1000) {
            samples.push(Math.round(((frames * 1000) / (now - from)) * 10) / 10);
            frames = 0;
            from = now;
          }
          if (now < end) requestAnimationFrame(frame);
          else resolve(samples);
        };
        requestAnimationFrame(frame);
      }),
    seconds,
  );
  const end = Date.now() + seconds * 1000;
  while (Date.now() < end) {
    if (!(await clickIfVisible(page, 'play-demo-start'))) if (!(await clickIfVisible(page, 'play-demo-yours'))) await clickIfVisible(page, 'play-again');
    await page.waitForTimeout(500);
  }
  const samples = await sampling;
  const sorted = [...samples].sort((a, b) => a - b);
  const median = sorted.length === 0 ? null : sorted.length % 2 === 1 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
  return { median, samples };
}

/** Stav proužku AI verze do `ready`/`final`/`lost`, nejdéle `AI_WAIT_MS`. */
async function waitForAi(page) {
  const deadline = Date.now() + AI_WAIT_MS;
  let kind = null;
  while (Date.now() < deadline) {
    kind = await page.getByTestId('upgrade-state').getAttribute('data-kind', { timeout: 1000 }).catch(() => null);
    if (kind === 'ready' || kind === 'final' || kind === 'lost') return kind;
    await page.waitForTimeout(1000);
  }
  return kind === null ? 'absent' : 'timeout';
}

async function entryOf(request, failed) {
  const timing = request.timing();
  let bytes = null;
  if (!failed) {
    try {
      bytes = (await request.sizes()).responseBodySize;
    } catch {
      // Odpověď bez těla (přesměrování, zrušený požadavek).
    }
  }
  return { url: request.url(), resourceType: request.resourceType(), startTime: timing.startTime, durationMs: timing.responseEnd >= 0 ? timing.responseEnd : null, bytes, failed };
}

/** Síťový log od chvíle `since` (klik nebo začátek navigace), seřazený, v ms od ní. */
async function networkSince(pending, since) {
  const settled = await Promise.all(pending);
  return settled
    .filter((request) => request.startTime >= since - 1)
    .sort((a, b) => a.startTime - b.startTime)
    .map((request) => ({
      path: new URL(request.url).pathname + new URL(request.url).search,
      category: categoryOf(request.url, request.resourceType),
      resourceType: request.resourceType,
      startMs: Math.round(request.startTime - since),
      endMs: request.durationMs === null ? null : Math.round(request.startTime + request.durationMs - since),
      bytes: request.bytes,
      failed: request.failed,
    }));
}

/** Hra ze specu jde rovnou dveřmi `POST /api/play/games`; `/play` nemá pole na spec. */
async function publishSpec(base, spec) {
  const response = await fetch(`${base}/api/play/games`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ spec }) });
  const body = await response.json().catch(() => null);
  if (!response.ok || typeof body?.url !== 'string') throw new Error(`POST /api/play/games {spec} → ${String(response.status)} ${JSON.stringify(body)}`);
  return new URL(body.url, base).pathname;
}

async function shootSentence(browser, options, sentence, log) {
  const entry = {
    id: sentence.id,
    text: sentence.text,
    /** `sentence` = klik na „Play it“ na `/play`; `spec` = hra publikovaná ze specu, jen studené otevření a telefon. */
    source: sentence.spec === undefined ? 'sentence' : 'spec',
    gamePath: null,
    timeToPlayableMs: null,
    timeToFirstFrameMs: null,
    inputTick: null,
    /** Která sonda čas dala: `arcade-stage` (arkáda) nebo `grid-input-log` (mřížka). */
    probe: null,
    /** Studené otevření odkazu `/play/<id>` v čistém kontextu, od začátku navigace. */
    open: { timeToPlayableMs: null, timeToFirstFrameMs: null, phoneFirstFrameMs: null, network: [] },
    fpsMedian: null,
    fpsSamples: [],
    shots: { draftDesktop: null, draftPhone: null, aiDesktop: null, aiPhone: null },
    ai: null,
    network: [],
    error: null,
  };
  const errors = [];
  const shotPath = (name) => {
    const file = `${sentence.id}-${name}.png`;
    return { file, path: join(options.out, file) };
  };

  if (sentence.spec !== undefined) {
    try {
      entry.gamePath = await publishSpec(options.base, sentence.spec);
    } catch (error) {
      errors.push(`publish: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`);
    }
  } else await shootDesktop(browser, options, sentence, entry, errors, shotPath);

  // 2. Studené otevření odkazu hry: nic z `/play` v cache, čas od začátku navigace
  //    (`performance.timeOrigin`). Tak přijde hráč ze sdíleného odkazu.
  if (entry.gamePath !== null) {
    const cold = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    await cold.addInitScript(instrument);
    const requests = [];
    try {
      const page = await cold.newPage();
      if (options.desktopCpuThrottle > 1) await (await cold.newCDPSession(page)).send('Emulation.setCPUThrottlingRate', { rate: options.desktopCpuThrottle });
      page.on('requestfinished', (request) => requests.push(entryOf(request, false)));
      page.on('requestfailed', (request) => requests.push(entryOf(request, true)));
      await page.goto(`${options.base}${entry.gamePath}`, { waitUntil: 'domcontentloaded' });
      const origin = await page.evaluate(() => performance.timeOrigin);
      const deadline = origin + options.playableTimeoutMs;
      const probe = await inputUntilProbe(page, origin, deadline);
      if (probe === null) errors.push(`open: input probe never fired within ${String(options.playableTimeoutMs)} ms of navigation`);
      else entry.open.timeToPlayableMs = Math.round(probe.at - origin);
      const drawAt = await firstDrawAt(page, Math.max(deadline, Date.now() + 2000));
      if (drawAt !== null) entry.open.timeToFirstFrameMs = Math.round(drawAt - origin);
      entry.open.network = await networkSince(requests.splice(0), origin);
    } catch (error) {
      errors.push(`open: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`);
    } finally {
      await Promise.allSettled(requests);
      await cold.close();
    }
  }

  // 3. Telefon: snímek téže hry a FPS se zpomaleným CPU.
  if (entry.gamePath !== null) {
    const phone = await browser.newContext({ ...devices['Pixel 7'] });
    await phone.addInitScript(instrument);
    try {
      const page = await phone.newPage();
      const cdp = await phone.newCDPSession(page);
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU_THROTTLING });
      await page.goto(`${options.base}${entry.gamePath}`, { waitUntil: 'load' });
      const phoneDraw = await firstDrawAt(page, Date.now() + options.playableTimeoutMs);
      if (phoneDraw !== null) entry.open.phoneFirstFrameMs = Math.round(phoneDraw - (await page.evaluate(() => performance.timeOrigin)));
      await page.waitForTimeout(SETTLE_MS);
      const draft = shotPath('draft-phone');
      await page.screenshot({ path: draft.path });
      entry.shots.draftPhone = draft.file;
      const fps = await measureFps(page, options.fpsSeconds);
      entry.fpsMedian = fps.median;
      entry.fpsSamples = fps.samples;
      if (entry.ai?.gamePath) {
        await page.goto(`${options.base}${entry.ai.gamePath}`, { waitUntil: 'load' });
        await firstDrawAt(page, Date.now() + options.playableTimeoutMs);
        await page.waitForTimeout(SETTLE_MS);
        const ai = shotPath('ai-phone');
        await page.screenshot({ path: ai.path });
        entry.shots.aiPhone = ai.file;
      }
    } catch (error) {
      errors.push(`phone: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`);
    } finally {
      await phone.close();
    }
  }

  entry.error = errors.length === 0 ? null : errors.join('; ');
  log(
    `[p32-shots] ${sentence.id}: playable ${String(entry.timeToPlayableMs ?? '–')} ms, first frame ${String(entry.timeToFirstFrameMs ?? '–')} ms, cold open ${String(entry.open.timeToPlayableMs ?? '–')}/${String(entry.open.timeToFirstFrameMs ?? '–')} ms, phone first frame ${String(entry.open.phoneFirstFrameMs ?? '–')} ms, fps ${String(entry.fpsMedian ?? '–')}${entry.ai ? `, ai ${entry.ai.status}` : ''}${entry.error ? ` – ERROR ${entry.error}` : ''}`,
  );
  return entry;
}

/** 1. Desktop: klik → vstup, klik → první snímek, snímek rychlé verze, případně AI verze. */
async function shootDesktop(browser, options, sentence, entry, errors, shotPath) {
  const desktop = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  await desktop.addInitScript(instrument);
  const requests = [];
  try {
    const page = await desktop.newPage();
    // Zpomalené CPU na desktopu napodobí přetížený prohlížeč (baseline T3); výchozí 1 = bez zátěže.
    if (options.desktopCpuThrottle > 1) await (await desktop.newCDPSession(page)).send('Emulation.setCPUThrottlingRate', { rate: options.desktopCpuThrottle });
    page.on('requestfinished', (request) => requests.push(entryOf(request, false)));
    page.on('requestfailed', (request) => requests.push(entryOf(request, true)));
    await page.goto(`${options.base}/play`, { waitUntil: 'load' });
    await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
    await page.getByTestId('play-sentence').fill(sentence.text);
    await page.getByTestId('play-create').click();
    const clickAt = await stored(page, 'p32-click-at');
    if (clickAt === null) throw new Error('the click on play-create was not recorded');
    const deadline = clickAt + options.playableTimeoutMs;
    await page.waitForURL((url) => GAME_PATH.test(url.pathname), { timeout: options.playableTimeoutMs });
    entry.gamePath = new URL(page.url()).pathname;
    await page.evaluate(() => (document.activeElement instanceof HTMLElement ? document.activeElement.blur() : undefined)).catch(() => {});

    const probe = await inputUntilProbe(page, clickAt, deadline);
    if (probe === null) errors.push(`input probe (data-input-tick on arcade-stage, or the grid input log) never fired within ${String(options.playableTimeoutMs)} ms of the click`);
    else {
      entry.timeToPlayableMs = probe.at - clickAt;
      entry.inputTick = probe.tick;
      entry.probe = probe.probe;
    }
    const drawAt = await firstDrawAt(page, Math.max(deadline, Date.now() + 2000));
    if (drawAt === null) errors.push('no WebGL draw call on the new game stage canvas');
    else entry.timeToFirstFrameMs = drawAt - clickAt;

    await page.waitForTimeout(500);
    const draft = shotPath('draft-desktop');
    await page.screenshot({ path: draft.path });
    entry.shots.draftDesktop = draft.file;

    entry.network = await networkSince(requests.splice(0), clickAt);

    if (options.live) {
      const status = await waitForAi(page);
      entry.ai = { status, gamePath: null };
      if (status === 'ready') {
        await page.getByTestId('upgrade-action').click();
        await page.waitForURL((url) => GAME_PATH.test(url.pathname) && url.pathname !== entry.gamePath, { timeout: options.playableTimeoutMs });
        entry.ai.gamePath = new URL(page.url()).pathname;
        await firstDrawAt(page, Date.now() + options.playableTimeoutMs);
        await page.waitForTimeout(SETTLE_MS);
        const ai = shotPath('ai-desktop');
        await page.screenshot({ path: ai.path });
        entry.shots.aiDesktop = ai.file;
      }
    }
  } catch (error) {
    errors.push(`desktop: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`);
  } finally {
    await Promise.allSettled(requests);
    await desktop.close();
  }
}

/**
 * Projde sadu a zapíše `<out>/result.json`; vrací týž objekt.
 *
 * @param {{ base: string, set: string, out: string, live: boolean, limit: number | null, fpsSeconds: number, playableTimeoutMs: number }} options
 */
export async function shoot(options, { log = (line) => process.stderr.write(`${line}\n`) } = {}) {
  const all = loadSentences(options.set);
  const sentences = options.limit === null ? all : all.slice(0, options.limit);
  mkdirSync(options.out, { recursive: true });
  const renderer = rendererArgs();
  const browser = await chromium.launch({ args: renderer.args });
  const startedAt = new Date().toISOString();
  const results = [];
  try {
    for (const sentence of sentences) results.push(await shootSentence(browser, options, sentence, log));
  } finally {
    await browser.close();
  }
  const result = {
    schema: 'p32-shots/1',
    label: basename(options.out),
    base: options.base,
    set: options.set,
    live: options.live,
    startedAt,
    finishedAt: new Date().toISOString(),
    settings: {
      desktop: '1280x720',
      desktopCpuThrottling: options.desktopCpuThrottle,
      phone: 'Pixel 7',
      cpuThrottling: CPU_THROTTLING,
      fpsSeconds: options.fpsSeconds,
      renderer: renderer.mode,
    },
    sentences: results,
  };
  writeFileSync(join(options.out, 'result.json'), `${JSON.stringify(result, null, 2)}\n`);
  return result;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(2);
  }
  const result = await shoot(options);
  process.exitCode = result.sentences.every((sentence) => sentence.error === null) ? 0 : 1;
}
