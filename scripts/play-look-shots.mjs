#!/usr/bin/env node
/**
 * Snímky vzhledu P46G: dvanáct vět (`evals/play/p46g/sentences.json`, 4 prostředí
 * × běžec, závod, skákačka) projde skutečnými dveřmi `POST /api/play/games`
 * (rychlá verze, server bez režiséra) a každá hra se vyfotí ve stejném tiku
 * ukázky robota. Tik je tik simulace, ne čas: ruční hodiny sondy
 * (`__playShell.byHand`) odtikají `--ticks` tiků záznamu robota, pak hodiny
 * stojí a snímek čeká, až se dotáhnou modely. Plátno bez textu stránky.
 * `--set genres` vezme místo nich jednu větu na žánr (`evals/play/p46g/genres.json`, P46G T7).
 *
 *   node scripts/play-look-shots.mjs shots --base http://127.0.0.1:3251 --out evals/play/p46g/before [--ticks 150] [--only forest-race,city-runner] [--gpu] [--set genres] [--profile pixel7]
 *   node scripts/play-look-shots.mjs diff <dirA> <dirB>
 *   node scripts/play-look-shots.mjs perf --base http://127.0.0.1:3251 --out evals/play/p46g/perf-before.json [--repeats 3] [--only …]
 *   node scripts/play-look-shots.mjs perf --base <před> --out before.json --vs <po> --out-vs after.json [--repeats 2]   (A/B prokládaně)
 *   node scripts/play-look-shots.mjs luma <dir> [--out luma.json]   (jas plátna, P56B)
 *   node scripts/play-look-shots.mjs feed --base <url> [--out feed.json]   (karty feedu s obrázkem /og, P56B)
 *   `--set p56b` = 12 vět auditu P56B (`evals/play/p56b/sentences.json`); sady jdou spojit čárkou (`--set p56b,genres`).
 *
 * `diff` porovná snímky dvou běhů pixel po pixelu (podíl pixelů, které se liší
 * o víc než 8 v některém kanálu) – opakovatelnost sady. `perf` měří FPS
 * v emulaci Pixel 7 se 4× pomalejším CPU, zatímco hraje ukázka robota
 * (vzor `e2e/p32-look.spec.ts`), a počet kreslicích volání ze sondy
 * `__playRender`. Na vytíženém stroji se porovnává jen A/B pustěné hned po sobě.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/** Sady mimo `evals/play/p46g/`: `p56b` = 12 vět auditu P56B (21. 10.). */
const SET_FILES = { p56b: join(ROOT, 'evals', 'play', 'p56b', 'sentences.json') };
/** Sada vět: `sentences` (12 vět T1, srovnání před a po), `genres` (věta na žánr, T7) nebo `p56b`; víc sad čárkou (`p56b,genres`). */
const sentencesOf = (set = 'sentences') => set.split(',').flatMap((name) => JSON.parse(readFileSync(SET_FILES[name] ?? join(ROOT, 'evals', 'play', 'p46g', `${name}.json`), 'utf8')).sentences);
export const TICKS = 150;
/** Kanálový rozdíl, pod kterým se pixel bere jako stejný (šum vyhlazování hran). */
const PIXEL_TOLERANCE = 8;

