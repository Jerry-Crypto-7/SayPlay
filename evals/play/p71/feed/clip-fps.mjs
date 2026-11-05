#!/usr/bin/env node
/**
 * P71B T2: nahrávání klipu aktivní karty nesmí shodit FPS náhledu pod 55 na emulovaném telefonu.
 *
 * A/B prokládaně hru po hře (A,B / B,A střídavě), každá návštěva v novém kontextu (prázdné IndexedDB):
 *   A = bez `MediaRecorder` (klip se nenahrává), B = skutečný `MediaRecorder`, obalený jen kvůli
 *   značce `window.__clip` (začátek, konec, velikost). FPS = 2 s snímků prohlížeče během běžícího náhledu –
 *   u B právě během nahrávání, u A ve stejné chvíli po rozběhnutí náhledu (+ `CLIP_DELAY_MS`).
 * U B navíc oracle záznamu: klip leží v IndexedDB `sayplay-clips` a v `<video>` má délku a rozměr.
 *
 *   CLIP_FPS_URL=http://127.0.0.1:3011 node --experimental-strip-types evals/play/p71/feed/clip-fps.mjs [hry=6]
 *
 * Pixel 7 (412×915, dotyk), CPU ×4 přes CDP, skutečné GPU, `--disable-features=OpenXR`. Výsledek do `clip-fps.json`.
 */

import { writeFileSync } from 'node:fs';

import { chromium, devices } from '@playwright/test';

await import('../../../../scripts/ts-paths.mjs');
const { browserRenderer } = await import('../../../../scripts/browser-renderer.ts');

const BASE = process.env.CLIP_FPS_URL ?? 'http://127.0.0.1:3011';
const GAMES = Number(process.argv[2] ?? 6);
const FPS_MS = 2000;
const CLIP_DELAY_MS = 1000;
const OUT = new URL('./clip-fps.json', import.meta.url);

/** Značka nahrávání a sonda FPS v každé stránce; `noRecorder` = varianta A. */
function probe(noRecorder) {
  if (noRecorder) {
    Object.defineProperty(window, 'MediaRecorder', { value: undefined, configurable: true });
  } else {
    const Real = window.MediaRecorder;
    window.__clip = { state: 'idle' };
    class Marked extends Real {
      constructor(stream, options) {
        super(stream, options);
        this.addEventListener('dataavailable', (event) => void (window.__clip.bytes = (window.__clip.bytes ?? 0) + event.data.size));
        this.addEventListener('stop', () => void Object.assign(window.__clip, { state: 'stopped', stoppedAt: performance.now() }));
      }
      start(...args) {
        Object.assign(window.__clip, { state: 'recording', startedAt: performance.now(), mimeType: this.mimeType });
        return super.start(...args);
      }
    }
    window.MediaRecorder = Marked;
  }
  window.__fps = (ms) =>
    new Promise((resolve) => {
      const intervals = [];
      let last = 0;
      const started = performance.now();
      const tick = (now) => {
        if (last > 0) intervals.push(now - last);
        last = now;
        if (now - started < ms) return void requestAnimationFrame(tick);
        const sorted = [...intervals].sort((a, b) => a - b);
        resolve({ fpsP50: 1000 / sorted[Math.floor(sorted.length / 2)], fpsP5: 1000 / sorted[Math.min(sorted.length - 1, Math.floor(0.95 * sorted.length))], meanFps: (intervals.length * 1000) / (now - started) });
      };
      requestAnimationFrame(tick);
    });
}

const round = (value) => (value === null || value === undefined ? null : Math.round(value * 10) / 10);
const median = (values) => {
  const sorted = values.filter((value) => typeof value === 'number').sort((a, b) => a - b);
  return sorted.length === 0 ? null : sorted[Math.floor(sorted.length / 2)];
};

/** Náhled běží: režim `preview` a tik roste. */
async function previewRunning(page, versionId) {
  await page.waitForFunction(
    (id) => {
      const feed = window.__playFeed?.();
      if (feed?.versionId !== id || feed.mode !== 'preview') return false;
      const seen = (window.__ticks ??= []);
      seen.push(feed.tick);
      return new Set(seen.slice(-4)).size >= 3;
    },
    versionId,
    { timeout: 60_000, polling: 100 },
  );
}

