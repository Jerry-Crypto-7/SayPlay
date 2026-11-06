#!/usr/bin/env node
// P71D T6: 12 vět přes POST /api/play/games, telefon 390×844, žánr + hrdina ze specu, robot (playWitness, jako e2e
// střílečky) a nečinný (idleRun) ze sondy __playShell, text pruhu „isn't here yet“. Server `next start -p 3013` zvlášť.
// node --experimental-strip-types evals/play/p71/sentence/oracle.mjs --base http://127.0.0.1:3013 --out evals/play/p71/sentence
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
await import('../../../../scripts/ts-paths.mjs');
const { heroModel } = await import('../../../../src/play/arcade/models.ts');
const { ARCADE_HZ } = await import('../../../../src/play/arcade/contract.ts');
const require = createRequire(import.meta.url);
const { chromium } = require('@playwright/test');

const argv = process.argv.slice(2);
const opt = (name, fallback) => (argv.includes(`--${name}`) ? argv[argv.indexOf(`--${name}`) + 1] : fallback);
const base = opt('base', 'http://127.0.0.1:3013');
const out = resolve(ROOT, opt('out', 'evals/play/p71/sentence'));
const only = opt('only', null);
mkdirSync(out, { recursive: true });

// QA 7 (findings.json 5. 11.) + 5 parafrází z p71d-sentence-fit.test.ts; want = žánry a hlavy hrdiny, které věta smí dostat.
const SENTENCES = [
  { id: 'qa-shooter', qa: true, text: 'a spaceship shoots asteroids in outer space', genres: ['shooter', 'railfps'], heroes: ['spaceship', 'rocket'] },
  { id: 'qa-throw', qa: true, text: 'toss basketballs into the hoop', genres: ['throw'], heroes: ['kid'] },
  { id: 'qa-whack', qa: true, text: 'whack the moles in the garden', genres: ['whack'], heroes: ['farmer'] },
  { id: 'qa-quest', qa: true, text: 'a wizard explores a dungeon to find the lost crown', genres: ['quest'], heroes: ['wizard'] },
  { id: 'qa-catch', qa: true, text: 'catch falling donuts and dodge the bombs', genres: ['catch'], heroes: ['baker'] },
  { id: 'qa-merge', qa: true, text: 'merge matching fruits in a jar', genres: ['merge'], heroes: ['farmer'] },
  { id: 'qa-buildshift', qa: true, text: 'run a pizza shop and serve 12 customers', genres: ['buildshift'], heroes: ['chef'] },
  { id: 'p-shooter', text: 'a rocket blasts meteors', genres: ['shooter', 'railfps'], heroes: ['spaceship', 'rocket'] },
  { id: 'p-whack', text: 'hit moles with a hammer', genres: ['whack'], heroes: ['farmer'] },
  { id: 'p-quest', text: 'a knight looks for the lost sword in the castle', genres: ['quest'], heroes: ['knight'] },
  { id: 'p-catch', text: 'catch the falling apples in a basket', genres: ['catch'], heroes: ['farmer'] },
  { id: 'p-buildshift', text: 'a chef runs a pizza shop', genres: ['buildshift'], heroes: ['chef'] },
].filter((s) => only === null || only.split(',').includes(s.id));

const FAIR_START_S = 5;
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const head = (label) => label.toLowerCase().replace(/s$/, '').split(' ').at(-1);