const require = createRequire(import.meta.url);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const writeJson = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 1)}\n`);
const SCENE_ONLY = { content: 'body * { visibility: hidden !important; } canvas { visibility: visible !important; }' };
const GENRE_OF_CONTROL = { runner: 'runner', platform: 'platformer', steer: 'race' };

function args() {
  const out = { _: [] };
  const list = process.argv.slice(2);
  for (let i = 0; i < list.length; i += 1) {
    if (list[i].startsWith('--')) out[list[i].slice(2)] = list[i + 1]?.startsWith('--') === false ? list[++i] : true;
    else out._.push(list[i]);
  }
  return out;
}

const chosen = (options) => {
  const only = typeof options.only === 'string' ? new Set(options.only.split(',')) : null;
  return sentencesOf(typeof options.set === 'string' ? options.set : undefined).filter((sentence) => only === null || only.has(sentence.id));
};

async function browserFor(gpu) {
  const { chromium } = require('@playwright/test');
  const angle = gpu ? ['--use-gl=angle', '--use-angle=d3d11', '--ignore-gpu-blocklist'] : ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'];
  return chromium.launch({ args: angle });
}

/** Kontext Playwrightu pro Pixel 7 (bez volby prohlížeče, ta jde z `browserFor`). */
function pixel7() {
  const { devices } = require('@playwright/test');
  const { defaultBrowserType: _browser, ...device } = devices['Pixel 7'];
  return device;
}

/** Rychlá verze věty; stejná věta dá stejnou hru (semínko z věty). */
async function publish(base, text) {
  const response = await fetch(`${base}/api/play/games`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sentence: text }) });
  const created = await response.json();
  if (!created.versionId) throw new Error(`POST ${response.status} ${JSON.stringify(created).slice(0, 200)}`);
  const body = await (await fetch(`${base}/api/play/games/${created.versionId}`, { cache: 'no-store' })).json();
  const spec = (body.game ?? body).spec;
  return { versionId: created.versionId, control: spec.control, genre: GENRE_OF_CONTROL[spec.control] ?? spec.control, setting: spec.theme?.setting ?? null };
}

/** Modely dotažené: počet sítí scény se `quietMs` nezměnil (jako `settledRender` v `e2e/p35-perf.spec.ts`). */
async function settle(page, quietMs = 1500) {
  await page.waitForFunction(() => window.__playRender !== undefined && window.__playRender().calls > 0, undefined, { timeout: 60_000 });
  let last = -1;
  let since = Date.now();
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const meshes = await page.evaluate(() => window.__playRender().meshes);
    if (meshes !== last) {
      last = meshes;
      since = Date.now();
    } else if (Date.now() - since >= quietMs) break;
    await sleep(250);
  }
  return page.evaluate(() => window.__playRender());
}

/** Ukázka robota odtikaná ručními hodinami do `ticks`; vrací tik, na kterém stojí. */
async function demoTo(page, ticks) {
  await page.waitForFunction(() => typeof window.__playShell?.byHand === 'function', undefined, { timeout: 30_000 });
  await page.evaluate(() => window.__playShell.byHand(true));
  await page.getByTestId('play-pause').click();
  await page.getByTestId('play-demo-start').click({ timeout: 30_000 });
  return page.evaluate((count) => {
    let state = null;
    for (let index = 0; index < count; index += 1) {
      state = window.__playShell.tickByHand();
      if (state.runState !== 'running') break;
    }
    return state;
  }, ticks);
}

async function shots(options) {
  const base = options.base;
  const out = resolve(ROOT, typeof options.out === 'string' ? options.out : 'evals/play/p46g/before');
  if (typeof base !== 'string') throw new Error('shots needs --base <url>');
  const ticks = Number(options.ticks ?? TICKS);
  mkdirSync(out, { recursive: true });
  const browser = await browserFor(options.gpu === true);
  // `--profile pixel7` (P54B T2): telefon – úzký dotykový pohled, scéna startuje na úrovni `low`.
  const phone = options.profile === 'pixel7';
  const page = phone ? await (await browser.newContext(pixel7())).newPage() : await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const manifest = { ticks, renderer: options.gpu === true ? 'd3d11' : 'swiftshader', viewport: phone ? 'Pixel 7' : '1280x800', shots: [] };
  // 404 na `/assets/` (P56B T1): chybějící model se kreslí jako náhradní kvádr a hra běží dál, na snímku to nikdo nepozná.
  const missing = [];
  page.on('response', (response) => {
    if (response.status() === 404 && response.url().includes('/assets/')) missing.push(new URL(response.url()).pathname);
  });
  // Chyby stránky a překladu shaderu (P56B T6): rozbitý patch shaderu nechá scénu kreslit dál bez materiálu.
  const errors = [];
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message.slice(0, 200)}`));
  page.on('console', (message) => {
    if (message.type() === 'error' && /THREE\.WebGLProgram|Shader Error|ERROR: \d+:/.test(message.text())) errors.push(`shader: ${message.text().slice(0, 200)}`);
  });
  try {
    for (const sentence of chosen(options)) {
      const missingBefore = missing.length;
      const errorsBefore = errors.length;
      const game = await publish(base, sentence.text);
      // Meze 120 s: SwiftShader kreslí na CPU a pod souběžnými běhy (CPU 100 %, 19. 10.) výchozích 30 s nestačí.
      await page.goto(`${base}/play/${game.versionId}`, { timeout: 120_000 });
      await page.locator('canvas').first().waitFor({ timeout: 60_000 });
      await settle(page);
      const state = await demoTo(page, ticks);
      await page.addStyleTag(SCENE_ONLY);
      const render = await settle(page);
      // Kamera dojede k hrdinovi, který stojí: hodiny jsou ruční a nikdo netiká.
      await sleep(1500);
      await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
      await page.screenshot({ path: join(out, `${sentence.id}.png`), timeout: 120_000 });
      // Ovládání, které plocha opravdu kreslí: souboj má ve specu `move_free`, ve hře `fight`.
      const stage = await page.getByTestId('arcade-stage').getAttribute('data-control').catch(() => null);
      const row = { id: sentence.id, text: sentence.text, want: sentence.genre, ...game, stage, tick: state?.tick ?? null, runState: state?.runState ?? null, meshes: render.meshes, calls: render.calls, assets404: missing.slice(missingBefore), errors: errors.slice(errorsBefore) };
      manifest.shots.push(row);
      // Sada `genres` čeká ovládání plochy (aréna, úkol i agar jsou `move_free`), sada T1 žánr; sada `p56b` nečeká nic.
      const [got, wanted] = sentence.control === undefined ? [game.genre, sentence.genre] : [stage, sentence.control];
      console.log(`${sentence.id}: ${game.genre}/${game.setting} tick ${row.tick} ${row.runState} – ${row.meshes} sítí, ${row.calls} volání, ${row.assets404.length}× 404, ${row.errors.length} chyb${wanted === undefined || got === wanted ? '' : `  ! čekané ${wanted}`}`);
    }
  } finally {
    await browser.close();
  }
  manifest.assets404 = missing.length;
  manifest.errors = errors.length;
  writeJson(join(out, 'manifest.json'), manifest);
}

