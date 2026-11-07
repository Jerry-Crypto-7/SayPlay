#!/usr/bin/env node
/**
 * P76 T3: co z P75 prodlužuje první snímek hry na telefonu. Pixel 7, CPU 4× (jako `first-playable-ab.mjs`),
 * CDP `Profiler` (vzorek 200 µs) od navigace na `/play/<id>` po první snímek, ve kterém hra kreslila (`draw*` v rAF).
 * K tomu počítadla WebGL do téhož snímku: programy, čekání na překlad shaderů, nahrávání textur, kreslicí volání.
 *
 *   node scripts/play/p76-ff-profile.mjs --a http://127.0.0.1:3208 --b http://127.0.0.1:3207 [--only s3,s8,s5] [--runs 3] [--out evals/play/p76/ff-profile.json]
 *
 * Hra se na každé straně vytvoří jednou (`POST /api/play/games`, věta a semínko z `p73d-shots.mjs`); běhy jdou
 * prokládaně (AB, BA, …), každý s vlastním prohlížečem. Výstup: běhy, mediány po stranách a rozdíl B − A po
 * kategoriích vlastního času profilu (nativní volání WebGL podle jména, skripty podle souboru bez hashe).
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium, devices } from '@playwright/test';

import { GPU_ARGS } from '../measure/time-to-playable.mjs';
import { args } from '../play-look-shots.mjs';
import { SENTENCES } from './p73d-shots.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Skript stránky: průběžná počítadla WebGL (`__ffTotals`) a první snímek, ve kterém kreslilo plátno bez
 * `data-ff-old` (`__ff`: čas a počítadla v tu chvíli). Cesta věty plátna feedu označí před odesláním.
 */
function instrument() {
  const totals = { programs: 0, linkMs: 0, waitMs: 0, texMs: 0, textures: 0, draws: 0 };
  globalThis.__ffTotals = totals;
  globalThis.__ff = { firstDraw: 0 };
  let drew = false;
  const timed = (type, name, key, count) => {
    const original = type.prototype[name];
    if (typeof original !== 'function') return;
    type.prototype[name] = function (...rest) {
      const start = performance.now();
      try {
        return original.apply(this, rest);
      } finally {
        if (key !== null) totals[key] += performance.now() - start;
        if (count !== null) totals[count] += 1;
      }
    };
  };
  for (const type of [globalThis.WebGLRenderingContext, globalThis.WebGL2RenderingContext]) {
    if (type === undefined) continue;
    timed(type, 'createProgram', null, 'programs');
    timed(type, 'linkProgram', 'linkMs', null);
    for (const name of ['getProgramParameter', 'getProgramInfoLog', 'getShaderParameter', 'getShaderInfoLog']) timed(type, name, 'waitMs', null);
    for (const name of ['texImage2D', 'texSubImage2D', 'texImage3D', 'texStorage2D', 'compressedTexImage2D']) timed(type, name, 'texMs', 'textures');
    for (const name of ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced', 'drawRangeElements']) {
      const original = type.prototype[name];
      type.prototype[name] = function (...rest) {
        totals.draws += 1;
        if (globalThis.__ff.firstDraw === 0 && this.canvas?.dataset?.ffOld !== '1') drew = true;
        return original.apply(this, rest);
      };
    }
  }
  const request = globalThis.requestAnimationFrame.bind(globalThis);
  globalThis.requestAnimationFrame = (callback) =>
    request((time) => {
      try {
        callback(time);
      } finally {
        if (drew && globalThis.__ff.firstDraw === 0) globalThis.__ff = { firstDraw: performance.now(), epoch: performance.timeOrigin + performance.now(), ...totals };
      }
    });
}

const WEBGL = /^(compileShader|linkProgram|getProgramParameter|getProgramInfoLog|getShaderParameter|getShaderInfoLog|texImage2D|texSubImage2D|texStorage2D|bufferData|bufferSubData|drawElements|drawArrays|drawElementsInstanced|drawArraysInstanced|uniform\w+|useProgram|bindTexture|generateMipmap|readPixels|createImageBitmap|decode)$/;

/**
 * Kategorie vzorku: nativní WebGL podle jména, ostatní nativní podle jména uzlu, skript jako celek – jména
 * chunků a minifikované funkce se mezi buildy A a B liší, porovnat jdou jen součty.
 */
