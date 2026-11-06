#!/usr/bin/env node
/**
 * P73D T8: FPS a p95 doby snímku na telefonu, A (`main` před P73D) proti B (větev) prokládaně.
 * Telefon jako P70D (Pixel 7, CPU 4×, ANGLE d3d11, OpenXR vypnuté), jen okno 390×844 jako snímky P73D.
 * Osm her: šest doladěných v T7 + běh a plošinovka, věty a semínka z `p73d-shots.mjs`.
 *
 *   node scripts/play/p73d-perf.mjs --a http://127.0.0.1:3205 --b http://127.0.0.1:3204 --out evals/play/p73/sceny/perf-fps.json [--repeats 4] [--only s3,s7]
 *
 * Opakování měří A B, pak B A – stroj nikdy nebude v klidu (paměť perf-measure-interleaved-no-calm).
 * Jeden běh = čerstvý kontext, hra dotažená (`settle`), ukázka robota v reálném čase, 10 s rAF.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { args, median, pixel7, settle } from '../play-look-shots.mjs';
import { SENTENCES } from './p73d-shots.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(import.meta.url);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** s3 honička město, s8 quest hrad, s2 závod pod vodou, s4 stohování, s7 golf, s10 chytání (T7) + s1 běh, s5 plošinovka. */
export const GAMES = ['s3', 's8', 's2', 's4', 's7', 's10', 's1', 's5'];
export const GATE = { fpsMin: 40, p95MaxMs: 33.3 };
const WINDOW_MS = 10_000;

/** 95. percentil (nejbližší hodnost). */
export const p95 = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)];
};

async function publish(base, sentence) {
  const response = await fetch(`${base}/api/play/games`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sentence: sentence.text, seed: sentence.seed }) });
  const created = await response.json();
  if (!created.versionId) throw new Error(`${sentence.id}: POST ${response.status} ${JSON.stringify(created).slice(0, 200)}`);
  return created.versionId;
}

async function measureOnce(browser, base, versionId) {
  const context = await browser.newContext({ ...pixel7(), viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  await (await context.newCDPSession(page)).send('Emulation.setCPUThrottlingRate', { rate: 4 });
  try {
    await page.goto(`${base}/play/${versionId}`);
    await page.locator('canvas').first().waitFor({ timeout: 60_000 });
    await settle(page);
    await page.evaluate(() => {
      // Ukázka v reálném čase jako `measureOnce` (P54B); po konci se pouští znovu.
      setInterval(() => {
        const button = document.querySelector('[data-testid="play-demo-start"]') ?? document.querySelector('[data-testid="play-demo-yours"]') ?? document.querySelector('[data-testid="play-pause"]');
        button?.click();
      }, 500);
    });
    await sleep(1500);
    await page.evaluate(() => {
      window.__p73dFrames = { deltas: [], last: performance.now(), start: performance.now(), on: true };
      const tick = (now) => {
        const state = window.__p73dFrames;
        if (!state.on) return;
        state.deltas.push(now - state.last);
        state.last = now;
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    await sleep(WINDOW_MS);
    const { deltas, elapsed } = await page.evaluate(() => {
      const state = window.__p73dFrames;
      state.on = false;
      return { deltas: state.deltas.slice(1), elapsed: performance.now() - state.start };
    });
    const quality = await page.getByTestId('arcade-stage').first().getAttribute('data-quality', { timeout: 5_000 }).catch(() => null);
    const calls = await page.evaluate(() => window.__playRender?.().calls ?? null);
    return { fps: ((deltas.length + 1) * 1000) / elapsed, p95Ms: deltas.length > 0 ? p95(deltas) : null, quality, calls };
  } finally {
    await context.close();
  }
}

const round = (value) => (value === null ? null : Math.round(value * 10) / 10);

async function main() {
  const options = args();
  if (typeof options.a !== 'string' || typeof options.b !== 'string') throw new Error('usage: p73d-perf.mjs --a <url> --b <url> --out <file> [--repeats 4] [--only s3,s7]');
  const repeats = Number(options.repeats ?? 4);
  const only = typeof options.only === 'string' ? options.only.split(',') : GAMES;
  const sentences = only.map((id) => SENTENCES.find((item) => item.id === id));
  const sides = [['A', options.a], ['B', options.b]];
  const { chromium } = require('@playwright/test');
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=d3d11', '--ignore-gpu-blocklist', '--disable-features=OpenXR'] });
  const rows = [];
  try {
    // Zahřátí: první stránka čerstvého prohlížeče překládá shadery (13. 10.: 0,2 FPS), ne scénu.
    for (const [, url] of sides) {
      const warm = await browser.newPage();
      await warm.goto(`${url}/play/${await publish(url, sentences[0])}`);
      await warm.locator('canvas').first().waitFor({ timeout: 60_000 });
      await settle(warm);
      await warm.close();
    }
    for (const sentence of sentences) {
      const ids = await Promise.all(sides.map(([, url]) => publish(url, sentence)));
      const runs = { A: [], B: [] };
      for (let run = 0; run < repeats; run += 1) {
        const order = run % 2 === 0 ? [0, 1] : [1, 0];
        for (const index of order) {
          const [side, url] = sides[index];
          runs[side].push(await measureOnce(browser, url, ids[index]).catch((error) => ({ error: String(error).slice(0, 160) })));
        }
      }
      const row = { id: sentence.id, text: sentence.text };
      for (const [side] of sides) {
        const ok = runs[side].filter((item) => item.error === undefined);
        row[side] = { fpsMedian: ok.length > 0 ? round(median(ok.map((item) => item.fps))) : null, p95MedianMs: ok.length > 0 ? round(median(ok.map((item) => item.p95Ms))) : null, runs: runs[side].map((item) => (item.error ? item : { fps: round(item.fps), p95Ms: round(item.p95Ms), quality: item.quality, calls: item.calls })) };
      }
      row.passB = row.B.fpsMedian !== null && row.B.fpsMedian >= GATE.fpsMin && row.B.p95MedianMs <= GATE.p95MaxMs;
      rows.push(row);
      console.log(`${sentence.id}: A ${row.A.fpsMedian} FPS p95 ${row.A.p95MedianMs} ms | B ${row.B.fpsMedian} FPS p95 ${row.B.p95MedianMs} ms | calls ${row.A.runs[0]?.calls}->${row.B.runs[0]?.calls} q ${row.B.runs.map((item) => item.quality ?? 'x').join(',')} ${row.passB ? 'OK' : 'FAIL'}`);
      // Po každé hře: pád v půli měření nesmaže, co už je změřené.
      write(options, { profile: 'Pixel 7 UA/DPR, 390x844, CPU 4x, ANGLE d3d11, OpenXR off', a: options.a, b: options.b, repeats, windowMs: WINDOW_MS, gate: GATE, measuredAt: new Date().toISOString(), complete: rows.length === sentences.length, pass: rows.every((item) => item.passB), rows });
    }
  } finally {
    await browser.close();
  }
}

function write(options, report) {
  if (typeof options.out !== 'string') return;
  const path = resolve(ROOT, options.out);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(report, null, 1)}\n`);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main().catch((error) => {
  console.error(error);
  process.exit(1);
});
