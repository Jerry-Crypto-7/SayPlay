#!/usr/bin/env node
// P73A T7: pět vět soupeřů + čtyři parafráze přes POST /api/play/games, desktop 1440×900 a telefon 390×844. Ze specu
// hrdina, soupeř a stohovaný díl s modely, ze stránky text pruhu náhrady, robot `__playShell.playWitness()` (ne handPlay).
// Server `next start -p 3201` zvlášť, jeden fotící proces.
// node --experimental-strip-types evals/play/p73/role/oracle.mjs --base http://127.0.0.1:3201
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
await import('../../../../scripts/ts-paths.mjs');
const { heroModel, propModels } = await import('../../../../src/play/arcade/models.ts');
const { ARCADE_HZ } = await import('../../../../src/play/arcade/contract.ts');
const require = createRequire(import.meta.url);
const { chromium } = require('@playwright/test');

const argv = process.argv.slice(2);
const opt = (name, fallback) => (argv.includes(`--${name}`) ? argv[argv.indexOf(`--${name}`) + 1] : fallback);
const base = opt('base', 'http://127.0.0.1:3201');
const out = resolve(ROOT, opt('out', 'evals/play/p73/role'));
mkdirSync(out, { recursive: true });

// banner: regex = pruh musí říct tuhle náhradu, null = nic se nenahrazuje a pruh být nesmí, undefined = jen zapsat.
const SENTENCES = [
  { id: 'p1', text: 'A cat delivering pizzas across rooftops while avoiding seagulls', hero: 'cat', foe: 'seagull', banner: /rooftops aren't here yet/ },
  { id: 'p1b', text: 'a cat delivers pizzas across the rooftops and avoids the seagulls', hero: 'cat', foe: 'seagull', banner: /rooftops aren't here yet/ },
  { id: 'p2', text: 'A haunted library where books fly at you and you must find the exit', banner: /library isn't here yet – it's a spooky forest/ },
  { id: 'p2b', text: 'escape a haunted library while books fly at you', banner: /library isn't here yet/ },
  { id: 'p3', text: 'An underwater race between a turtle and a shark', hero: 'turtle', rival: 'shark', banner: null },
  { id: 'p3b', text: 'a turtle races a shark under the sea', hero: 'turtle', rival: 'shark' },
  { id: 'p4', text: 'Balance a tower of pancakes on a windy day', piece: 'pancake', banner: /Balancing isn't here yet/ },
  { id: 'p4b', text: 'stack pancakes as high as you can in the wind', piece: 'pancake' },
  { id: 'p5', text: 'Escape a volcano before the lava reaches you', notHero: 'blocky-robot', banner: null },
];
const VIEWPORTS = [
  { id: 'desktop', options: { viewport: { width: 1440, height: 900 } } },
  { id: 'phone', options: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true } },
];

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const head = (label) => (label ?? '').toLowerCase().replace(/s$/, '').split(' ').at(-1);

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
  const games = new Map();
  for (const s of SENTENCES) games.set(s.id, await publish(s.text).catch((error) => ({ error: String(error.message ?? error) })));
  for (const viewport of VIEWPORTS) {
    const context = await browser.newContext(viewport.options);
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(String(error.message ?? error).slice(0, 200)));
    for (const s of SENTENCES) {
      const errorsBefore = errors.length;
      const game = games.get(s.id);
      const row = { id: s.id, viewport: viewport.id, sentence: s.text };
      const wrong = [];
      try {
        if (game.error !== undefined) throw new Error(game.error);
        const { versionId, spec } = game;
        const props = propModels(spec);
        Object.assign(row, {
          versionId,
          genre: `${spec.genre?.id ?? spec.control}.${spec.genre?.mode ?? ''}`,
          hero: spec.roles.find((role) => role.kind === 'player')?.label ?? null,
          heroModel: heroModel(spec),
          rival: spec.roles.find((role) => role.id === 'rival')?.label ?? null,
          rivalModel: props.rival ?? null,
          piece: spec.roles.find((role) => role.id === 'block')?.label ?? null,
          pieceModel: props.block ?? null,
          others: spec.roles.filter((role) => role.kind !== 'player').map((role) => `${role.kind}:${role.label}`),
          goalLine: spec.tutorial?.goalLine ?? null,
        });
        await page.goto(`${base}/play/${versionId}`, { timeout: 120_000 });
        await page.locator('canvas').first().waitFor({ timeout: 60_000 });
        await page.waitForFunction(() => typeof window.__playShell?.playWitness === 'function', undefined, { timeout: 60_000 });
        await sleep(4000);
        row.banner = await page.getByTestId('play-honest-reason').first().textContent({ timeout: 1000 }).catch(() => null);
        // Uprostřed hry (start překrývá dialog, konec výherní okno): věž po 8 dílech robota, jinak 3 s živého běhu se soupeřem.
        if (s.piece !== undefined) await page.evaluate(() => window.__playShell.handPlay(8));
        else {
          await page.evaluate(() => window.__playShell.start());
          await sleep(3000);
        }
        await page.screenshot({ path: join(out, `${s.id}-${viewport.id}-mid.png`) });
        // `playWitness` přehraje záznam robota od tiku 0 – snímek uprostřed verdikt neovlivní.
        const bot = await page.evaluate(() => window.__playShell.playWitness());
        row.bot = `${bot.runState}@${(bot.tick / ARCADE_HZ).toFixed(1)}s`;
        if (bot.runState !== 'won') wrong.push(`bot ${row.bot}`);
        if (s.hero !== undefined && (head(row.hero) !== s.hero || !row.heroModel.includes(s.hero))) wrong.push(`hero ${row.hero} (${row.heroModel})`);
        if (s.notHero !== undefined && row.heroModel.includes(s.notHero)) wrong.push(`hero model ${row.heroModel}`);
        if (s.rival !== undefined && (head(row.rival) !== s.rival || row.rivalModel?.includes(s.rival) !== true)) wrong.push(`rival ${row.rival} (${row.rivalModel})`);
        if (s.foe !== undefined && !row.others.some((role) => head(role.split(':')[1]) === s.foe)) wrong.push(`no ${s.foe}`);
        if (s.piece !== undefined && (head(row.piece) !== s.piece || row.pieceModel?.includes(s.piece) !== true)) wrong.push(`piece ${row.piece} (${row.pieceModel})`);
        if (s.banner === null && row.banner !== null) wrong.push(`banner "${row.banner}"`);
        if (s.banner instanceof RegExp && !s.banner.test(row.banner ?? '')) wrong.push(`banner "${row.banner}"`);
      } catch (error) {
        row.failed = String(error.message ?? error).slice(0, 300);
        wrong.push('failed');
      }
      row.wrong = wrong;
      row.pageErrors = errors.slice(errorsBefore);
      rows.push(row);
      console.log(`${s.id}/${viewport.id}: ${row.genre} ${row.hero} (${row.heroModel}) bot ${row.bot} banner ${JSON.stringify(row.banner ?? null)}${wrong.length ? `  ! ${wrong.join(', ')}` : ''}`);
    }
    await context.close();
  }
} finally {
  await browser.close();
}
writeFileSync(join(out, 'results.json'), `${JSON.stringify({ date: new Date().toISOString().slice(0, 10), base, pass: rows.filter((r) => r.wrong.length === 0).length, n: rows.length, rows }, null, 1)}\n`);
