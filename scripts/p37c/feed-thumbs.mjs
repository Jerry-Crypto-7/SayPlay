#!/usr/bin/env node
/**
 * Snímky karet feedu (P54A T3): pro každou vestavěnou hru (`builtin-games.json`, `builtin-feed-games.json` a
 * nahrazené hry feedu P54A `builtin-feed-p54a.json`, které platí jen odkazem – R3 P70C)
 * otevře nad běžícím `next start` stránku `/play/<versionId>`, odehraje skript
 * náhledu robota (`preview`, T2) ručními hodinami do `startTick + 120` a vyfotí
 * plátno na výšku (720×1280) i na šířku (1280×720) do
 * `public/feed-thumbs/<versionId>-{p,l}.webp`, každý ≤ 40 KB. Feed je ukáže na
 * kartě, kterou návštěvník ještě nenavštívil.
 *
 *   FEED_THUMBS_URL=http://127.0.0.1:3291 node --experimental-strip-types scripts/p37c/feed-thumbs.mjs [--missing]
 *
 * Server musí běžet z buildu se stejnými třemi soubory her. Snímky her, které
 * ze sady vypadly, smaže (soubor her vynechaný ze seznamu níž = jeho snímky pryč) a `disclosure.json` srovná s tím, co v adresáři leží;
 * seznam her se snímkem zapíše do `src/components/play/feed/feed-thumbs.json`.
 * `--missing` (P70C T4) vyfotí jen hry, kterým snímek chybí – zmrazené sadě, jejíž
 * náhled se nezměnil, tak nepřepíše obrázky, které už leží v gitu.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

import { chromium } from '@playwright/test';

await import('../ts-paths.mjs');
const { decodePreview } = await import('../../src/play/version/preview.ts');
const { browserRenderer } = await import('../browser-renderer.ts');

const ROOT = new URL('../../', import.meta.url);
const DIR = 'public/feed-thumbs';
const BASE = process.env.FEED_THUMBS_URL ?? 'http://127.0.0.1:3291';
const MAX_BYTES = 40 * 1024;
/** Tiků po začátku okna náhledu – hrdina už je v akci, ale okno ještě běží. */
const SHOT_AFTER_TICKS = 120;
const VIEWPORTS = { p: { width: 720, height: 1280 }, l: { width: 1280, height: 720 } };

const DISCLOSURE = {
  kind: 'asset',
  firstParty: true,
  reason: 'Still picture of a built-in Sayplay game, rendered by the project\'s own engine from its stored bot preview; no third-party image.',
  source: 'scripts/p37c/feed-thumbs.mjs',
  authorOrProvider: 'Worldsmith project – rendered by scripts/p37c/feed-thumbs.mjs',
  license: 'LicenseRef-Worldsmith-Original',
  requiredNotices: ['No third-party asset notice; a screenshot of the project\'s own game scene. Models and backdrops in it are registered under their own entries.'],
  attribution: 'Sayplay feed thumbnails, rendered 2026-10-21.',
  reviewNote: 'First-party render of the game engine; every model and texture in the frame is already listed in disclosure.json. No new license grant is asserted.',
  scope: 'prod',
};

