#!/usr/bin/env node
/**
 * Sonda „čas do hratelnosti“ (P49 T2): jedna obecná měrka pro náš `/play`
 * i cizí weby, ať čísla vznikají stejně.
 *
 *   node scripts/measure/time-to-playable.mjs <config.json>
 *
 * Config: `url`; volitelně `promptSelector` + `sentence` (+ `submitSelector`,
 * bez něj Enter) pro měření „věta → hratelná“ – plochy, které na stránce byly
 * už před odesláním, se nepočítají –, `waitForUrl` (regex adresy hry, plocha se
 * hledá až po ní), `startSelector` (startovní tlačítko hry, klikne se na něj,
 * jakmile je vidět), `surfaceSelector` (výchozí
 * `canvas, iframe`), `timeoutMs`, `harPath` (+ `harContent` omit|embed|attach),
 * `screenshotDir`, `gpu` (výchozí ano), `headless`, `viewport`.
 * Výstup: jeden JSON řádek `{ t0, tPlayable, ms, playable, note, … }` na stdout;
 * `t0`/`tPlayable` jsou epoch ms, aby šly porovnat s časy v HAR.
 *
 * **Hratelná** = na stránce je plocha (největší viditelný canvas/iframe) a po
 * vstupu (klepnutí do středu plochy, Space, držená ArrowRight) se do 500 ms
 * změní ≥ 1 % jejích pixelů – a hned následující pokus na téže ploše reaguje
 * znovu. Jedna reakce nestačí: plakát „Tap to play“ přes iframe zmizí na první
 * klepnutí, i když hra pod ním ještě načítá. Klepnutí jde první, protože teprve
 * ono dá ploše (i iframe) fokus pro klávesy. `t0` = těsně před odesláním věty,
 * u sdílené hry těsně před navigací; `tPlayable` = snímek první reakce
 * potvrzené dvojice. Rozlišení je jeden pokus (~0,6 s): hra připravená
 * uprostřed pokusu se pozná až v dalším.
 *
 * Snímá se screenshot stránky (kompozitor), ne `toDataURL` plátna – WebGL bez
 * `preserveDrawingBuffer` i cizí iframe tak vidí stejně jako hráč.
 * `idleAfterPct` je změna plochy za 300 ms bez vstupu, změřená až po úspěchu:
 * ≥ 1 % znamená, že se plocha hýbe sama a verdikt je třeba ověřit snímkem
 * (běžící hra se hýbe; animovaná načítací obrazovka by prošla taky).
 */

import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from '@playwright/test';
import sharp from 'sharp';

export const CHANGE_PCT = 1;
export const REACT_MS = 500;
/** Součet |ΔR|+|ΔG|+|ΔB| nad touhle hranicí = jiný pixel; níž je šum vyhlazování. */
const PIXEL_DELTA = 24;
/** Menší prvek není herní plocha (ikona, sledovací pixel). */
const MIN_SIDE = 64;
const IDLE_MS = 300;
/** Značka ploch, které na stránce byly už před odesláním věty. */
const STALE = 'data-ttp-stale';
const POLL_MS = 100;

const GPU_ARGS = ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'];
const SOFTWARE_ARGS = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'];

const wait = (ms) => new Promise((done) => setTimeout(done, ms));
const round = (value) => Math.round(value * 100) / 100;

