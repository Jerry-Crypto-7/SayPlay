#!/usr/bin/env node
/**
 * P71E měřidlo modelů: věty z QA 5. 11. (flap, voyage, defense, hop, quest, žralok, „golf ball score“)
 * a pět vět s dalšími zvířaty vyfocené na telefonu 390×844 ve 3. sekundě ukázky robota. U každé
 * věty zapíše, které GLB scéna stáhla, každou odpověď sítě ≥ 400 a chyby stránky; s `--fps` i FPS
 * telefonu (`measureOnce`: Pixel 7, CPU 4×, d3d11, 10 s ukázky).
 *
 *   node evals/play/p71/models/shots.mjs --base http://127.0.0.1:3014 --out evals/play/p71/models/before [--only flap,voyage] [--fps]
 *
 * Jeden proces na server (paměť shots-concurrency-hangs-server); Chromium bez OpenXR.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { browser, publish } from '../../../../scripts/play/p70d-shots.mjs';
import { args, measureOnce, pixel7, settle } from '../../../../scripts/play-look-shots.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const ARCADE_HZ = 60;
const SECOND = 3;
const VIEWPORT = { width: 390, height: 844 };

/** `model` = co má být na snímku poznat. */
export const SCENES = [
  { id: 'flap', seed: 71501, model: 'bird', text: 'a tiny bird flaps through pipes' },
  { id: 'voyage', seed: 71502, model: 'pirate ship', text: 'a pirate ship sails across the stormy sea' },
  { id: 'defense', seed: 71503, model: 'dragon', text: 'a dragon defends its castle from knights' },
  { id: 'hop', seed: 71504, model: 'chicken', text: 'a chicken crosses the busy road' },
  { id: 'quest', seed: 71505, model: 'wizard', text: 'a wizard explores a dungeon to find the lost crown' },
  { id: 'shark', seed: 71506, model: 'shark', text: 'a shark hunts fish in the ocean' },
  { id: 'golf-ball', seed: 71507, model: 'golf ball and hole', text: 'golf ball score' },
  { id: 'cat', seed: 71508, model: 'cat', text: 'a cat runs through the city' },
  { id: 'dog', seed: 71509, model: 'dog', text: 'a dog jumps over fences in the park' },
  { id: 'frog', seed: 71510, model: 'frog', text: 'a frog hops across the pond' },
  { id: 'penguin', seed: 71511, model: 'penguin', text: 'a penguin slides across the ice' },
  { id: 'horse', seed: 71512, model: 'horse', text: 'a horse races across the farm' },
];

const tickTo = (page, tick) =>
  page.evaluate((target) => {
    let state = window.__playShell.tickByHand();
    while (state.tick < target && state.runState === 'running') state = window.__playShell.tickByHand();
    return state;
  }, tick);

const HIDE = { content: '.play-demo-note, .play-honest { display: none !important; }' };

async function main() {
  const options = args();
  if (typeof options.base !== 'string') throw new Error('needs --base <url>');
  const out = resolve(ROOT, typeof options.out === 'string' ? options.out : 'evals/play/p71/models/after');
  mkdirSync(out, { recursive: true });
  const only = typeof options.only === 'string' ? new Set(options.only.split(',')) : null;
  const scenes = SCENES.filter((scene) => only === null || only.has(scene.id));
  const chromium = await browser(true);
  const { viewport: _viewport, deviceScaleFactor: _scale, ...phone } = pixel7();
  const rows = [];
  try {
    for (const scene of scenes) {
      const context = await chromium.newContext({ ...phone, viewport: VIEWPORT, deviceScaleFactor: 1 });
      const page = await context.newPage();
      const glb = [];
      const failed = [];
      const errors = [];
      page.on('response', (response) => {
        const url = response.url();
        if (url.endsWith('.glb')) glb.push(new URL(url).pathname);
        if (response.status() >= 400) failed.push(`${response.status()} ${new URL(url).pathname}`);
      });
      page.on('pageerror', (error) => errors.push(error.message.slice(0, 200)));
      try {
        const game = await publish(options.base, scene);
        await page.goto(`${options.base}/play/${game.versionId}`, { timeout: 120_000 });
        await page.locator('canvas').first().waitFor({ timeout: 60_000 });
        await settle(page);
        await page.waitForFunction(() => typeof window.__playShell?.byHand === 'function', undefined, { timeout: 30_000 });
        await page.evaluate(() => window.__playShell.byHand(true));
        await page.getByTestId('play-pause').click();
        await page.getByTestId('play-demo-start').click({ timeout: 30_000 });
        await page.addStyleTag(HIDE);
        const state = await tickTo(page, SECOND * ARCADE_HZ);
        const render = await settle(page);
        await sleep(1500);
        await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
        const file = `${scene.id}.png`;
        await page.screenshot({ path: join(out, file), timeout: 120_000 });
        const row = { ...scene, ...game, file, tick: state.tick, runState: state.runState, calls: render.calls, glb: [...new Set(glb)].sort(), failed, errors };
        if (options.fps === true) Object.assign(row, await measureOnce(chromium, options.base, game.versionId));
        rows.push(row);
        console.log(`${scene.id}: ${game.genre ?? '?'}/${game.control ?? '?'} ${row.glb.length} GLB, ${failed.length} chyb sítě${row.fps === undefined ? '' : `, ${Math.round(row.fps)} FPS`}${errors.length > 0 ? `, ${errors.length} chyb stránky` : ''}`);
      } catch (error) {
        rows.push({ ...scene, error: String(error).slice(0, 300), glb: [...new Set(glb)].sort(), failed, errors });
        console.log(`${scene.id}: CHYBA ${String(error).slice(0, 200)}`);
      } finally {
        await context.close();
      }
    }
  } finally {
    await chromium.close();
  }
  writeFileSync(join(out, 'manifest.json'), `${JSON.stringify({ viewport: '390x844', second: SECOND, renderer: 'd3d11', takenAt: new Date().toISOString(), rows }, null, 1)}\n`);
}

await main();