/** Jas pod touto mezí (luma 0–1) je „černá“ – audit 21. 10.: noc skoro černá. */
const DARK = 0.04;

/** Střední luma Rec. 709 z hodnot sRGB (0–1) a podíl pixelů pod `DARK`. */
async function lumaOf(file) {
  const sharp = require('sharp');
  const { data } = await sharp(file).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  let sum = 0;
  let dark = 0;
  for (let i = 0; i < data.length; i += 3) {
    const y = (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) / 255;
    sum += y;
    if (y < DARK) dark += 1;
  }
  const pixels = data.length / 3;
  return { mean: sum / pixels, dark: dark / pixels };
}

/** `luma <dir> [--out file]` (P56B T1): jas plátna každého snímku – snímek je jen plátno (`SCENE_ONLY`). */
async function luma(options) {
  const dir = options._[1];
  if (dir === undefined) throw new Error('luma needs <dir>');
  const rows = [];
  for (const file of readdirSync(resolve(ROOT, dir)).filter((name) => name.endsWith('.png')).sort()) {
    const { mean, dark } = await lumaOf(join(resolve(ROOT, dir), file));
    rows.push({ id: file.slice(0, -4), mean: Math.round(mean * 1000) / 1000, dark: Math.round(dark * 1000) / 1000 });
    console.log(`${file}: jas ${mean.toFixed(3)}, pod ${DARK} ${(dark * 100).toFixed(1)} %`);
  }
  if (typeof options.out === 'string') writeJson(resolve(ROOT, options.out), { dark: DARK, rows });
  return rows;
}

