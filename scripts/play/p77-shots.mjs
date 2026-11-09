#!/usr/bin/env node
/**
 * P77 fotky scén: stejné věty, semínka a okamžiky jako `p73d-shots.mjs` (desktop 1440×900, telefon 390×844,
 * ukázka robota na ručních hodinách, start + 3. a 8. s), takže snímky jdou rovnou do `p75-judge.mjs` a listů.
 * Navíc `--no-hud`: těsně před každým snímkem skryje všechno DOM nad plátnem scény (HUD, štítky ve světě,
 * přepínač verze) a hned potom ho vrátí – jen pro fotku, hra se nemění (P77 T1, „kolik dělá rozhraní“).
 *
 *   node scripts/play/p77-shots.mjs --port 3208 --out evals/play/p77/base [--only s1,s4] [--viewports desktop] [--no-hud]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { args, settle } from '../play-look-shots.mjs';
import { MOMENTS, SENTENCES } from './p73d-shots.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(import.meta.url);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const ARCADE_HZ = 60;

const VIEWPORTS = {
  desktop: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 },
  phone: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true },
};

/** Karta ukázky robota a hláška poctivosti existují jen kvůli měření (jako P73D). */
const MEASURING_ONLY = { content: '.play-demo-note, .play-honest { display: none !important; }' };
/**
 * Schová všechno DOM nad plátnem scény: u každého předka plátna děti, které plátno neobsahují a jeho obdélník
 * překrývají (HUD `GameHud` je sourozenec scény, ne její dítě). Déšť a sníh (`.play-weather`) patří ke scéně.
 * `visibility` drží rozvržení, takže výřez soudce sedí. Vrací funkci, která vše vrátí.
 */
const hideOverlays = (page) =>
  page.evaluate(() => {
    const canvas = document.querySelector('[data-testid="arcade-stage"] canvas');
    if (canvas === null) return 0;
    const box = canvas.getBoundingClientRect();
    const hidden = [];
    for (let node = canvas; node.parentElement !== null; node = node.parentElement) {
      for (const sibling of node.parentElement.children) {
        if (sibling === node || sibling.classList.contains('play-weather')) continue;
        const rect = sibling.getBoundingClientRect();
        const over = rect.right > box.left && rect.left < box.right && rect.bottom > box.top && rect.top < box.bottom;
        if (over && getComputedStyle(sibling).visibility !== 'hidden') hidden.push(sibling);
      }
    }
    for (const element of hidden) element.style.setProperty('visibility', 'hidden', 'important');
    window.__p77Hidden = hidden;
    return hidden.length;
  });

const showOverlays = (page) =>
  page.evaluate(() => {
    for (const element of window.__p77Hidden ?? []) element.style.removeProperty('visibility');
    window.__p77Hidden = [];
  });

async function publish(base, sentence) {
  const response = await fetch(`${base}/api/play/games`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sentence: sentence.text, seed: sentence.seed }) });
  const created = await response.json();
  if (!created.versionId) throw new Error(`${sentence.id}: POST ${response.status} ${JSON.stringify(created).slice(0, 200)}`);
  const body = await (await fetch(`${base}/api/play/games/${created.versionId}`, { cache: 'no-store' })).json();
  const game = body.game ?? body;
  return { versionId: created.versionId, genre: game.spec?.genre?.id ?? null, setting: game.spec?.theme?.setting ?? null };
}

const tickTo = (page, tick) =>
  page.evaluate((target) => {
    let state = window.__playShell.tickByHand();
    while (state.tick < target && state.runState === 'running') state = window.__playShell.tickByHand();
    return state;
  }, tick);

async function frame(page, path, noHud) {
  await settle(page);
  await sleep(1500);
  if (noHud) await hideOverlays(page);
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
  await page.screenshot({ path, type: 'jpeg', quality: 78, timeout: 120_000 });
  if (noHud) await showOverlays(page);
}

async function shoot(browser, base, out, sentence, vp, noHud) {
  const context = await browser.newContext(VIEWPORTS[vp]);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message.slice(0, 200)));
  const row = { id: sentence.id, vp, frames: [], errors };
  try {
    Object.assign(row, await publish(base, sentence));
    await page.goto(`${base}/play/${row.versionId}`, { timeout: 120_000 });
    await page.locator('canvas').first().waitFor({ timeout: 60_000 });
    await page.waitForFunction(() => typeof window.__playShell?.byHand === 'function', undefined, { timeout: 60_000 });
    await page.evaluate(() => window.__playShell.byHand(true));
    await page.addStyleTag(MEASURING_ONLY);
    const stage = page.getByTestId('arcade-stage').first();
    row.look = await stage.getAttribute('data-look').catch(() => null);
    for (const moment of MOMENTS) {
      if (moment.second > 0 && row.frames.length === 1) {
        await page.getByTestId('play-pause').click();
        await page.getByTestId('play-demo-start').click({ timeout: 30_000 });
      }
      const state = moment.second > 0 ? await tickTo(page, moment.second * ARCADE_HZ) : null;
      const file = `${sentence.id}-${vp}-${moment.id}.jpg`;
      await frame(page, join(out, file), noHud);
      row.frames.push({ moment: moment.id, file, tick: state?.tick ?? 0, runState: state?.runState ?? 'ready' });
    }
    row.quality = await stage.getAttribute('data-quality').catch(() => null);
  } catch (error) {
    row.error = String(error).slice(0, 300);
  } finally {
    await context.close();
  }
  console.log(`${sentence.id} ${vp}: ${row.genre ?? '?'}/${row.setting ?? '?'} look ${row.look ?? '?'} q ${row.quality ?? '?'}${row.error ? `  ! ${row.error}` : ''}${errors.length > 0 ? `, ${errors.length} chyb` : ''}`);
  return row;
}

async function main() {
  const options = args();
  const port = Number(options.port);
  if (!Number.isInteger(port)) throw new Error('needs --port <n>');
  if (typeof options.out !== 'string') throw new Error('needs --out <dir>');
  const out = resolve(ROOT, options.out);
  mkdirSync(out, { recursive: true });
  const only = typeof options.only === 'string' ? new Set(options.only.split(',')) : null;
  const viewports = typeof options.viewports === 'string' ? options.viewports.split(',') : Object.keys(VIEWPORTS);
  const noHud = options['no-hud'] === true;
  const { chromium } = require('@playwright/test');
  // Bez OpenXR (SteamVR jinak z telefonu udělá brýle), GPU přes ANGLE/GL jako P73D.
  const browser = await chromium.launch({ args: ['--disable-features=OpenXR', '--use-angle=gl', '--ignore-gpu-blocklist'] });
  const rows = [];
  try {
    for (const sentence of SENTENCES.filter((item) => only === null || only.has(item.id))) {
      for (const vp of viewports) rows.push(await shoot(browser, `http://127.0.0.1:${port}`, out, sentence, vp, noHud));
    }
  } finally {
    await browser.close();
  }
  writeFileSync(join(out, 'manifest.json'), `${JSON.stringify({ takenAt: new Date().toISOString(), noHud, hz: ARCADE_HZ, moments: MOMENTS, shots: rows }, null, 1)}\n`);
  const failed = rows.filter((row) => row.error !== undefined).length;
  console.log(`hotovo ${rows.length - failed}/${rows.length}`);
  if (failed > 0) process.exitCode = 1;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
