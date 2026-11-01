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
 * `screenshotDir`, `gpu` (výchozí ano), `headless`, `viewport`, `device`
 * (jméno zařízení z Playwright `devices`, např. `Pixel 7` – přebije `viewport`),
 * `cpuThrottle` (zpomalení CPU přes CDP, např. 4 jako `e2e/p35-perf.spec.ts`).
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
 * **Přijatý vstup (P68I T4):** má-li stránka HUD naší arkády
 * (`[data-testid=play-tick]`, mimo plochy z doby před odesláním věty), nestačí
 * změna plochy – po vstupu musí na témže prvku vzrůst `data-inputs` (vstupy,
 * které relace zapsala) **i** `data-tick` (simulace běží). Animovaná načítací
 * obrazovka nebo ukázka robota tak hratelnost nepředstírá. Prvek bez
 * `data-inputs` neroste nikdy, tedy nehratelný – raději selhání než tichý návrat
 * k samotné ploše. Cizí web ten prvek nemá a soudí se jen podle plochy.
 *
 * Snímá se screenshot stránky (kompozitor), ne `toDataURL` plátna – WebGL bez
 * `preserveDrawingBuffer` i cizí iframe tak vidí stejně jako hráč. Snímek je
 * v CSS pixelech: na telefonu s hustotou 2,6 a 4× zpomaleným CPU trval snímek
 * v plném rozlišení přes 2 s a jeden pokus ~5 s (P50 T1); na desktopu s hustotou
 * 1 je to totéž.
 *
 * `firstFrameMs` (P50 T1) = od `t0` do konce prvního snímku (`requestAnimationFrame`),
 * ve kterém měřené WebGL plátno kreslilo – bez zrnitosti pokusů, a proto
 * citlivější na změny před prvním snímkem než `ms`. U iframe a 2D plátna `null`.
 * `idleAfterPct` je změna plochy za 300 ms bez vstupu, změřená až po úspěchu:
 * ≥ 1 % znamená, že se plocha hýbe sama a verdikt je třeba ověřit snímkem
 * (běžící hra se hýbe; animovaná načítací obrazovka by prošla taky).
 */

import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium, devices } from '@playwright/test';
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
/** Epoch ms konce prvního snímku, ve kterém plátno kreslilo (`markFirstFrame`). */
const FIRST_FRAME = 'data-ttp-first-frame';
const POLL_MS = 100;
/** HUD arkády s počítadly přijatého vstupu (`data-inputs`) a simulace (`data-tick`). */
const ACCEPT_SELECTOR = '[data-testid=play-tick]';
/** Karta pauzy HUD (`PauseCard`): hra, která mezerník nehraje (jízda, stunt), ji na mezerník otevře (`hudKey`). */
const PAUSE_SELECTOR = '[data-testid=play-paused]';

/** Pauzu, kterou otevřel mezerník sondy, zavře Esc jako hráč – jinak karta zakryje střed plochy a hra stojí. */
async function closeOwnPause(page) {
  if (await page.locator(PAUSE_SELECTOR).first().isVisible().catch(() => false)) await page.keyboard.press('Escape');
}

/**
 * Skript stránky: výchozí stav počítadel na každém živém prvku HUD arkády; vrací jejich počet. HUD bez `data-inputs`
 * (mřížkové hry, `Hud.tsx`) se vynechá, takže se taková stránka soudí jen plochou.
 */
function markAccept([selector, stale]) {
  let count = 0;
  for (const element of document.querySelectorAll(selector)) {
    if (element.hasAttribute(stale) || !element.hasAttribute('data-inputs')) continue;
    element.__ttpAccept = { inputs: Number(element.getAttribute('data-inputs')), tick: Number(element.getAttribute('data-tick')) };
    count += 1;
  }
  return count;
}

/** Skript stránky: vzrostly na některém prvku od `markAccept` vstupy i tik? (`NaN` neroste.) */
function acceptedSince([selector, stale]) {
  for (const element of document.querySelectorAll(selector)) {
    const before = element.__ttpAccept;
    if (before === undefined || element.hasAttribute(stale)) continue;
    if (Number(element.getAttribute('data-inputs')) > before.inputs && Number(element.getAttribute('data-tick')) > before.tick) return true;
  }
  return false;
}

/**
 * Skript stránky (běží před jejími skripty): kreslicí volání WebGL zapíše své
 * plátno do čekajících a po doběhnutí callbacku `requestAnimationFrame` dostane
 * každé čekající plátno atribut s časem. Příznak na kontextu drží režii na
 * jednom porovnání za volání.
 */
function markFirstFrame(attribute) {
  const pending = new Set();
  for (const type of [globalThis.WebGLRenderingContext, globalThis.WebGL2RenderingContext]) {
    if (type === undefined) continue;
    for (const name of ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced', 'drawRangeElements']) {
      const original = type.prototype[name];
      if (typeof original !== 'function') continue;
      type.prototype[name] = function (...args) {
        if (this.__ttpDrew !== true) {
          this.__ttpDrew = true;
          if (typeof this.canvas?.setAttribute === 'function') pending.add(this.canvas);
        }
        return original.apply(this, args);
      };
    }
  }
  const request = globalThis.requestAnimationFrame.bind(globalThis);
  globalThis.requestAnimationFrame = (callback) =>
    request((time) => {
      try {
        callback(time);
      } finally {
        for (const canvas of pending) canvas.setAttribute(attribute, String(Date.now()));
        pending.clear();
      }
    });
}

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

