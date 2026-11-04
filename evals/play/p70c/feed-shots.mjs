#!/usr/bin/env node
/**
 * Prvních 12 karet feedu na telefonu (P70C T4, AC 4): `/play` s prázdným úložištěm ukáže vestavěnou sadu; skript
 * počká na každé kartě na běžící náhled robota (tik roste), vyfotí obrazovku do `evals/play/p70c/feed/NN-…png`,
 * změří plátno (průměr a rozptyl jasu – prázdná nebo černá karta má rozptyl u nuly; podíl pixelů, které se za
 * 0,6 s změnily) a ťukem na „Next“ jde na další kartu. Pak na téže stránce zkusí minigolf (`--pause`): pauza před
 * prvním dotekem, list „About this game“ – karta před startem nesmí prosvítat a řádek Controls nesmí jmenovat klávesy.
 *
 *   PLAY_URL=http://127.0.0.1:3203 node --experimental-strip-types evals/play/p70c/feed-shots.mjs
 *
 * Jeden proces prohlížeče proti serveru (dva souběžné ho zaseknou). Server musí běžet z buildu se stejnou
 * vestavěnou sadou. Výsledek: `evals/play/p70c/feed/report.json`.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { chromium, devices } from '@playwright/test';
import sharp from 'sharp';

await import('../../../scripts/ts-paths.mjs');
const { browserRenderer } = await import('../../../scripts/browser-renderer.ts');

const ROOT = new URL('../../../', import.meta.url);
const OUT = 'evals/play/p70c/feed';
/** Cesta souboru ve výstupu jako text – `page.screenshot` adresu `URL` nebere. */
const shotPath = (name) => fileURLToPath(new URL(`${OUT}/${name}`, ROOT));
const BASE = process.env.PLAY_URL ?? 'http://127.0.0.1:3203';
const CARDS = 12;
/** Prázdné nebo černé plátno: rozptyl jasu pod touto mezí, nebo průměr pod mezí tmy. */
const MIN_STDEV = 6;
const MIN_MEAN = 12;
/** Klávesy, které telefon nemá (P70C, vada z prohlížeče 4. 11.). */
const KEY_NAMES = /\bSpace\b|Keys:|\bWASD\b|\bF J K\b|\bEsc\b|\bShift\b|\barrow keys?\b/i;

mkdirSync(new URL(`${OUT}/`, ROOT), { recursive: true });
const { defaultBrowserType: _browser, ...pixel7 } = devices['Pixel 7'];
const browser = await chromium.launch({ args: [...browserRenderer().args, '--disable-features=OpenXR'] });
const context = await browser.newContext({ ...pixel7, viewport: { width: 430, height: 900 }, deviceScaleFactor: 1, hasTouch: true, isMobile: true });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(String(error)));

const probe = () => page.evaluate(() => window.__playFeed?.() ?? null);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, ms, what) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = await check();
    if (value) return value;
    await sleep(250);
  }
  throw new Error(`timed out: ${what}`);
}

/** Jas plátna: průměr a směrodatná odchylka přes kanály RGB. */
async function lumaOf(png) {
  const stats = await sharp(png).removeAlpha().stats();
  const rgb = stats.channels.slice(0, 3);
  return { mean: rgb.reduce((sum, c) => sum + c.mean, 0) / 3, stdev: rgb.reduce((sum, c) => sum + c.stdev, 0) / 3 };
}

/** Podíl pixelů, jejichž jas se mezi dvěma snímky změnil o víc než 16. */
async function changedShare(a, b) {
  const [x, y] = await Promise.all([a, b].map((png) => sharp(png).greyscale().raw().toBuffer({ resolveWithObject: true })));
  if (x.info.width !== y.info.width || x.info.height !== y.info.height) return 1;
  let changed = 0;
  for (let i = 0; i < x.data.length; i += 1) if (Math.abs(x.data[i] - y.data[i]) > 16) changed += 1;
  return changed / x.data.length;
}