/** `feed --base <url>` (P56B T1): kolik obrázků karet feedu na `/play` je obrázek odkazu `/og` místo snímku hry. */
async function feed(options) {
  const base = options.base;
  if (typeof base !== 'string') throw new Error('feed needs --base <url>');
  const browser = await browserFor(options.gpu === true);
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(`${base}/play`, { timeout: 120_000 });
    await page.getByTestId('feed-card').first().waitFor({ timeout: 60_000 });
    const sources = await page.$$eval('[data-testid="feed-card"] img, [data-testid="play-feed-card"] img', (images) => images.map((image) => image.getAttribute('src') ?? ''));
    const report = { cards: sources.length, og: sources.filter((src) => src.includes('/og')).length, curated: sources.filter((src) => src.startsWith('/feed-thumbs/')).length, sources };
    console.log(`${report.cards} obrázků karet: ${report.og} /og, ${report.curated} kurátorských snímků`);
    if (typeof options.out === 'string') writeJson(resolve(ROOT, options.out), report);
    return report;
  } finally {
    await browser.close();
  }
}

/** Podíl pixelů, které se liší o víc než `PIXEL_TOLERANCE` v některém kanálu. */
async function pixelDiff(a, b) {
  const sharp = require('sharp');
  const [left, right] = await Promise.all([a, b].map((file) => sharp(file).removeAlpha().raw().toBuffer({ resolveWithObject: true })));
  if (left.info.width !== right.info.width || left.info.height !== right.info.height) return 1;
  let changed = 0;
  for (let i = 0; i < left.data.length; i += 3) {
    if (Math.abs(left.data[i] - right.data[i]) > PIXEL_TOLERANCE || Math.abs(left.data[i + 1] - right.data[i + 1]) > PIXEL_TOLERANCE || Math.abs(left.data[i + 2] - right.data[i + 2]) > PIXEL_TOLERANCE) changed += 1;
  }
  return changed / (left.data.length / 3);
}

async function diff(options) {
  const [dirA, dirB] = options._.slice(1).map((dir) => resolve(ROOT, dir));
  if (dirA === undefined || dirB === undefined) throw new Error('diff needs <dirA> <dirB>');
  const files = readdirSync(dirA).filter((file) => file.endsWith('.png') && existsSync(join(dirB, file)));
  let worst = 0;
  for (const file of files) {
    const share = await pixelDiff(join(dirA, file), join(dirB, file));
    worst = Math.max(worst, share);
    console.log(`${file}: ${(share * 100).toFixed(2)} % pixelů jinak`);
  }
  console.log(`nejhorší ${(worst * 100).toFixed(2)} % z ${files.length} snímků`);
  return worst;
}