function categoryOf({ functionName, url }) {
  if (url === '') return WEBGL.test(functionName) ? `gl:${functionName}` : functionName || '(anonymous native)';
  return 'js';
}

function selfTimes(profile) {
  const nodes = new Map(profile.nodes.map((node) => [node.id, node]));
  const out = {};
  profile.samples.forEach((id, index) => {
    const key = categoryOf(nodes.get(id).callFrame);
    out[key] = (out[key] ?? 0) + (profile.timeDeltas[index] ?? 0) / 1000;
  });
  return out;
}

async function publish(base, sentence) {
  const response = await fetch(`${base}/api/play/games`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sentence: sentence.text, seed: sentence.seed }) });
  const created = await response.json();
  if (!created.versionId) throw new Error(`${base} ${sentence.id}: POST ${response.status}`);
  return created.versionId;
}

const COUNTERS = ['programs', 'linkMs', 'waitMs', 'texMs', 'textures', 'draws'];

/**
 * Jeden běh. `game`: navigace na `/play/<id>` → první snímek hry (`firstDraw` od začátku navigace). `sentence`:
 * na `/play` věta do pole, odeslání → první snímek nového plátna (`firstDraw` od odeslání, jako `firstFrameMs`
 * sondy `time-to-playable.mjs`); počítadla jen za to okno.
 */
async function profileOnce(base, target, path, { after = 0, block = null } = {}) {
  const { defaultBrowserType: _type, ...device } = devices['Pixel 7'];
  const browser = await chromium.launch({ headless: true, args: GPU_ARGS });
  try {
    const context = await browser.newContext({ ...device });
    await context.addInitScript(instrument);
    if (block !== null) await context.route(block, (route) => route.abort());
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    await cdp.send('Profiler.enable');
    await cdp.send('Profiler.setSamplingInterval', { interval: 200 });
    let before = null;
    if (path === 'sentence') {
      await page.goto(`${base}/play`, { waitUntil: 'load', timeout: 120_000 });
      await page.locator('[data-testid=play-sentence]').first().fill(target, { timeout: 120_000 });
      before = await page.evaluate(() => {
        for (const canvas of document.querySelectorAll('canvas')) canvas.dataset.ffOld = '1';
        return { origin: performance.timeOrigin, epoch: performance.timeOrigin + performance.now(), ...globalThis.__ffTotals };
      });
      await cdp.send('Profiler.start');
      await page.locator('[data-testid=play-create]').first().click();
      await page.waitForURL(/\/play\/[a-f0-9]+(\?|$)/, { timeout: 120_000 });
    } else {
      await cdp.send('Profiler.start');
      await page.goto(`${base}/play/${target}`, { waitUntil: 'commit', timeout: 120_000 });
    }
    await page.waitForFunction(() => globalThis.__ff?.firstDraw > 0, undefined, { timeout: 120_000, polling: 100 });
    const { profile } = await cdp.send('Profiler.stop');
    const ff = await page.evaluate(() => ({ ...globalThis.__ff, origin: performance.timeOrigin }));
    if (before === null && after > 0) {
      // Okno po prvním snímku (`--after` ms): druhý profil a počítadla od prvního snímku.
      await cdp.send('Profiler.start');
      await page.waitForTimeout(after);
      const { profile: next } = await cdp.send('Profiler.stop');
      const totals = await page.evaluate(() => globalThis.__ffTotals);
      return { ...ff, self: selfTimes(profile), later: { ...Object.fromEntries(COUNTERS.map((key) => [key, totals[key] - ff[key]])), self: selfTimes(next) } };
    }
    if (before === null) return { ...ff, self: selfTimes(profile) };
    // Plná navigace začne počítadla od nuly v novém dokumentu; navigace v klientu je načítá dál.
    const same = ff.origin === before.origin;
    const window = Object.fromEntries(COUNTERS.map((key) => [key, same ? ff[key] - before[key] : ff[key]]));
    return { ...window, firstDraw: ff.epoch - before.epoch, fullNavigation: !same, self: selfTimes(profile) };
  } finally {
    await browser.close();
  }
}

