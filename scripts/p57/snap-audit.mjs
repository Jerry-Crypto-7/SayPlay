#!/usr/bin/env node
/**
 * Snímky 12 vět auditu P57 (`evals/play/p57/audit-12.json`): každá věta projde dveřmi
 * `POST /api/play/games` (rychlá verze, server bez režiséra) a hra se vyfotí na desktopu
 * 1280×800 i na telefonu 390×844 ve 2 s a v 15 s ukázky robota. Čas je tik simulace
 * (60 Hz, ruční hodiny sondy `__playShell.byHand`), ne čas zdi: snímek před a po výměně
 * modelů tak ukazuje stejný herní stav a liší se jen vzhledem. Plátno bez textu stránky.
 *
 *   node scripts/p57/snap-audit.mjs --base http://127.0.0.1:3257 --out D:/caches/p57/baseline [--gpu] [--only 01-frog,04-shark] [--commit <sha>]
 *
 * Výstup: `<id>-d-2s.png`, `<id>-d-15s.png`, `<id>-m-2s.png`, `<id>-m-15s.png` a `index.json`
 * (commit buildu, renderer, tiky a řádek na snímek).
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { args, browserFor, demoTo, pixel7, publish, SCENE_ONLY, settle } from '../play-look-shots.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HZ = 60;
/** Okamžiky snímků v sekundách ukázky – jako audit 21. 10. (`NN-slovo-d|m-2s|15s`). */
export const MOMENTS = [2, 15];
const VIEWPORTS = {
  d: { label: 'desktop 1280x800', context: () => ({ viewport: { width: 1280, height: 800 } }) },
  // Telefon: dotykový Pixel 7 (scéna startuje na telefonní kvalitě), plocha 390×844 jako audit.
  m: { label: 'phone 390x844', context: () => ({ ...pixel7(), viewport: { width: 390, height: 844 }, screen: { width: 390, height: 844 } }) },
};

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const sentences = () => JSON.parse(readFileSync(join(ROOT, 'evals', 'play', 'p57', 'audit-12.json'), 'utf8')).sentences;

/** Odtiká hodiny ukázky o `count` tiků (nebo do konce hry); vrací stav, na kterém stojí. */
const tickOn = (page, count) =>
  page.evaluate((n) => {
    let state = window.__playShell.tickByHand();
    for (let index = 1; index < n && state.runState === 'running'; index += 1) state = window.__playShell.tickByHand();
    return state;
  }, count);

/** Snímek až po dotažení modelů a dojetí kamery (hodiny stojí, nikdo netiká). */
async function shoot(page, path) {
  await settle(page);
  await sleep(1500);
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
  await page.screenshot({ path, timeout: 120_000 });
}

async function main() {
  const options = args();
  const base = options.base;
  if (typeof base !== 'string' || typeof options.out !== 'string') throw new Error('usage: snap-audit.mjs --base <url> --out <dir> [--gpu] [--only ids]');
  const out = resolve(options.out);
  mkdirSync(out, { recursive: true });
  const only = typeof options.only === 'string' ? new Set(options.only.split(',')) : null;
  const commit = typeof options.commit === 'string' ? options.commit : execFileSync('git', ['rev-parse', '--short=8', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
  const browser = await browserFor(options.gpu === true);
  const index = { commit, base, renderer: options.gpu === true ? 'd3d11' : 'swiftshader', hz: HZ, moments: MOMENTS, takenAt: new Date().toISOString(), shots: [] };
  try {
    for (const sentence of sentences().filter((row) => only === null || only.has(row.id))) {
      // Jedna hra pro oba pohledy: stejná věta = stejné semínko, stejné id verze.
      const game = await publish(base, sentence.text);
      for (const [key, viewport] of Object.entries(VIEWPORTS)) {
        const context = await browser.newContext(viewport.context());
        const page = await context.newPage();
        try {
          await page.goto(`${base}/play/${game.versionId}`, { timeout: 120_000 });
          await page.locator('canvas').first().waitFor({ timeout: 60_000 });
          await settle(page);
          let state = await demoTo(page, MOMENTS[0] * HZ);
          await page.addStyleTag(SCENE_ONLY);
          for (const [at, seconds] of MOMENTS.entries()) {
            if (at > 0) state = await tickOn(page, (seconds - MOMENTS[at - 1]) * HZ);
            const file = `${sentence.id}-${key}-${seconds}s.png`;
            await shoot(page, join(out, file));
            const render = await page.evaluate(() => window.__playRender());
            index.shots.push({ id: sentence.id, text: sentence.text, viewport: viewport.label, seconds, file, versionId: game.versionId, control: game.control, setting: game.setting, tick: state?.tick ?? null, runState: state?.runState ?? null, meshes: render.meshes, calls: render.calls });
            console.log(`${file}: ${game.control}/${game.setting} tick ${state?.tick} ${state?.runState} – ${render.meshes} sítí`);
          }
        } finally {
          await context.close();
        }
      }
    }
  } finally {
    await browser.close();
  }
  writeFileSync(join(out, 'index.json'), `${JSON.stringify(index, null, 1)}\n`);
  console.log(`${index.shots.length} snímků → ${out}`);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) await main();