async function visit(browser, versionId, variant) {
  const { defaultBrowserType: _ignored, ...pixel7 } = devices['Pixel 7'];
  const context = await browser.newContext(pixel7);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => message.type() === 'error' && errors.push(message.text()));
  await page.addInitScript(probe, variant === 'A');
  const cdp = await context.newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  try {
    await page.goto(`${BASE}/play?g=${versionId}`);
    await previewRunning(page, versionId);
    let clip = null;
    if (variant === 'B') {
      await page.waitForFunction(() => window.__clip?.state === 'recording', undefined, { timeout: 30_000 });
    } else {
      await page.waitForTimeout(CLIP_DELAY_MS + 250);
    }
    const fps = await page.evaluate((ms) => window.__fps(ms), FPS_MS);
    if (variant === 'B') {
      await page.waitForFunction(() => window.__clip?.state === 'stopped', undefined, { timeout: 30_000 });
      // Klip v IndexedDB a přehratelný: délka a rozměr z `<video>`.
      clip = await page.evaluate(async () => {
        const deadline = performance.now() + 10_000;
        for (;;) {
          const found = await new Promise((resolve) => {
            const open = indexedDB.open('sayplay-clips', 1);
            open.onerror = () => resolve([]);
            open.onsuccess = () => {
              const db = open.result;
              if (!db.objectStoreNames.contains('clips')) return resolve([]);
              const all = db.transaction('clips', 'readonly').objectStore('clips').getAll();
              all.onsuccess = () => resolve(all.result);
              all.onerror = () => resolve([]);
            };
          });
          if (found.length > 0 || performance.now() > deadline) {
            const stored = found[0];
            if (stored === undefined) return { stored: false, ...window.__clip };
            const video = document.createElement('video');
            video.muted = true;
            video.src = URL.createObjectURL(stored.blob);
            await new Promise((resolve) => {
              video.onloadedmetadata = resolve;
              video.onerror = resolve;
            });
            // WebM z MediaRecorderu nemá v hlavičce délku: doskok na konec ji dopočte.
            if (!Number.isFinite(video.duration)) {
              video.currentTime = 1e6;
              await new Promise((resolve) => (video.ontimeupdate = resolve));
            }
            return { stored: true, versionId: stored.versionId, bytes: stored.blob.size, type: stored.blob.type, durationS: video.duration, width: video.videoWidth, height: video.videoHeight, recordedMs: window.__clip.stoppedAt - window.__clip.startedAt };
          }
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
      });
    }
    return { versionId, variant, fps: { fpsP50: round(fps.fpsP50), fpsP5: round(fps.fpsP5), meanFps: round(fps.meanFps) }, clip, errors };
  } finally {
    await context.close();
  }
}

const listed = await (await fetch(`${BASE}/api/play/games?recent=${String(Math.max(12, GAMES * 2))}`)).json();
const ids = listed.games.map((game) => game.versionId).slice(0, GAMES);
const browser = await chromium.launch({ args: [...browserRenderer().args, '--disable-features=OpenXR'] });
const visits = [];
try {
  for (const [n, versionId] of ids.entries()) {
    for (const variant of n % 2 === 0 ? ['A', 'B'] : ['B', 'A']) {
      const result = await visit(browser, versionId, variant).catch((error) => ({ versionId, variant, failed: String(error.message ?? error).split('\n')[0] }));
      visits.push(result);
      console.log(JSON.stringify(result));
    }
  }
} finally {
  await browser.close();
}

const of = (variant, key) => visits.filter((visit) => visit.variant === variant && visit.fps).map((visit) => visit.fps[key]);
const clips = visits.filter((visit) => visit.variant === 'B').map((visit) => visit.clip);
const summary = {
  games: ids.length,
  fpsP50: { A: median(of('A', 'fpsP50')), B: median(of('B', 'fpsP50')) },
  meanFps: { A: median(of('A', 'meanFps')), B: median(of('B', 'meanFps')) },
  fpsP5: { A: median(of('A', 'fpsP5')), B: median(of('B', 'fpsP5')) },
  clipsStored: clips.filter((clip) => clip?.stored === true).length,
  clipBytesMax: Math.max(0, ...clips.map((clip) => clip?.bytes ?? 0)),
  clipTypes: [...new Set(clips.map((clip) => clip?.type).filter(Boolean))],
  failed: visits.filter((visit) => visit.failed !== undefined).length,
  errors: visits.reduce((sum, visit) => sum + (visit.errors?.length ?? 0), 0),
};
summary.gate55 = summary.fpsP50.B !== null && summary.fpsP50.B >= 55;
writeFileSync(OUT, `${JSON.stringify({ measuredAt: new Date().toISOString(), base: BASE, device: 'Pixel 7 emulation 412x915, CPU x4 (CDP), native GPU, OpenXR off', method: 'A/B interleaved per game, fresh context per visit; A = no MediaRecorder, B = recording (window.__clip marks start/stop); FPS = 2 s of rAF during the running bot preview (B while recording).', summary, visits }, null, 2)}\n`);
console.log(JSON.stringify(summary));
