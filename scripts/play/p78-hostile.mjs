#!/usr/bin/env node
/**
 * P78 T1: nepřátelské věty proti produkci cestou porotce – formulář `/play`, „Make it!“, stránka hry.
 *
 *   node scripts/play/p78-hostile.mjs --base <demoUrl> --out evals/play/p78 [--shots D:/tmp/p78-hostile] [--only cs-1,tm-2]
 *
 * Sada `evals/play/p78/hostile.json`. Na větu: nový kontext Chromia (desktop, bez nápovědy první návštěvy), věta do pole
 * (`fill` – tak, jak ji porotce vloží; pole má `maxLength`, takže se zapíše i to, co v něm zůstalo), „Make it!“, pak buď
 * stránka hry, nebo hláška formuláře. U hry: shell a plátno do 90 s, titulek, hláška poctivosti, 2,5 s hry naostro (ťuk,
 * když hra čeká na první dotek), snímek scény a jeho pestrost (prázdná obrazovka = jedna barva), verdikt robota
 * `playWitness()` (paměť handplay-drops-aim) a chyby stránky. Věta, kterou pole zkrátilo nebo nepustí, jde navíc přímo
 * na `POST /api/play/games` (odpověď dveří bez formuláře). Jen rychlá verze: AI verzi sonda nečeká ani nečte.
 * Řádky se zapisují po každé větě do `hostile-run.json`, pád běhu je neztratí.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { args } from '../play-look-shots.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(import.meta.url);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** Text věty: `repeat` skládá dlouhou větu z jednotky na přesný počet znaků (soubor by ji jinak nesl jako zeď textu). */
export function textOf(entry) {
  if (entry.repeat === undefined) return entry.text;
  const { unit, chars } = entry.repeat;
  return unit.repeat(Math.ceil(chars / unit.length)).slice(0, chars);
}

/**
 * Pestrost výřezu PNG: počet barev po zaokrouhlení na 4 bity na kanál a směrodatná odchylka jasu. Jednobarevná plocha
 * (krémové pozadí, samá mlha, černé plátno) má obojí u nuly; scéna s postavou a terénem desítky barev.
 */
export function variety(png) {
  const colours = new Set();
  let sum = 0;
  let squares = 0;
  const pixels = png.width * png.height;
  for (let i = 0; i < pixels * 4; i += 4) {
    const [r, g, b] = [png.data[i], png.data[i + 1], png.data[i + 2]];
    colours.add(((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4));
    const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    sum += luma;
    squares += luma * luma;
  }
  const mean = sum / pixels;
  return { colours: colours.size, lumaSd: Math.round(Math.sqrt(Math.max(0, squares / pixels - mean * mean)) * 10) / 10 };
}

/** Prázdná obrazovka: méně než 12 barev, nebo jas skoro bez rozptylu. */
export const isBlank = (measure) => measure.colours < 12 || measure.lumaSd < 4;

const GAME_URL = /\/play\/[a-f0-9]{8,64}(?:[?#]|$)/;

async function direct(base, sentence) {
  const started = Date.now();
  const response = await fetch(`${base}/api/play/games`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sentence }) });
  const body = await response.json().catch(() => ({}));
  return { status: response.status, ms: Date.now() - started, code: body.error?.code ?? null, message: body.error?.message ?? null, versionId: body.versionId ?? null };
}