const median = (values) => {
  const sorted = values.filter((value) => typeof value === 'number').sort((x, y) => x - y);
  if (sorted.length === 0) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const round = (value) => (value === null ? null : Math.round(value));

/** Mediány po stranách a rozdíl B − A po kategoriích profilu (`runs` = běhy, nebo jejich okna `later`). */
function summarize(runs) {
  const sides = {};
  for (const side of ['A', 'B']) {
    const mine = runs.filter((run) => run.side === side && run.error === undefined);
    const keys = new Set(mine.flatMap((run) => Object.keys(run.self)));
    sides[side] = {
      n: mine.length,
      ...Object.fromEntries(['firstDraw', ...COUNTERS].map((key) => [key, round(median(mine.map((run) => run[key])))])),
      self: Object.fromEntries([...keys].map((key) => [key, median(mine.map((run) => run.self[key] ?? 0))])),
    };
  }
  const keys = new Set([...Object.keys(sides.A.self), ...Object.keys(sides.B.self)]);
  const diff = [...keys]
    .map((key) => ({ key, A: round(sides.A.self[key] ?? 0), B: round(sides.B.self[key] ?? 0), diff: round((sides.B.self[key] ?? 0) - (sides.A.self[key] ?? 0)) }))
    .sort((x, y) => Math.abs(y.diff) - Math.abs(x.diff))
    .slice(0, 25);
  for (const side of ['A', 'B']) delete sides[side].self;
  const windows = runs.filter((run) => run.later !== undefined).map((run) => ({ side: run.side, ...run.later }));
  return windows.length === 0 ? { sides, diff } : { sides, diff, later: summarize(windows) };
}

async function main() {
  const options = args();
  const only = typeof options.only === 'string' ? new Set(options.only.split(',')) : new Set(['s3', 's8', 's5']);
  const runs = Number(options.runs ?? 3);
  const path = options.path === 'sentence' ? 'sentence' : 'game';
  const bases = { A: options.a, B: options.b };
  const sentences = SENTENCES.filter((item) => only.has(item.id));
  const ids = { A: {}, B: {} };
  for (const side of ['A', 'B']) for (const sentence of sentences) ids[side][sentence.id] = path === 'sentence' ? sentence.text : await publish(bases[side], sentence);
  const results = [];
  let pair = 0;
  for (let run = 1; run <= runs; run += 1) {
    for (const sentence of sentences) {
      for (const side of pair % 2 === 0 ? ['A', 'B'] : ['B', 'A']) {
        try {
          const block = options[`block-${side.toLowerCase()}`];
          const extra = { after: Number(options.after ?? 0), block: typeof block === 'string' ? new RegExp(block) : null };
          results.push({ run, side, sentence: sentence.id, ...(await profileOnce(bases[side], ids[side][sentence.id], path, extra)) });
        } catch (error) {
          results.push({ run, side, sentence: sentence.id, error: String(error).slice(0, 200) });
        }
        const last = results.at(-1);
        console.log(`${run} ${sentence.id} ${side}: ${last.error ?? `první snímek ${Math.round(last.firstDraw)} ms, programy ${last.programs}, čekání ${Math.round(last.waitMs)} ms, textury ${Math.round(last.texMs)} ms`}`);
      }
      pair += 1;
    }
  }
  const blocks = { blockA: options['block-a'] ?? null, blockB: options['block-b'] ?? null, after: Number(options.after ?? 0) };
  const brief = ({ self: _self, later, ...rest }) => (later === undefined ? rest : { ...rest, later: { ...later, self: undefined } });
  const summary = { measuredAt: new Date().toISOString(), path, a: bases.A, b: bases.B, ...blocks, sentences: [...only], runs, ...summarize(results), results: results.map(brief) };
  const out = resolve(ROOT, options.out ?? 'evals/play/p76/ff-profile.json');
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(summary, null, 1)}\n`);
  const print = (part) => {
    console.log(JSON.stringify(part.sides));
    for (const row of part.diff.slice(0, 12)) console.log(`${row.diff > 0 ? '+' : ''}${row.diff} ms  ${row.key}  (A ${row.A}, B ${row.B})`);
  };
  print(summary);
  if (summary.later !== undefined) {
    console.log(`po prvním snímku (${blocks.after} ms):`);
    print(summary.later);
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
