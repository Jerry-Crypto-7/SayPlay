/**
 * P70B T4 AC3: the AI version (director over codex-cli on the subscription) arrives in the local demo.
 *
 * One sentence at a time (codex-cli has 2 director slots): type it on /play, wait for the quick game, then poll the
 * version switch up to 120 s from sending until it says `ready`, click Full detail and check the page moves to another
 * game with the switch on `full`. Writes `live.json` and `<slug>-quick.png` (or `-at-120s.png`) / `<slug>-full.png` next to this file.
 *
 * Run against `next start` with the subscription profile of `.claude/start-demo.cmd` (WORLDSMITH_MODEL_ENDPOINT=codex-cli):
 * `node evals/play/p70b/director/live.mjs [--base http://127.0.0.1:3202] [--out <dir>] [--sentence "…"]…`
 * (`--out` místo složky skriptu, `--sentence` místo výchozího seznamu – P70B T4a).
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from '@playwright/test';

const at = process.argv.indexOf('--base');
const BASE = at === -1 ? 'http://127.0.0.1:3202' : process.argv[at + 1];
const LIMIT_MS = 120_000;
// Hra-řetěz (`draft-final CHAIN`) AI verzi z návrhu nemá (P58E), takže věta, která řetěz dá, se jen zapíše a jde se dál,
// dokud k režisérovi nedojdou čtyři (běh 4. 11.: králík i rytíř daly řetěz).
const wantedAt = process.argv.indexOf('--wanted');
const WANTED = wantedAt === -1 ? 4 : Number(process.argv[wantedAt + 1]);
// Golf a včela jely v prvním běhu (golf: AI verze za ~207 s, snímky `golf-*.png`; včela: řetěz).
const given = process.argv.flatMap((arg, index) => (process.argv[index - 1] === '--sentence' ? [arg] : []));
const SENTENCES = given.length > 0 ? given : [
  'a race car speeds around the track dodging oil spills',
  'a ninja slices fruit flying across the screen',
  'a frog hops across a busy road',
  'a cowboy shoots bottles off the fence',
  'a penguin slides down an icy hill',
  'a chef catches falling pizzas in the kitchen',
];
const upgradeOf = async (url) => (await fetch(`${BASE}/api/play/games/${url.split('/').at(-1)}/upgrade`)).json();
const outAt = process.argv.indexOf('--out');
const OUT = outAt === -1 ? path.dirname(fileURLToPath(import.meta.url)) : path.resolve(process.argv[outAt + 1]);
mkdirSync(OUT, { recursive: true });
const here = (name) => path.join(OUT, name);

// SteamVR na tomhle PC hlásí Chromiu brýle (paměť `chromium-vr-via-steamvr`).
const browser = await chromium.launch({ args: ['--disable-features=OpenXR'] });
const rows = [];
const fromAt = process.argv.indexOf('--from');
const FROM = fromAt === -1 ? 0 : Number(process.argv[fromAt + 1]);
for (const [index, sentence] of SENTENCES.entries()) {
  if (index < FROM) continue;
  if (rows.filter((row) => row.chain !== true).length >= WANTED) break;
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, extraHTTPHeaders: { 'x-forwarded-for': `10.70.2.${String(index + 1)}` } });
  const page = await context.newPage();
  // Jméno snímku z věty („a race car …“ → race-car), ať běh s `--from` nepřepíše snímky dřívější věty.
  const slug = sentence.split(' ').slice(1, 3).join('-');
  const row = { sentence, quick: null, kind: null, readyMs: null, full: null, fullKind: null, error: null };
  try {
    await page.goto(`${BASE}/play`);
    const field = page.getByTestId('play-sentence');
    await field.click();
    await field.fill(sentence);
    const sent = Date.now();
    await page.getByTestId('play-create').click();
    await page.waitForURL(/\/play\/[a-f0-9]+$/, { timeout: 30_000 });
    row.quick = page.url();
    await page.waitForTimeout(3_000);
    const first = await upgradeOf(row.quick);
    if (first.status === 'draft-final' && first.reason === 'CHAIN') {
      row.chain = true;
      rows.push(row);
      console.log(JSON.stringify(row));
      await context.close();
      continue;
    }
    const state = page.getByTestId('upgrade-state');
    // Proužek se ukáže až s prací AI verze; `none` i `working` tedy znamenají „ještě ne“.
    while (Date.now() - sent < LIMIT_MS) {
      row.kind = (await state.count()) === 0 ? 'none' : await state.first().getAttribute('data-kind');
      if (row.kind !== 'none' && row.kind !== 'working') break;
      await page.waitForTimeout(1_000);
    }
    if (row.kind === 'ready') row.readyMs = Date.now() - sent;
    row.upgrade = await upgradeOf(row.quick);
    await page.screenshot({ path: here(`./${slug}-${row.kind === 'ready' ? 'quick' : 'at-120s'}.png`) });
    if (row.kind === 'ready') {
      await page.getByTestId('upgrade-action').click();
      await page.waitForURL((url) => url.href !== row.quick, { timeout: 30_000 });
      row.full = page.url();
      await page.waitForFunction(() => document.querySelector('[data-testid="upgrade-state"]')?.getAttribute('data-kind') === 'full', undefined, { timeout: 30_000 });
      row.fullKind = 'full';
      await page.waitForTimeout(2_000);
      await page.screenshot({ path: here(`./${slug}-full.png`) });
    }
  } catch (thrown) {
    row.error = String(thrown).slice(0, 300);
  }
  rows.push(row);
  console.log(JSON.stringify(row));
  await context.close();
}
await browser.close();

const directed = rows.filter((row) => row.chain !== true);
const arrived = directed.filter((row) => row.readyMs !== null && row.fullKind === 'full').length;
writeFileSync(here('./live.json'), `${JSON.stringify({ base: BASE, measuredAt: new Date().toISOString(), limitMs: LIMIT_MS, arrived, of: directed.length, chains: rows.length - directed.length, rows }, null, 2)}\n`);
console.log(`arrived ${String(arrived)}/${String(directed.length)} (chains skipped: ${String(rows.length - directed.length)})`);