async function pixels(png) {
  const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

/** Podíl změněných pixelů v %; `null`, když se plocha mezi snímky změnila rozměrem. */
export async function changedPct(before, after) {
  const [a, b] = await Promise.all([pixels(before), pixels(after)]);
  if (a.width !== b.width || a.height !== b.height) return null;
  const count = a.width * a.height;
  let changed = 0;
  for (let offset = 0; offset < count * 3; offset += 3) {
    const delta = Math.abs(a.data[offset] - b.data[offset]) + Math.abs(a.data[offset + 1] - b.data[offset + 1]) + Math.abs(a.data[offset + 2] - b.data[offset + 2]);
    if (delta > PIXEL_DELTA) changed += 1;
  }
  return (changed / count) * 100;
}

/** Největší viditelná plocha, nebo `null`. */
async function findSurface(page, selector) {
  let best = null;
  for (const handle of await page.$$(selector)) {
    if ((await handle.getAttribute(STALE).catch(() => null)) !== null) continue;
    const box = await handle.boundingBox().catch(() => null);
    if (box === null || box.width < MIN_SIDE || box.height < MIN_SIDE) continue;
    if (best === null || box.width * box.height > best.box.width * best.box.height) best = { handle, box };
  }
  return best;
}

const shot = (handle) => handle.screenshot({ animations: 'allow', caret: 'hide', timeout: 2000 });

/**
 * Jeden pokus: snímek → vstup → snímky do 500 ms. Vrací čas a snímky změny,
 * nebo `null`, když plocha nezareagovala.
 */
async function attempt(page, surface) {
  const before = await shot(surface.handle);
  const centre = { x: surface.box.x + surface.box.width / 2, y: surface.box.y + surface.box.height / 2 };
  const inputAt = Date.now();
  await page.mouse.click(centre.x, centre.y);
  await page.keyboard.press('Space');
  await page.keyboard.down('ArrowRight');
  try {
    while (Date.now() - inputAt <= REACT_MS) {
      await wait(POLL_MS);
      const after = await shot(surface.handle);
      const seenAt = Date.now();
      const pct = await changedPct(before, after);
      if (pct !== null && pct >= CHANGE_PCT) return { seenAt, pct, before, after };
    }
    return null;
  } finally {
    await page.keyboard.up('ArrowRight');
  }
}

export async function measure(config) {
  const surfaceSelector = config.surfaceSelector ?? 'canvas, iframe';
  const timeoutMs = config.timeoutMs ?? 120_000;
  const gpu = config.gpu ?? true;
  const browser = await chromium.launch({ headless: config.headless ?? true, args: gpu ? GPU_ARGS : SOFTWARE_ARGS });
  const context = await browser.newContext({
    viewport: config.viewport ?? { width: 1280, height: 720 },
    deviceScaleFactor: 1,
    ...(config.harPath ? { recordHar: { path: config.harPath, content: config.harContent ?? 'omit', mode: 'full' } } : {}),
  });
  if (config.harPath) mkdirSync(dirname(config.harPath), { recursive: true });
  if (config.screenshotDir) mkdirSync(config.screenshotDir, { recursive: true });
  const page = await context.newPage();
  const result = { url: config.url, sentence: config.sentence ?? null, t0: 0, tPlayable: null, ms: null, playable: false, note: null, attempts: 0, inputChangePct: null, confirmChangePct: null, idleAfterPct: null, renderer: gpu ? 'gpu' : 'software', gameUrl: null };

  try {
    if (config.promptSelector) {
      await page.goto(config.url, { waitUntil: 'load', timeout: timeoutMs });
      const prompt = page.locator(config.promptSelector).first();
      await prompt.fill(config.sentence ?? '', { timeout: timeoutMs });
      // Hra, která na stránce tvorby hrála už před odesláním (doporučená hra,
      // feed), není ta nová – jinak se změří ona.
      await page.$$eval(surfaceSelector, (elements, mark) => elements.forEach((element) => element.setAttribute(mark, '')), STALE);
      result.t0 = Date.now();
      if (config.submitSelector) await page.locator(config.submitSelector).first().click({ timeout: timeoutMs });
      else await prompt.press('Enter');
    } else {
      result.t0 = Date.now();
      await page.goto(config.url, { waitUntil: 'commit', timeout: timeoutMs });
    }
    const deadline = result.t0 + timeoutMs;
    if (config.waitForUrl) await page.waitForURL(new RegExp(config.waitForUrl), { waitUntil: 'commit', timeout: Math.max(1, deadline - Date.now()) });
    // Startovní tlačítko mimo střed plochy (např. „PLAY“) obecný vstup
    // netrefí; klik je krok hráče, čas dál běží od t0.
    if (config.startSelector) await page.locator(config.startSelector).first().click({ timeout: Math.max(1, deadline - Date.now()) });

    let sawSurface = false;
    /** Reakce, která čeká na potvrzení hned následujícím pokusem na téže ploše. */
    let pending = null;
    while (Date.now() < deadline) {
      try {
        const surface = await findSurface(page, surfaceSelector);
        if (surface === null) {
          pending = null;
          await wait(POLL_MS);
          continue;
        }
        sawSurface = true;
        if (pending !== null && !(await pending.handle.evaluate((element, other) => element === other, surface.handle).catch(() => false))) pending = null;
        result.attempts += 1;
        const hit = await attempt(page, surface);
        if (hit === null) {
          pending = null;
          continue;
        }
        if (pending === null) {
          pending = { ...hit, handle: surface.handle };
          continue;
        }
        result.playable = true;
        result.tPlayable = pending.seenAt;
        result.ms = pending.seenAt - result.t0;
        result.inputChangePct = round(pending.pct);
        result.confirmChangePct = round(hit.pct);
        result.gameUrl = page.url();
        const idleA = await shot(surface.handle);
        await wait(IDLE_MS);
        result.idleAfterPct = round((await changedPct(idleA, await shot(surface.handle))) ?? 100);
        if (result.idleAfterPct >= CHANGE_PCT) result.note = `surface also changes without input (${result.idleAfterPct} % in ${IDLE_MS} ms) – check the screenshot`;
        if (config.screenshotDir) {
          await sharp(pending.before).toFile(join(config.screenshotDir, 'surface-before.png'));
          await sharp(pending.after).toFile(join(config.screenshotDir, 'surface-after.png'));
          await sharp(hit.after).toFile(join(config.screenshotDir, 'surface-confirm.png'));
          await page.screenshot({ path: join(config.screenshotDir, 'page.png') });
        }
        break;
      } catch (error) {
        // Navigace uprostřed pokusu odpojí prvek nebo zničí kontext – další pokus.
        if (!/detached|destroyed|navigat|Target closed|not attached|Timeout/i.test(String(error))) throw error;
        pending = null;
        await wait(POLL_MS);
      }
    }
    if (!result.playable) {
      result.note = sawSurface ? `timeout after ${timeoutMs} ms: surface never reacted to input` : `timeout after ${timeoutMs} ms: no surface matching ${surfaceSelector}`;
      result.gameUrl = page.url();
      if (config.screenshotDir) await page.screenshot({ path: join(config.screenshotDir, 'timeout.png') }).catch(() => undefined);
    }
  } catch (error) {
    result.note = `error: ${String(error).split('\n')[0]}`;
    if (config.screenshotDir) await page.screenshot({ path: join(config.screenshotDir, 'error.png') }).catch(() => undefined);
  } finally {
    await context.close();
    await browser.close();
  }
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const path = process.argv[2];
  if (!path) {
    console.error('usage: node scripts/measure/time-to-playable.mjs <config.json>');
    process.exit(2);
  }
  const result = await measure(JSON.parse(readFileSync(path, 'utf8')));
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
