#!/usr/bin/env node
/**
 * P70D měřidlo vzhledu: 8 referenčních scén (pevná věta + pevné semínko) vyfocených ve 3. a 10. sekundě
 * na 430×900 (telefon, celá obrazovka i s HUD) a FPS telefonu (Pixel 7, CPU 4×, d3d11) – T1 baseline,
 * T5 stejné věty, semínka a časy nad `main` po T2–T4.
 *
 *   node scripts/play/p70d-shots.mjs shots --base http://127.0.0.1:3204 --out evals/play/p70d/baseline [--only runner-forest,minigolf] [--viewport 375x667]
 *   node scripts/play/p70d-shots.mjs fps --base <url> --out evals/play/p70d/baseline/fps.json [--repeats 3]
 *   node scripts/play/p70d-shots.mjs fps --base <před> --out before.json --vs <po> --out-vs after.json   (A/B prokládaně, T5)
 *
 * Čas je čas simulace: ukázka robota běží na ručních hodinách (`__playShell.byHand`), 3 s = 180 tiků
 * (`ARCADE_HZ` 60). Po odtikání hodiny stojí a snímek čeká, až kamera dojede a modely se dotáhnou.
 * Hra, která skončí dřív než v 10. s, se vyfotí na svém posledním tiku (`runState` v manifestu).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { args, measureOnce, median, pixel7, settle } from '../play-look-shots.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(import.meta.url);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const writeJson = (path, value) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 1)}\n`);
};

const ARCADE_HZ = 60;
/** Snímek ve 3. a 10. sekundě hry (AC T1). */
export const SECONDS = [3, 10];
export const VIEWPORT = { width: 430, height: 900 };

/**
 * Osm referenčních scén P70D (runner les, runner sníh, aréna, platformer pláž, minigolf, railfps, catch, defense).
 * `stage` = ovládání plochy (`data-control`), `genre` = žánr hry – měřidlo jen ohlásí, když věta spadne jinam.
 */
export const SCENES = [
  { id: 'runner-forest', genre: 'runner', stage: 'runner', seed: 70401, text: 'A fox runs through a forest away from a bear' },
  { id: 'runner-snow', genre: 'runner', stage: 'runner', seed: 70402, text: 'A penguin runs across the snow away from a polar bear' },
  { id: 'arena', genre: 'arena', stage: 'move_free', seed: 70403, text: 'Collect ten acorns in a forest while avoiding a fox' },
  { id: 'platformer-beach', genre: 'platformer', stage: 'platform', seed: 70404, text: 'A crab jumps over rocks on a sunny beach' },
  { id: 'minigolf', genre: 'minigolf', stage: null, seed: 70405, text: 'short golf course on a farm, ball has to roll under the tractor and past bouncy hay bales to the hole' },
  { id: 'railfps', genre: 'railfps', stage: null, seed: 70406, text: 'make a game where i ride a mine cart through a crystal cave and shoot bats coming at me from both sides' },
  { id: 'catch', genre: 'catch', stage: 'lanes', seed: 70407, text: 'a raccoon catches falling apples in a bucket' },
  { id: 'defense', genre: 'defense', stage: 'lanes', seed: 70408, text: 'a knight defends the castle gate from skeleton armies' },
];

/**
 * Co hráč na snímku nevidí: karta ukázky robota existuje jen kvůli měření a hlášku poctivosti
 * hráč odklikne „Got it“. HUD (počítadla, přepínač Quick/Full) zůstává – T3 na něm měří překryv.
 */
const MEASURING_ONLY = { content: '.play-demo-note, .play-honest { display: none !important; }' };

const chosen = (options) => {
  const only = typeof options.only === 'string' ? new Set(options.only.split(',')) : null;
  return SCENES.filter((scene) => only === null || only.has(scene.id));
};

/** Chromium bez OpenXR: SteamVR na tomhle PC jinak z telefonu udělá brýle (paměť chromium-vr-via-steamvr). */
export async function browser(gpu) {
  const { chromium } = require('@playwright/test');
  const angle = gpu ? ['--use-gl=angle', '--use-angle=d3d11', '--ignore-gpu-blocklist'] : ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'];
  return chromium.launch({ args: [...angle, '--disable-features=OpenXR'] });
}

/** Rychlá verze věty s pevným semínkem; vrací id verze a co z věty vyšlo. */
export async function publish(base, scene) {
  const response = await fetch(`${base}/api/play/games`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sentence: scene.text, seed: scene.seed }) });
  const created = await response.json();
  if (!created.versionId) throw new Error(`${scene.id}: POST ${response.status} ${JSON.stringify(created).slice(0, 200)}`);
  const body = await (await fetch(`${base}/api/play/games/${created.versionId}`, { cache: 'no-store' })).json();
  const game = body.game ?? body;
  return { versionId: created.versionId, chain: game.chain !== undefined, genre: game.spec?.genre?.id ?? null, control: game.spec?.control ?? null, setting: game.spec?.theme?.setting ?? null };
}

/** Odtiká ruční hodiny na `tick`; vrací stav na posledním tiku (dřív, když hra skončí). */
const tickTo = (page, tick) =>
  page.evaluate((target) => {
    let state = window.__playShell.tickByHand();
    while (state.tick < target && state.runState === 'running') state = window.__playShell.tickByHand();
    return state;
  }, tick);