async function one(browser, PNG, base, shots, entry, n, options) {
  const text = textOf(entry);
  const row = { id: entry.id, class: entry.class, expect: entry.expect, chars: text.length, errors: [] };
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, extraHTTPHeaders: { 'x-forwarded-for': `203.0.113.${String(n)}` } });
  await ctx.addInitScript(() => localStorage.setItem('sp-first-visit', '1'));
  const page = await ctx.newPage();
  page.on('pageerror', (error) => row.errors.push(error.message.slice(0, 200)));
  try {
    await page.goto(`${base}/play`, { timeout: 120_000 });
    const field = page.getByTestId('play-sentence');
    await field.waitFor({ timeout: 60_000 });
    // Porotce větu píše sekundy: feed mezitím dosedne a zapíše `?g=`. Odeslání dřív závodí s tím zápisem (vada R1 v `hostile.md`).
    if (options.race !== true) await page.waitForURL(/\?g=/, { timeout: 30_000 }).catch(() => undefined);
    await field.fill(text);
    row.typedChars = (await field.inputValue()).length;
    const posted = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/play/games' && response.request().method() === 'POST', { timeout: 120_000 }).catch(() => null);
    const clicked = Date.now();
    await page.getByTestId('play-create').click();
    const outcome = await Promise.race([
      page.waitForURL(GAME_URL, { timeout: 120_000 }).then(() => 'navigated'),
      page.getByTestId('play-create-error').waitFor({ timeout: 120_000 }).then(() => 'toast'),
      page.getByTestId('play-vague').waitFor({ timeout: 120_000 }).then(() => 'vague'),
    ]).catch((error) => `timeout: ${String(error).split('\n')[0].slice(0, 120)}`);
    row.outcome = outcome;
    row.outcomeMs = Date.now() - clicked;
    if (outcome !== 'vague') {
      const response = await Promise.race([posted, sleep(5_000).then(() => null)]);
      if (response !== null) {
        const body = await response.json().catch(() => ({}));
        row.post = { status: response.status(), code: body.error?.code ?? null, message: body.error?.message ?? null, honesty: body.honesty?.reason ?? null, closest: body.honesty?.closest ?? null };
      }
    }
    if (outcome === 'toast') row.shown = (await page.getByTestId('play-create-error').innerText()).replace(/\s*Try again\s*$/, '').trim();
    if (outcome === 'vague') row.shown = (await page.getByTestId('play-vague').innerText()).trim();
    if (outcome === 'navigated') {
      row.versionId = page.url().match(/\/play\/([a-f0-9]+)/)?.[1] ?? null;
      const game = await (await fetch(`${base}/api/play/games/${row.versionId}`, { cache: 'no-store' })).json().catch(() => ({}));
      const published = game.game ?? game;
      row.title = published.version?.title ?? published.title ?? null;
      row.genre = published.spec?.genre?.id ?? null;
      row.chain = published.chain !== undefined;
      const ready = await page.waitForFunction(() => window.__playShell !== undefined && document.querySelector('canvas') !== null, undefined, { timeout: 90_000 }).then(() => true).catch(() => false);
      row.ready = ready;
      row.readyMs = Date.now() - clicked;
      row.honesty = (await page.getByTestId('play-honest-reason').first().innerText({ timeout: 2_000 }).catch(() => null))?.trim() ?? null;
      if (ready) {
        await page.evaluate(() => window.__playShell.start());
        await sleep(2_500);
        if (await page.getByTestId('play-first-prompt').isVisible().catch(() => false)) {
          const stage = await page.locator('[data-testid="arcade-stage"], [data-testid="play-grid-stage"]').first().boundingBox();
          if (stage !== null) await page.mouse.click(stage.x + stage.width / 2, stage.y + stage.height * 0.6);
          row.tapped = true;
          await sleep(2_000);
        }
        const stage = page.locator('[data-testid="arcade-stage"], [data-testid="play-grid-stage"]').first();
        const box = await stage.boundingBox().catch(() => null);
        row.stage = box === null ? null : await stage.getAttribute('data-testid');
        const png = await page.screenshot(box === null ? {} : { clip: box });
        row.look = variety(PNG.sync.read(png));
        row.blank = isBlank(row.look);
        row.shot = `${entry.id}.jpg`;
        await page.screenshot({ path: join(shots, row.shot), type: 'jpeg', quality: 60 });
        row.witness = (await page.evaluate(() => window.__playShell.playWitness()).catch((error) => ({ runState: `error: ${String(error).slice(0, 80)}` }))).runState;
      } else {
        row.pageText = (await page.locator('main').first().innerText({ timeout: 2_000 }).catch(() => '')).slice(0, 200);
        row.shot = `${entry.id}-noshell.jpg`;
        await page.screenshot({ path: join(shots, row.shot), type: 'jpeg', quality: 60 });
      }
    } else {
      row.shot = `${entry.id}-form.jpg`;
      await page.screenshot({ path: join(shots, row.shot), type: 'jpeg', quality: 60 });
    }
  } catch (error) {
    row.error = String(error).split('\n')[0].slice(0, 240);
    await page.screenshot({ path: join(shots, `${entry.id}-error.jpg`), type: 'jpeg', quality: 60 }).catch(() => undefined);
  } finally {
    await ctx.close();
  }
  // Věta, kterou formulář nepošle celou (prázdná, přes délku pole): co by s ní udělaly dveře samy.
  if (row.typedChars !== text.length || text.trim() === '') row.api = await direct(base, text).catch((error) => ({ error: String(error).slice(0, 160) }));
  row.verdict = verdictOf(row);
  return row;
}