/** Odehraje vstupy náhledu ručními hodinami do `target` (bez reálného času – snímek je deterministický). */
async function stepTo(page, inputs, target) {
  await page.waitForFunction(() => window.__playShell?.byHand !== undefined && window.__playShell.physicsReady(), undefined, { timeout: 60_000 });
  await page.evaluate(({ inputs, target }) => {
    const shell = window.__playShell;
    shell.start();
    shell.byHand(true);
    let next = 0;
    while (shell.tick() < target) {
      const tick = shell.tick();
      while (next < inputs.length && inputs[next].tick < tick) next += 1;
      const event = inputs[next]?.tick === tick ? inputs[next] : undefined;
      shell.hold(event?.axis ?? 0);
      shell.press(event?.buttons ?? 0);
      if (shell.tickByHand().runState !== 'running') break;
    }
  }, { inputs, target });
  // Dva snímky: React promítne poslední tik do scény, R3F ho vykreslí.
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

/** PNG plátna → WebP do `MAX_BYTES`: nejdřív kvalita, pak zmenšení. */
async function toWebp(encoder, png) {
  const data = await encoder.evaluate(async ({ b64, max }) => {
    const image = new Image();
    image.src = `data:image/png;base64,${b64}`;
    await image.decode();
    for (const scale of [1, 0.85, 0.7]) {
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(image.width * scale);
      canvas.height = Math.round(image.height * scale);
      canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
      for (const quality of [0.8, 0.7, 0.6, 0.5, 0.4]) {
        const url = canvas.toDataURL('image/webp', quality);
        if ((url.length - url.indexOf(',') - 1) * 0.75 <= max) return url.slice(url.indexOf(',') + 1);
      }
    }
    return null;
  }, { b64: png.toString('base64'), max: MAX_BYTES });
  if (data === null) throw new Error('could not fit the picture under 40 KB');
  return Buffer.from(data, 'base64');
}

const games = ['builtin-games.json', 'builtin-feed-games.json', 'builtin-feed-p54a.json'].flatMap((file) => JSON.parse(readFileSync(new URL(`src/play/version/${file}`, ROOT), 'utf8')));
mkdirSync(new URL(`${DIR}/`, ROOT), { recursive: true });
// Tytéž přepínače vykreslování jako e2e (`playwright.config.ts`): místně skutečné GPU.
const browser = await chromium.launch({ args: browserRenderer().args });
const encoder = await (await browser.newContext()).newPage();
const written = new Set();
const missingOnly = process.argv.includes('--missing');
const thumbName = (game, suffix) => `${game.version.versionId}-${suffix}.webp`;
for (const game of games) {
  if (missingOnly && Object.keys(VIEWPORTS).every((suffix) => existsSync(new URL(`${DIR}/${thumbName(game, suffix)}`, ROOT)))) {
    for (const suffix of Object.keys(VIEWPORTS)) written.add(thumbName(game, suffix));
    continue;
  }
  const preview = decodePreview(game.preview);
  const target = Math.min(preview.startTick + SHOT_AFTER_TICKS, preview.endTick - 1);
  for (const [suffix, viewport] of Object.entries(VIEWPORTS)) {
    const context = await browser.newContext({ viewport, deviceScaleFactor: 1 });
    const page = await context.newPage();
    await page.goto(`${BASE}/play/${game.version.versionId}`);
    await stepTo(page, preview.inputs, target);
    // Jen scéna: HUD, titulek a lišty nad plátnem se schovají, plátno zůstane.
    await page.addStyleTag({ content: 'body * { visibility: hidden !important; } canvas { visibility: visible !important; }' });
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
    const webp = await toWebp(encoder, await page.locator('canvas').first().screenshot({ type: 'png' }));
    const name = thumbName(game, suffix);
    writeFileSync(new URL(`${DIR}/${name}`, ROOT), webp);
    written.add(name);
    console.log(`${name} ${String(Math.round(webp.length / 1024))} KB tick ${String(target)} – ${game.version.title}`);
    await context.close();
  }
}
await browser.close();

for (const name of readdirSync(new URL(`${DIR}/`, ROOT))) if (!written.has(name)) rmSync(new URL(`${DIR}/${name}`, ROOT));
const disclosureFile = new URL('disclosure.json', ROOT);
const disclosure = JSON.parse(readFileSync(disclosureFile, 'utf8'));
const isThumb = (entry) => entry.kind === 'asset' && entry.name.startsWith(`${DIR}/`);
// Na místě dosavadních záznamů, ne na konec: přegenerování nepřehází tisíce řádků souboru.
const others = disclosure.entries.filter((entry) => !isThumb(entry));
const at = disclosure.entries.findIndex(isThumb);
others.splice(at === -1 ? others.length : at, 0, ...[...written].sort().map((name) => ({ name: `${DIR}/${name}`, ...DISCLOSURE })));
disclosure.entries = others;
writeFileSync(disclosureFile, `${JSON.stringify(disclosure, null, 2)}\n`);
// Feed bere snímek jen hrám ze seznamu (`snapshot-cache.ts`); jiná hra by dostala 404 místo obrázku.
writeFileSync(new URL('src/components/play/feed/feed-thumbs.json', ROOT), `${JSON.stringify(games.map((game) => game.version.versionId).sort())}\n`);
console.log(`${String(written.size)} pictures in ${DIR}, disclosure.json and feed-thumbs.json updated`);
