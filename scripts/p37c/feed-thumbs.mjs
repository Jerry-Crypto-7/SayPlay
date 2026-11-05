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
 *
 * `--clips` (P71B T3) místo snímků natočí klipy: pro každou kurátorskou hru (`feed-thumbs.json`) a pro hry
 * z `/api/play/games?recent=40` téhož serveru 3 s okna náhledu robota od `startTick`, 30 snímků za sekundu
 * ručními hodinami (2 tiky na snímek – klip nezávisí na rychlosti stroje), plátno 360×640, ffmpeg do H.264 MP4
 * bez zvuku ≤ 600 kB (`FFMPEG` = cesta k ffmpeg s libx264, jinak `ffmpeg` z PATH). Výstup
 * `public/play/feed-clips/<versionId>.mp4`, seznam do `src/components/play/feed/feed-clips.json`, záznamy
 * v `disclosure.json`; klipy her, které v sadě nejsou, smaže. Řetěz mikroher klip nedostane (sonda
 * `__playShell` řetězu ruční hodiny nemá) – jeho karta si klip nahraje v prohlížeči (`clip-recorder.ts`).
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

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

// ——— Klipy karet (P71B T3) ———

const CLIP_DIR = 'public/play/feed-clips';
const CLIP_VIEWPORT = { width: 360, height: 640 };
const CLIP_FPS = 30;
const CLIP_FRAMES = 90;
const TICKS_PER_FRAME = 2;
const CLIP_MAX_BYTES = 600 * 1024;
const CLIPS_MAX_TOTAL = 60 * 1024 * 1024;
const CLIP_DISCLOSURE = {
  ...DISCLOSURE,
  reason: 'Three-second clip of a Sayplay game, rendered by the project\'s own engine from its stored bot preview and encoded to H.264 with ffmpeg; no third-party footage.',
  source: 'scripts/p37c/feed-thumbs.mjs --clips',
  authorOrProvider: 'Worldsmith project – rendered by scripts/p37c/feed-thumbs.mjs --clips',
  requiredNotices: ['No third-party asset notice; a screen recording of the project\'s own game scene. Models and backdrops in it are registered under their own entries.'],
  attribution: 'Sayplay feed clips, rendered 2026-11-05.',
};

/** Odtiká `ticks` tiků ručními hodinami se vstupy náhledu a počká, až R3F poslední tik vykreslí; `false` = běh skončil. */
async function stepBy(page, inputs, ticks) {
  const running = await page.evaluate(({ inputs, ticks }) => {
    const shell = window.__playShell;
    const target = shell.tick() + ticks;
    while (shell.tick() < target) {
      const tick = shell.tick();
      const event = inputs.find((input) => input.tick === tick);
      shell.hold(event?.axis ?? 0);
      shell.press(event?.buttons ?? 0);
      if (shell.tickByHand().runState !== 'running') return false;
    }
    return true;
  }, { inputs, ticks });
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  return running;
}

/** Snímky PNG → H.264 MP4 bez zvuku; dokud je klip nad stropem, zvedá CRF. */
function encodeClip(frames, out) {
  for (const crf of [28, 32, 36, 40]) {
    execFileSync(process.env.FFMPEG ?? 'ffmpeg', [
      '-y', '-loglevel', 'error', '-framerate', String(CLIP_FPS), '-i', join(frames, 'f%03d.png'),
      '-vf', `scale=${CLIP_VIEWPORT.width}:${CLIP_VIEWPORT.height}:force_original_aspect_ratio=increase,crop=${CLIP_VIEWPORT.width}:${CLIP_VIEWPORT.height},format=yuv420p`,
      '-c:v', 'libx264', '-profile:v', 'main', '-preset', 'slow', '-crf', String(crf), '-movflags', '+faststart', '-an', out,
    ]);
    if (statSync(out).size <= CLIP_MAX_BYTES) return crf;
  }
  throw new Error(`${out}: over ${String(CLIP_MAX_BYTES)} bytes even at CRF 40`);
}