/** FPS za `ms` z rAF, měřené ve stránce, okno odměřuje Node (stránku škrcení CPU zpomaluje). */
async function sampleFps(page, ms) {
  await page.evaluate(() => {
    window.__lookFps = { frames: 0, start: performance.now(), on: true };
    const tick = () => {
      if (!window.__lookFps.on) return;
      window.__lookFps.frames += 1;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await sleep(ms);
  return page.evaluate(() => {
    window.__lookFps.on = false;
    return (window.__lookFps.frames * 1000) / (performance.now() - window.__lookFps.start);
  });
}

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

/** Jedno měření scény: FPS za 10 s ukázky v emulaci Pixel 7 (CPU 4×) a kreslicí volání na konci. */
async function measureOnce(browser, base, versionId) {
  const context = await browser.newContext(pixel7());
  const page = await context.newPage();
  await (await context.newCDPSession(page)).send('Emulation.setCPUThrottlingRate', { rate: 4 });
  try {
    await page.goto(`${base}/play/${versionId}`);
    await page.locator('canvas').first().waitFor({ timeout: 60_000 });
    await settle(page);
    await page.evaluate(() => {
      // Ukázka v reálném čase (karta pauzy, jako `p32-look`); po konci se pouští znovu.
      const again = () => {
        const button = document.querySelector('[data-testid="play-demo-start"]') ?? document.querySelector('[data-testid="play-demo-yours"]') ?? document.querySelector('[data-testid="play-pause"]');
        button?.click();
      };
      window.__lookAgain = setInterval(again, 500);
    });
    await sleep(1500);
    const fps = await sampleFps(page, 10_000);
    return { fps, calls: await page.evaluate(() => window.__playRender?.().calls ?? null) };
  } finally {
    await context.close();
  }
}

/**
 * `--vs <url> --out-vs <file>` (P54B T14): A/B prokládaně scénu po scéně – opakování měří A B,
 * pak B A, takže obě verze nesou stejnou zátěž stroje. Vytížený stroj nikdy nebude v klidu
 * (rozhodnutí majitele 20. 10.) a běh A celý před B na něm dal ±24 % oběma směry.
 */
async function perf(options) {
  const base = options.base;
  if (typeof base !== 'string') throw new Error('perf needs --base <url>');
  const bases = typeof options.vs === 'string' ? [base, options.vs] : [base];
  const repeats = Number(options.repeats ?? 3);
  const browser = await browserFor(true);
  const rows = bases.map(() => []);
  try {
    // Zahřátí: první stránka čerstvého prohlížeče překládá shadery a měřila 0,2 FPS (13. 10.), ne scénu.
    for (const url of bases) {
      const warm = await browser.newPage();
      await warm.goto(`${url}/play/${(await publish(url, chosen(options)[0].text)).versionId}`);
      await warm.locator('canvas').first().waitFor({ timeout: 60_000 });
      await settle(warm);
      await warm.close();
    }
    for (const sentence of chosen(options)) {
      const games = await Promise.all(bases.map((url) => publish(url, sentence.text)));
      const samples = bases.map(() => []);
      const calls = bases.map(() => null);
      for (let run = 0; run < repeats; run += 1) {
        // Pořadí A B, B A, A B…: rostoucí zátěž by jinak vždy dopadla na B (20. 10.: B druhé = −5,5 % medián).
        const order = run % 2 === 0 ? [...bases.entries()] : [...bases.entries()].reverse();
        for (const [index, url] of order) {
          const measured = await measureOnce(browser, url, games[index].versionId);
          samples[index].push(measured.fps);
          calls[index] = measured.calls;
        }
      }
      for (const [index, url] of bases.entries()) {
        const row = { id: sentence.id, genre: games[index].genre, fpsMedian: Math.round(median(samples[index]) * 10) / 10, samples: samples[index].map((fps) => Math.round(fps * 10) / 10), calls: calls[index] };
        rows[index].push(row);
        console.log(`${sentence.id}${bases.length > 1 ? ` [${url}]` : ''}: ${row.fpsMedian} FPS (${row.samples.join(' ')}), ${row.calls} volání`);
      }
    }
  } finally {
    await browser.close();
  }
  const reports = bases.map((url, index) => ({ profile: 'Pixel 7, CPU 4x, d3d11', base: url, interleavedWith: bases.length > 1 ? bases[1 - index] : undefined, repeats, windowMs: 10_000, measuredAt: new Date().toISOString(), rows: rows[index] }));
  if (typeof options.out === 'string') writeJson(resolve(ROOT, options.out), reports[0]);
  if (reports[1] !== undefined && typeof options['out-vs'] === 'string') writeJson(resolve(ROOT, options['out-vs']), reports[1]);
  return reports[0];
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const options = args();
  const command = { shots, diff, perf, luma, feed }[options._[0]];
  if (command === undefined) {
    console.error('usage: play-look-shots.mjs shots|diff|perf|luma|feed …');
    process.exit(2);
  }
  await command(options);
}