const shot = (handle) => handle.screenshot({ animations: 'allow', caret: 'hide', scale: 'css', timeout: 2000 });

/**
 * Jeden pokus: snímek → vstup → snímky do 500 ms. Vrací čas a snímky změny,
 * nebo `null`, když plocha nezareagovala. Na stránce s HUD arkády se změna
 * počítá, až když HUD vstup i přijal; jinak `{ accepted: false }`.
 */
async function attempt(page, surface) {
  await closeOwnPause(page);
  const before = await shot(surface.handle);
  const guarded = (await page.evaluate(markAccept, [ACCEPT_SELECTOR, STALE])) > 0;
  const centre = { x: surface.box.x + surface.box.width / 2, y: surface.box.y + surface.box.height / 2 };
  const inputAt = Date.now();
  await page.mouse.click(centre.x, centre.y);
  await page.keyboard.press('Space');
  await closeOwnPause(page);
  await page.keyboard.down('ArrowRight');
  try {
    let surfaceOnly = false;
    while (Date.now() - inputAt <= REACT_MS) {
      await wait(POLL_MS);
      // Počítadla před snímkem: v `seenAt` už platí obojí.
      const accepted = !guarded || (await page.evaluate(acceptedSince, [ACCEPT_SELECTOR, STALE]));
      const after = await shot(surface.handle);
      const seenAt = Date.now();
      const pct = await changedPct(before, after);
      if (pct === null || pct < CHANGE_PCT) continue;
      if (accepted) return { seenAt, pct, before, after, accepted: true };
      surfaceOnly = true;
    }
    return surfaceOnly ? { accepted: false } : null;
  } finally {
    await page.keyboard.up('ArrowRight');
  }
}

export async function measure(config) {
  const surfaceSelector = config.surfaceSelector ?? 'canvas, iframe';
  const timeoutMs = config.timeoutMs ?? 120_000;
  const gpu = config.gpu ?? true;
  if (config.device && !devices[config.device]) throw new Error(`unknown Playwright device ${config.device}`);
  const { defaultBrowserType: _browserType, ...device } = config.device ? devices[config.device] : {};
  const browser = await chromium.launch({ headless: config.headless ?? true, args: gpu ? GPU_ARGS : SOFTWARE_ARGS });
  const context = await browser.newContext({
    viewport: config.viewport ?? { width: 1280, height: 720 },
    deviceScaleFactor: 1,
    ...device,
    ...(config.harPath ? { recordHar: { path: config.harPath, content: config.harContent ?? 'omit', mode: 'full' } } : {}),
  });
  if (config.harPath) mkdirSync(dirname(config.harPath), { recursive: true });
  if (config.screenshotDir) mkdirSync(config.screenshotDir, { recursive: true });
  await context.addInitScript(markFirstFrame, FIRST_FRAME);
  const page = await context.newPage();
  if (config.cpuThrottle) await (await context.newCDPSession(page)).send('Emulation.setCPUThrottlingRate', { rate: config.cpuThrottle });
  const result = { url: config.url, sentence: config.sentence ?? null, t0: 0, tPlayable: null, ms: null, playable: false, note: null, attempts: 0, inputChangePct: null, confirmChangePct: null, idleAfterPct: null, firstFrameMs: null, renderer: gpu ? 'gpu' : 'software', gameUrl: null };

  try {
    if (config.promptSelector) {
      await page.goto(config.url, { waitUntil: 'load', timeout: timeoutMs });
      const prompt = page.locator(config.promptSelector).first();
      await prompt.fill(config.sentence ?? '', { timeout: timeoutMs });
      // Hra, která na stránce tvorby hrála už před odesláním (doporučená hra,
      // feed), není ta nová – jinak se změří ona, její plocha i její HUD.
      await page.$$eval(`${surfaceSelector}, ${ACCEPT_SELECTOR}`, (elements, mark) => elements.forEach((element) => element.setAttribute(mark, '')), STALE);
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
    /** Plocha se na vstup změnila, ale HUD arkády ho nepřijal. */
    let sawUnaccepted = false;
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
        if (hit === null || !hit.accepted) {
          sawUnaccepted ||= hit !== null;
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
        const frameAt = await surface.handle.getAttribute(FIRST_FRAME).catch(() => null);
        result.firstFrameMs = frameAt === null ? null : Number(frameAt) - result.t0;
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
      result.note = !sawSurface
        ? `timeout after ${timeoutMs} ms: no surface matching ${surfaceSelector}`
        : sawUnaccepted
          ? `timeout after ${timeoutMs} ms: surface changed but the game never accepted the input (data-inputs and data-tick did not both grow)`
          : `timeout after ${timeoutMs} ms: surface never reacted to input`;
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
