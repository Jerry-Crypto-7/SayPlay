#!/usr/bin/env node
/**
 * Latence rychlé cesty P56A (T1, T13, T14): věta → hra na produkčním serveru.
 *
 *   PLAY_READER= node evals/play/p56a/latency.mjs --serve . --base http://127.0.0.1:3112 \
 *     --sentences evals/play/p56a/audit-12.json,evals/play/p30/dev.json --limit 30 \
 *     --out evals/play/p56a/baseline.json --label off
 *
 * `--serve <dir>` pustí `node node_modules/next/dist/bin/next start` v `<dir>` (build musí být hotový,
 * `npm run build`) s prostředím tohoto procesu – čtečku tedy volí volající (`PLAY_READER=` vypnuto) – a pro každý
 * průchod ho spustí znovu: úložiště bez Upstash žije v paměti, takže oba průchody měří **studenou** větu (první
 * publikace s ověřením robotem). Bez `--serve` jde na běžící server a prohlížeč pak měří už publikovanou větu.
 *
 * Průchod **server**: `POST /api/play/games` z Node, wall-clock od odeslání do odpovědi (`postMs`, na localhostu ≈
 * serverový návrh + ověření + uložení; `draftReadyMs` route ven nedává, zapíše ho jen upgrade režiséra), plus
 * `versionId` pro srovnání „beze změny“ (T10). Průchod **prohlížeč** (`--no-browser` vypne): chromium na `/play`
 * po hydrataci, věta do `[data-testid=play-sentence]`, klik na `[data-testid=play-create]`, čas do
 * `window.__playShell !== undefined` na `/play/<id>` (`playableMs`).
 *
 * Výstup: klíč `latency.<label>` v `--out` (ostatní klíče souboru zůstanou) – `{ base, n, server, browser, rows }`,
 * bez času běhu, ať opakovaný běh mění jen čísla.
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { chromium } from '@playwright/test';

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};
const base = arg('base', 'http://127.0.0.1:3112').replace(/\/$/, '');
const files = arg('sentences', 'evals/play/p56a/audit-12.json').split(',');
const limit = Number(arg('limit', '30'));
const out = arg('out', null);
const label = arg('label', 'off');
const serveDir = arg('serve', null);
const browserOn = !args.includes('--no-browser');
const timeoutMs = Number(arg('timeout', '60000'));

const sentences = files.flatMap((file) => JSON.parse(readFileSync(file, 'utf8')).sentences.map((s) => ({ id: s.id, text: s.text }))).slice(0, limit);
const wait = (ms) => new Promise((done) => setTimeout(done, ms));

const pct = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length === 0 ? null : Math.round(sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]);
};
const stats = (values) => ({ n: values.length, p50: pct(values, 50), p95: pct(values, 95), max: values.length === 0 ? null : Math.round(Math.max(...values)) });

/** Spustí `next start` na portu z `--base` a počká, až `/play` odpoví. */
async function serve() {
  const dir = resolve(serveDir);
  const port = new URL(base).port;
  const child = spawn(process.execPath, [join(dir, 'node_modules/next/dist/bin/next'), 'start', '-p', port, '-H', new URL(base).hostname], { cwd: dir, env: process.env, stdio: 'ignore' });
  for (let i = 0; i < 120; i += 1) {
    if (child.exitCode !== null) throw new Error(`next start exited with ${child.exitCode}`);
    const up = await fetch(`${base}/play`).then((r) => r.ok, () => false);
    if (up) return child;
    await wait(500);
  }
  child.kill();
  throw new Error('next start did not answer /play in 60 s');
}

async function stop(child) {
  if (child === null) return;
  const gone = new Promise((done) => child.once('exit', done));
  child.kill();
  await gone;
}

async function post(text) {
  const t0 = performance.now();
  const response = await fetch(`${base}/api/play/games`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sentence: text }) });
  const body = await response.json().catch(() => ({}));
  return { status: response.status, postMs: Math.round(performance.now() - t0), versionId: body.versionId ?? null, title: body.title ?? null };
}

async function playable(page, text) {
  await page.goto(`${base}/play`, { waitUntil: 'load' });
  // Hydratace jako `e2e/first-visit.spec.ts`: pole věty má React fiber. Dřív vyplněná věta by se ztratila.
  await page.waitForFunction(() => Object.keys(document.querySelector('[data-testid=play-sentence]') ?? {}).some((key) => key.startsWith('__reactFiber')), undefined, { timeout: timeoutMs });
  const input = page.locator('[data-testid=play-sentence]');
  await input.fill(text);
  await page.waitForFunction((value) => document.querySelector('[data-testid=play-sentence]')?.value === value, text);
  const t0 = await page.evaluate(() => performance.timeOrigin + performance.now());
  await page.locator('[data-testid=play-create]').click();
  await page.waitForURL(/\/play\/[a-f0-9]+(\?|$)/, { timeout: timeoutMs });
  await page.waitForFunction(() => window.__playShell !== undefined, undefined, { timeout: timeoutMs });
  const t1 = await page.evaluate(() => performance.timeOrigin + performance.now());
  return { playableMs: Math.round(t1 - t0), browserVersionId: new URL(page.url()).pathname.split('/').pop() };
}

const rows = new Map(sentences.map((s) => [s.id, { id: s.id }]));

let server = serveDir === null ? null : await serve();
for (const sentence of sentences) {
  const measured = await post(sentence.text);
  Object.assign(rows.get(sentence.id), measured);
  console.log(`${sentence.id} ${measured.status} post ${measured.postMs} ms · ${measured.title}`);
}

let pageErrors = 0;
if (browserOn) {
  if (serveDir !== null) {
    await stop(server);
    server = await serve();
  }
  const browser = await chromium.launch({ args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  page.on('pageerror', () => (pageErrors += 1));
  for (const sentence of sentences) {
    try {
      Object.assign(rows.get(sentence.id), await playable(page, sentence.text));
    } catch (error) {
      Object.assign(rows.get(sentence.id), { playableMs: null, note: error.message.split('\n')[0].slice(0, 160) });
    }
    const row = rows.get(sentence.id);
    console.log(`${sentence.id} playable ${row.playableMs ?? row.note}`);
  }
  await browser.close();
}
await stop(server);

const list = [...rows.values()];
const ok = list.filter((row) => row.status === 200 || row.status === 201);
const result = {
  base, reader: process.env.PLAY_READER ?? '', cold: serveDir !== null, n: list.length,
  server: stats(ok.map((row) => row.postMs)),
  browser: browserOn ? stats(list.filter((row) => row.playableMs != null).map((row) => row.playableMs)) : null,
  pageErrors,
  rows: list,
};
console.log(JSON.stringify({ server: result.server, browser: result.browser, pageErrors }));
if (out !== null) {
  const previous = existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) : {};
  writeFileSync(out, `${JSON.stringify({ ...previous, latency: { ...(previous.latency ?? {}), [label]: result } }, null, 1)}\n`);
}
