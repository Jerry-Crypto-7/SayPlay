#!/usr/bin/env node
/**
 * P73C T5 oracle v prohlížeči: nová věta → rychlá verze → stránka hry, na které proužek „Full detail“
 * ukazuje kroky režie. Snímek ve chvíli „Hero: …“, ve chvíli „Checking it can be won…“, hotový přepínač
 * a otevřená AI verze. Čas = od otevření stránky po `upgrade-action.is-ready` (hráčův pohled).
 *
 *   node scripts/play/p73-oracle.mjs --base http://127.0.0.1:3203 --out evals/play/p73/reziser/oracle
 *
 * Věty musí být nové – už použitá věta přijde z cache režiséra a změří 0 volání (paměť director-cache-skews-live-timing).
 * Jeden proces proti jednomu serveru, věty po sobě (souběžné snímání server zasekne).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { args } from '../play-look-shots.mjs';
import { browser, publish } from './p70d-shots.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

export const SENTENCES = [
  { id: 'hedgehog', seed: 73501, text: 'a hedgehog rolls down a mossy hill dodging falling pinecones' },
  { id: 'otter', seed: 73502, text: 'an otter paddles a leaf boat along a rainy canal and avoids grumpy frogs' },
  { id: 'keeper', seed: 73503, text: 'a lighthouse keeper catches glowing jellyfish from a stormy pier' },
];

const LIMIT_MS = 300_000;

async function one(chromium, base, out, sentence) {
  const quick = await publish(base, sentence);
  const page = await chromium.newPage({ viewport: { width: 1280, height: 800 } });
  const steps = [];
  const shots = {};
  const started = Date.now();
  const at = () => Date.now() - started;
  const snap = async (name) => {
    const file = `${sentence.id}-${name}.png`;
    await page.screenshot({ path: join(out, file) });
    shots[name] = { file, ms: at() };
  };
  await page.goto(`${base}/play/${quick.versionId}`, { waitUntil: 'domcontentloaded' });
  let readyMs = null;
  let endKind = null;
  while (at() < LIMIT_MS) {
    const state = await page.evaluate(() => {
      const box = document.querySelector('[data-testid="upgrade-state"]');
      const action = document.querySelector('[data-testid="upgrade-action"]');
      return {
        kind: box?.getAttribute('data-kind') ?? null,
        step: document.querySelector('[data-testid="upgrade-step"]')?.textContent?.trim() ?? null,
        ready: action?.classList.contains('is-ready') === true,
      };
    });
    if (state.step !== null && steps.at(-1)?.text !== state.step) {
      steps.push({ text: state.step, ms: at() });
      if (state.step.startsWith('Hero:') && shots.hero === undefined) await snap('hero');
      if (state.step.startsWith('Checking') && shots.checking === undefined) await snap('checking');
    }
    if (state.ready || state.kind === 'ready') {
      readyMs = at();
      await snap('ready');
      break;
    }
    if (state.kind === 'final' || state.kind === 'lost') {
      endKind = state.kind;
      await snap(state.kind);
      break;
    }
    await sleep(150);
  }
  let aiVersion = null;
  if (readyMs !== null) {
    await page.click('[data-testid="upgrade-action"]');
    await page.waitForURL((url) => !url.pathname.endsWith(quick.versionId), { timeout: 30_000 });
    aiVersion = new URL(page.url()).pathname.split('/').pop();
    await sleep(4_000);
    await snap('ai');
  }
  await page.close();
  return { id: sentence.id, text: sentence.text, quick: quick.versionId, quickGenre: quick.genre, aiVersion, readyMs, endKind, steps, shots };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const options = args();
  const base = options.base ?? 'http://127.0.0.1:3203';
  const out = resolve(ROOT, options.out ?? 'evals/play/p73/reziser/oracle');
  mkdirSync(out, { recursive: true });
  const only = typeof options.only === 'string' ? new Set(options.only.split(',')) : null;
  const chromium = await browser(true);
  const rows = [];
  try {
    for (const sentence of SENTENCES.filter((s) => only === null || only.has(s.id))) {
      const row = await one(chromium, base, out, sentence);
      rows.push(row);
      console.log(`${row.id}: ${row.readyMs === null ? `bez AI verze (${row.endKind ?? 'limit'})` : `AI verze za ${(row.readyMs / 1000).toFixed(1)} s`}; kroky: ${row.steps.map((s) => s.text).join(' | ')}`);
    }
  } finally {
    await chromium.close();
  }
  // `--only` doplní řádky k dřívějšímu běhu – věta podruhé by přišla z cache a změřila nic.
  const file = join(out, 'oracle.json');
  const earlier = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')).rows.filter((row) => !rows.some((fresh) => fresh.id === row.id)) : [];
  writeFileSync(file, `${JSON.stringify({ base, measuredAt: new Date().toISOString(), rows: [...earlier, ...rows] }, null, 1)}\n`);
}