async function shots(options) {
  const base = options.base;
  if (typeof base !== 'string') throw new Error('shots needs --base <url>');
  const out = resolve(ROOT, typeof options.out === 'string' ? options.out : 'evals/play/p70d/baseline');
  mkdirSync(out, { recursive: true });
  const chromium = await browser(options.gpu === true);
  const { viewport: _viewport, deviceScaleFactor: _scale, ...phone } = pixel7();
  // `--viewport 375x667` (P70D T3: přepínač verzí proti počítadlům na malém telefonu); výchozí `VIEWPORT`.
  const [width, height] = typeof options.viewport === 'string' ? options.viewport.split('x').map(Number) : [VIEWPORT.width, VIEWPORT.height];
  const viewport = { width, height };
  const manifest = { viewport: `${width}x${height}`, renderer: options.gpu === true ? 'd3d11' : 'swiftshader', seconds: SECONDS, hz: ARCADE_HZ, takenAt: new Date().toISOString(), shots: [] };
  try {
    for (const scene of chosen(options)) {
      const context = await chromium.newContext({ ...phone, viewport, deviceScaleFactor: 1 });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message.slice(0, 200)));
      try {
        const game = await publish(base, scene);
        await page.goto(`${base}/play/${game.versionId}`, { timeout: 120_000 });
        await page.locator('canvas').first().waitFor({ timeout: 60_000 });
        await settle(page);
        await page.waitForFunction(() => typeof window.__playShell?.byHand === 'function', undefined, { timeout: 30_000 });
        await page.evaluate(() => window.__playShell.byHand(true));
        await page.getByTestId('play-pause').click();
        await page.getByTestId('play-demo-start').click({ timeout: 30_000 });
        await page.addStyleTag(MEASURING_ONLY);
        const stage = await page.getByTestId('arcade-stage').first().getAttribute('data-control').catch(() => null);
        const frames = [];
        for (const second of SECONDS) {
          const state = await tickTo(page, second * ARCADE_HZ);
          const render = await settle(page);
          // Kamera dojede k hrdinovi, který stojí: hodiny jsou ruční a nikdo netiká.
          await sleep(1500);
          await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
          const file = `${scene.id}-${String(second).padStart(2, '0')}s.png`;
          await page.screenshot({ path: join(out, file), timeout: 120_000 });
          frames.push({ second, file, tick: state.tick, runState: state.runState, meshes: render.meshes, calls: render.calls });
        }
        const off = scene.stage !== null && stage !== scene.stage;
        manifest.shots.push({ ...scene, ...game, wantStage: scene.stage, stage, frames, errors });
        console.log(`${scene.id}: ${game.genre ?? '?'}/${game.setting ?? '?'} plocha ${stage}${off ? `  ! čekaná ${scene.stage}` : ''} – ${frames.map((frame) => `${frame.second}s tik ${frame.tick} ${frame.runState} ${frame.calls} volání`).join(', ')}${errors.length > 0 ? `, ${errors.length} chyb` : ''}`);
      } finally {
        await context.close();
      }
    }
  } finally {
    await chromium.close();
  }
  writeJson(join(out, 'manifest.json'), manifest);
}

/**
 * FPS telefonu (`measureOnce` z P54B: Pixel 7, CPU 4×, 10 s ukázky). S `--vs` prokládaně A B, B A, …
 * scénu po scéně – stroj nikdy nebude v klidu (paměť perf-measure-interleaved-no-calm).
 */
async function fps(options) {
  if (typeof options.base !== 'string') throw new Error('fps needs --base <url>');
  const bases = typeof options.vs === 'string' ? [options.base, options.vs] : [options.base];
  const repeats = Number(options.repeats ?? 3);
  const scenes = chosen(options);
  const chromium = await browser(true);
  const rows = bases.map(() => []);
  try {
    // Zahřátí: první stránka čerstvého prohlížeče překládá shadery (13. 10.: 0,2 FPS), ne scénu.
    for (const url of bases) {
      const warm = await chromium.newPage();
      await warm.goto(`${url}/play/${(await publish(url, scenes[0])).versionId}`);
      await warm.locator('canvas').first().waitFor({ timeout: 60_000 });
      await settle(warm);
      await warm.close();
    }
    for (const scene of scenes) {
      const games = await Promise.all(bases.map((url) => publish(url, scene)));
      const samples = bases.map(() => []);
      const calls = bases.map(() => null);
      const qualities = bases.map(() => []);
      for (let run = 0; run < repeats; run += 1) {
        const order = run % 2 === 0 ? [...bases.entries()] : [...bases.entries()].reverse();
        for (const [index, url] of order) {
          const measured = await measureOnce(chromium, url, games[index].versionId);
          samples[index].push(measured.fps);
          calls[index] = measured.calls;
          qualities[index].push(measured.quality);
        }
      }
      for (const [index, url] of bases.entries()) {
        const row = { id: scene.id, genre: games[index].genre, fpsMedian: Math.round(median(samples[index]) * 10) / 10, samples: samples[index].map((value) => Math.round(value * 10) / 10), quality: qualities[index], calls: calls[index] };
        rows[index].push(row);
        console.log(`${scene.id}${bases.length > 1 ? ` [${url}]` : ''}: ${row.fpsMedian} FPS (${row.samples.join(' ')}), ${row.calls} volání`);
      }
    }
  } finally {
    await chromium.close();
  }
  const reports = bases.map((url, index) => ({ profile: 'Pixel 7, CPU 4x, d3d11, OpenXR off', base: url, interleavedWith: bases.length > 1 ? bases[1 - index] : undefined, repeats, windowMs: 10_000, measuredAt: new Date().toISOString(), rows: rows[index] }));
  if (typeof options.out === 'string') writeJson(resolve(ROOT, options.out), reports[0]);
  if (reports[1] !== undefined && typeof options['out-vs'] === 'string') writeJson(resolve(ROOT, options['out-vs']), reports[1]);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const options = args();
  const command = { shots, fps }[options._[0]];
  if (command === undefined) {
    console.error('usage: p70d-shots.mjs shots|fps --base <url> …');
    process.exit(2);
  }
  await command(options);
}