/** `game`: hra se načetla, scéna není prázdná, stránka bez chyby. `message`: hláška formuláře. Cokoli jiného `fail`. */
export function verdictOf(row) {
  if (row.error !== undefined || row.errors.length > 0) return 'fail';
  if (row.outcome === 'toast' || row.outcome === 'vague') return row.shown ? 'message' : 'fail';
  if (row.outcome === 'navigated' && row.ready && row.blank === false) return 'game';
  return 'fail';
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const options = args();
  if (typeof options.base !== 'string') throw new Error('needs --base <url>');
  const out = resolve(ROOT, typeof options.out === 'string' ? options.out : 'evals/play/p78');
  const shots = typeof options.shots === 'string' ? options.shots : join(out, 'shots');
  mkdirSync(shots, { recursive: true });
  const set = JSON.parse(readFileSync(join(ROOT, 'evals/play/p78/hostile.json'), 'utf8')).sentences;
  const only = typeof options.only === 'string' ? new Set(options.only.split(',')) : null;
  const file = join(out, 'hostile-run.json');
  const { chromium } = require('@playwright/test');
  const { PNG } = require('playwright-core/lib/utilsBundle');
  // GPU jako u porotce s počítačem: softwarové WebGL (SwiftShader) drží hlavní vlákno `/play` feedem a přechod na hru trvá desítky sekund.
  const gl = options.cpu === true ? ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] : ['--use-gl=angle', '--use-angle=d3d11', '--ignore-gpu-blocklist'];
  const browser = await chromium.launch({ args: ['--disable-features=OpenXR', ...gl] });
  const buildId = await (await fetch(`${options.base}/api/build-id`, { cache: 'no-store' })).text().catch(() => null);
  const rows = [];
  const save = () => writeFileSync(file, `${JSON.stringify({ base: options.base, buildId, measuredAt: new Date().toISOString(), rows }, null, 1)}\n`);
  let n = 1;
  try {
    for (const entry of set.filter((item) => only === null || only.has(item.id))) {
      const row = await one(browser, PNG, options.base, shots, entry, n, options);
      n += 1;
      rows.push(row);
      console.log(`${row.id}: ${row.verdict} ${row.outcome ?? ''} ${row.outcomeMs ?? '?'} ms${row.genre ? ` ${row.genre}` : ''}${row.title ? ` "${row.title}"` : ''}${row.shown ? ` «${row.shown}»` : ''}${row.honesty ? ` [${row.honesty}]` : ''}${row.look ? ` look ${row.look.colours}/${row.look.lumaSd}` : ''}${row.witness ? ` witness ${row.witness}` : ''}${row.errors.length ? ` ERR ${row.errors[0]}` : ''}${row.error ? ` ! ${row.error}` : ''}`);
      save();
      await sleep(1_000);
    }
  } finally {
    await browser.close();
  }
  save();
}