const slug = (title) => title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const cards = [];
await page.goto(`${BASE}/play`);
await page.getByTestId('feed-current').waitFor({ timeout: 60_000 });
await page.evaluate(() => document.querySelector('[data-testid="feed-reel"]')?.scrollIntoView({ block: 'start' }));
let previous = null;
for (let n = 0; n < CARDS; n += 1) {
  const now = await until(async () => {
    const p = await probe();
    return p !== null && p.versionId !== previous && p.mode === 'preview' ? p : null;
  }, 60_000, `card ${String(n)} preview`);
  // Tik roste = náhled hraje; karta dosedla v okně feedu.
  await until(async () => ((await probe())?.tick ?? 0) > now.tick, 10_000, `card ${String(n)} tick`);
  await sleep(1_200);
  const current = page.getByTestId('feed-current');
  const title = (await page.locator('[data-testid="feed-card"][data-active="true"]').getAttribute('aria-label')) ?? `card-${String(n)}`;
  const canvas = current.locator('canvas').first();
  const a = await canvas.screenshot({ type: 'png' });
  await sleep(600);
  const b = await canvas.screenshot({ type: 'png' });
  const file = `${String(n + 1).padStart(2, '0')}-${slug(title)}.png`;
  await page.screenshot({ path: shotPath(file), scale: 'css' });
  const luma = await lumaOf(b);
  const control = await current.getByTestId('arcade-stage').getAttribute('data-control');
  const card = { n: n + 1, versionId: now.versionId, title, control, mode: (await probe())?.mode, mean: Math.round(luma.mean), stdev: Math.round(luma.stdev), changed: Number((await changedShare(a, b)).toFixed(4)), blank: luma.stdev < MIN_STDEV || luma.mean < MIN_MEAN, screenshot: file };
  cards.push(card);
  console.log(JSON.stringify(card));
  previous = now.versionId;
  if (n < CARDS - 1) await page.getByTestId('feed-next').tap();
}

/** Minigolf z feedu: pauza před prvním dotekem, pak „About this game“. */
const golf = await page.evaluate(async () => {
  const response = await fetch('/api/play/games?recent=48');
  const body = await response.json();
  return body.games.find((game) => /mini golf/i.test(game.title)) ?? null;
});
let pause = null;
if (golf !== null) {
  await page.goto(`${BASE}/play/${golf.versionId}`);
  const stage = page.getByTestId('arcade-stage').first();
  await stage.waitFor({ timeout: 60_000 });
  await until(() => page.evaluate(() => window.__playShell?.physicsReady?.() ?? true), 60_000, 'physics');
  const prompt = page.getByTestId('play-first-prompt');
  await prompt.waitFor({ timeout: 30_000 });
  await page.screenshot({ path: shotPath('golf-1-start-card.png'), scale: 'css' });
  await page.getByTestId('play-pause').tap();
  await page.getByTestId('play-paused').waitFor({ timeout: 10_000 });
  const pauseControls = (await page.getByTestId('play-controls').count()) > 0 ? await page.getByTestId('play-controls').innerText() : null;
  const promptOverPause = await prompt.isVisible().catch(() => false);
  await page.screenshot({ path: shotPath('golf-2-paused.png'), scale: 'css' });
  const about = page.getByTestId('play-info');
  const hasAbout = (await about.count()) > 0;
  let sheetControls = null;
  let promptOverSheet = null;
  if (hasAbout) {
    await about.tap();
    const sheet = page.locator('.play-info-sheet');
    await sheet.waitFor({ timeout: 10_000 });
    await sleep(500);
    sheetControls = await sheet.locator('dl.play-lab-rows > div').filter({ has: page.locator('dt', { hasText: 'Controls' }) }).locator('dd').innerText().catch(() => null);
    promptOverSheet = (await page.getByTestId('play-first-prompt').count()) > 0 && (await page.getByTestId('play-first-prompt').isVisible());
    await page.screenshot({ path: shotPath('golf-3-about.png'), scale: 'css' });
  }
  pause = {
    versionId: golf.versionId,
    title: golf.title,
    pauseControls,
    promptOverPause,
    hasAbout,
    sheetControls,
    promptOverSheet,
    keyNames: [pauseControls, sheetControls].filter((text) => text !== null && KEY_NAMES.test(text)),
  };
  console.log(JSON.stringify(pause));
}

await browser.close();
const report = { at: new Date().toISOString(), base: BASE, viewport: '430x900 touch (Pixel 7 UA)', cards, blank: cards.filter((card) => card.blank).map((card) => card.n), pause, errors };
writeFileSync(new URL(`${OUT}/report.json`, ROOT), `${JSON.stringify(report, null, 2)}\n`);
console.log(`cards ${String(cards.length)}, blank ${JSON.stringify(report.blank)}, page errors ${String(errors.length)}`);
process.exit(0);