async function publish(text) {
  const response = await fetch(`${base}/api/play/games`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sentence: text }) });
  const created = await response.json();
  if (!created.versionId) throw new Error(`POST ${response.status} ${JSON.stringify(created).slice(0, 200)}`);
  const body = await (await fetch(`${base}/api/play/games/${created.versionId}`, { cache: 'no-store' })).json();
  return { versionId: created.versionId, spec: (body.game ?? body).spec };
}

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=d3d11', '--ignore-gpu-blocklist', '--disable-features=OpenXR'] });
const rows = [];
try {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error.message ?? error).slice(0, 200)));
  for (const s of SENTENCES) {
    const errorsBefore = errors.length;
    const row = { id: s.id, qa: s.qa === true, sentence: s.text };
    try {
      const { versionId, spec } = await publish(s.text);
      const player = spec.roles.find((role) => role.kind === 'player');
      Object.assign(row, {
        versionId,
        genre: spec.genre?.id ?? null,
        mode: spec.genre?.mode ?? null,
        hero: player?.label ?? null,
        heroModel: heroModel(spec),
        others: spec.roles.filter((role) => role.kind !== 'player').map((role) => `${role.kind}:${role.label}`),
        title: spec.title ?? null,
        goalLine: spec.tutorial?.goalLine ?? null,
        controlsHint: spec.tutorial?.controlsHint ?? null,
        objective: spec.objective?.description ?? null,
      });
      await page.goto(`${base}/play/${versionId}`, { timeout: 120_000 });
      await page.locator('canvas').first().waitFor({ timeout: 60_000 });
      await page.waitForFunction(() => typeof window.__playShell?.idleRun === 'function', undefined, { timeout: 60_000 });
      await sleep(4000);
      await page.screenshot({ path: join(out, `${s.id}-start.png`) });
      row.banner = await page.getByTestId('play-honest-reason').first().textContent({ timeout: 1000 }).catch(() => null);
      const idle = await page.evaluate(() => window.__playShell.idleRun());
      // Robot ověřovače se všemi vstupy (i míření) – jako e2e střílečky; handPlay bere jen osu a tlačítka, jen pro informaci.
      const bot = await page.evaluate(() => window.__playShell.playWitness());
      const hand = await page.evaluate(() => window.__playShell.handPlay('end'));
      row.hand = `${hand.runState}@${(hand.tick / ARCADE_HZ).toFixed(1)}s`;
      await sleep(1500);
      await page.screenshot({ path: join(out, `${s.id}-end.png`) });
      row.stage = await page.getByTestId('arcade-stage').getAttribute('data-control', { timeout: 2000 }).catch(() => null);
      row.idle = `${idle.runState}@${(idle.tick / ARCADE_HZ).toFixed(1)}s`;
      row.bot = `${bot.runState}@${(bot.tick / ARCADE_HZ).toFixed(1)}s`;
      const wrong = [];
      if (!s.genres.includes(row.genre)) wrong.push(`genre ${row.genre}`);
      if (!s.heroes.includes(head(row.hero ?? ''))) wrong.push(`hero ${row.hero}`);
      if (bot.runState !== 'won') wrong.push(`bot ${row.bot}`);
      if (idle.runState !== 'lost') wrong.push(`idle ${row.idle}`);
      else if (idle.tick < FAIR_START_S * ARCADE_HZ) wrong.push(`idle lost before ${FAIR_START_S}s`);
      if (/\bswim/i.test(`${row.goalLine} ${row.controlsHint}`)) wrong.push('swim hint');
      if (/\bexplorer\b/i.test(row.hero ?? '')) wrong.push('Explorer');
      if (row.banner !== null) wrong.push(`banner "${row.banner}"`);
      row.wrong = wrong;
    } catch (error) {
      row.failed = String(error.message ?? error).slice(0, 300);
      row.wrong = ['failed'];
    }
    row.pageErrors = errors.slice(errorsBefore);
    rows.push(row);
    console.log(`${s.id}: ${row.genre}/${row.hero} (${row.heroModel}) bot ${row.bot} idle ${row.idle}${row.wrong.length ? `  ! ${row.wrong.join(', ')}` : ''}`);
  }
} finally {
  await browser.close();
}
writeFileSync(join(out, 'results.json'), `${JSON.stringify({ date: new Date().toISOString().slice(0, 10), base, viewport: '390x844 dpr2 touch', fairStartS: FAIR_START_S, pass: rows.filter((r) => r.wrong.length === 0).length, n: rows.length, rows }, null, 1)}\n`);