/** Hry pro klipy: kurátorská sada a nejnovější hry serveru; každá s náhledem, řetěz se přeskočí. */
async function clipGames() {
  const builtin = new Map(games.map((game) => [game.version.versionId, game]));
  const curated = JSON.parse(readFileSync(new URL('src/components/play/feed/feed-thumbs.json', ROOT), 'utf8'));
  const listed = await (await fetch(`${BASE}/api/play/games?recent=40`)).json();
  const ids = [...new Set([...curated, ...listed.games.map((game) => game.versionId)])];
  const picked = [];
  for (const versionId of ids) {
    const known = builtin.get(versionId);
    const detail = known ?? (await (await fetch(`${BASE}/api/play/games/${versionId}`)).json());
    const title = known?.version.title ?? detail.spec?.title ?? versionId;
    if (detail.chain !== undefined) console.log(`${versionId} skipped – chain (records in the browser) – ${title}`);
    else if (detail.preview === undefined) console.log(`${versionId} skipped – no bot preview – ${title}`);
    else picked.push({ versionId, title, preview: detail.preview });
  }
  return picked;
}

async function shootClips() {
  mkdirSync(new URL(`${CLIP_DIR}/`, ROOT), { recursive: true });
  const browser = await chromium.launch({ args: [...browserRenderer().args, '--disable-features=OpenXR'] });
  const written = new Set();
  let total = 0;
  try {
    for (const game of await clipGames()) {
      const preview = decodePreview(game.preview);
      const frames = mkdtempSync(join(tmpdir(), 'feed-clip-'));
      const context = await browser.newContext({ viewport: CLIP_VIEWPORT, deviceScaleFactor: 1 });
      try {
        const page = await context.newPage();
        await page.goto(`${BASE}/play/${game.versionId}`);
        await stepTo(page, preview.inputs, preview.startTick);
        await page.addStyleTag({ content: 'body * { visibility: hidden !important; } canvas { visibility: visible !important; }' });
        const canvas = page.locator('canvas').first();
        const count = Math.min(CLIP_FRAMES, Math.floor((preview.endTick - preview.startTick) / TICKS_PER_FRAME));
        for (let frame = 0; frame < count; frame += 1) {
          if (frame > 0 && !(await stepBy(page, preview.inputs, TICKS_PER_FRAME))) break;
          writeFileSync(join(frames, `f${String(frame).padStart(3, '0')}.png`), await canvas.screenshot({ type: 'png' }));
        }
        const name = `${game.versionId}.mp4`;
        const crf = encodeClip(frames, fileURLToPath(new URL(`${CLIP_DIR}/${name}`, ROOT)));
        const size = statSync(new URL(`${CLIP_DIR}/${name}`, ROOT)).size;
        total += size;
        written.add(name);
        console.log(`${name} ${String(Math.round(size / 1024))} KB crf ${String(crf)} ticks ${String(preview.startTick)}+${String(count * TICKS_PER_FRAME)} – ${game.title}`);
      } catch (error) {
        console.log(`${game.versionId} failed – ${String(error.message ?? error).split('\n')[0]} – ${game.title}`);
      } finally {
        await context.close();
        rmSync(frames, { recursive: true, force: true });
      }
    }
  } finally {
    await browser.close();
  }
  if (total > CLIPS_MAX_TOTAL) throw new Error(`clips take ${String(total)} bytes, over the ${String(CLIPS_MAX_TOTAL)} cap`);

  for (const name of readdirSync(new URL(`${CLIP_DIR}/`, ROOT))) if (!written.has(name)) rmSync(new URL(`${CLIP_DIR}/${name}`, ROOT));
  const disclosureFile = new URL('disclosure.json', ROOT);
  const disclosure = JSON.parse(readFileSync(disclosureFile, 'utf8'));
  const isClip = (entry) => entry.kind === 'asset' && entry.name.startsWith(`${CLIP_DIR}/`);
  const others = disclosure.entries.filter((entry) => !isClip(entry));
  const at = disclosure.entries.findIndex(isClip);
  others.splice(at === -1 ? others.length : at, 0, ...[...written].sort().map((name) => ({ name: `${CLIP_DIR}/${name}`, ...CLIP_DISCLOSURE })));
  disclosure.entries = others;
  writeFileSync(disclosureFile, `${JSON.stringify(disclosure, null, 2)}\n`);
  // Feed hledá offline klip jen hrám ze seznamu (`ReelCard.tsx`); jiná hra by dostala 404 místo videa.
  writeFileSync(new URL('src/components/play/feed/feed-clips.json', ROOT), `${JSON.stringify([...written].map((name) => name.replace(/\.mp4$/, '')).sort())}\n`);
  console.log(`${String(written.size)} clips, ${String(Math.round(total / 1024 / 1024))} MB in ${CLIP_DIR}, disclosure.json and feed-clips.json updated`);
}

if (process.argv.includes('--clips')) {
  await shootClips();
  process.exit(0);
}

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
