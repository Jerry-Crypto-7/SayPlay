#!/usr/bin/env node
/**
 * P73D měřidlo scén: 12 vět (10 z QA 6. 11. + dvě navíc) vyfocených na startu a ve dvou okamžicích hry,
 * na desktopu 1440×900 a na telefonu 390×844. T1 „před“, T7 „po“ – stejné věty, semínka a tiky.
 *
 *   node scripts/play/p73d-shots.mjs --port 3204 --out evals/play/p73/sceny/before [--only s1,s4] [--viewports desktop,phone]
 *
 * Přepis `qa-scenes.cjs` ze scratchpadu QA: místo psaní věty do pole a reálného času jde věta přes
 * `POST /api/play/games` s pevným semínkem (stejná hra před i po) a hra běží jako ukázka robota na ručních
 * hodinách (`__playShell.byHand`), takže snímek v 3. a 8. sekundě je pokaždé stejný okamžik.
 * Prohlížeč s GPU přes ANGLE/GL (jako QA), desktop tedy kreslí na kvalitě `high`, telefon (dotyk) na `medium`.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { args, settle } from '../play-look-shots.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(import.meta.url);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

const ARCADE_HZ = 60;
/** Dva okamžiky hry (s simulace); `0` = start před ukázkou. */
export const MOMENTS = [
  { id: '0start', second: 0 },
  { id: '1play', second: 3 },
  { id: '2play', second: 8 },
];

export const SENTENCES = [
  { id: 's1', seed: 73101, text: 'Escape a volcano before the lava reaches you' },
  { id: 's2', seed: 73102, text: 'An underwater race between a turtle and a shark' },
  { id: 's3', seed: 73103, text: 'A cat delivering pizzas across rooftops while avoiding seagulls' },
  { id: 's4', seed: 73104, text: 'Balance a tower of pancakes on a windy day' },
  { id: 's5', seed: 73105, text: 'A knight jumps across floating islands to rescue a dragon egg' },
  { id: 's6', seed: 73106, text: 'A spaceship shoots asteroids in deep space' },
  { id: 's7', seed: 73107, text: 'Play mini golf in a candy land' },
  { id: 's8', seed: 73108, text: 'Find the lost crown in an old castle' },
  { id: 's9', seed: 73109, text: 'A bird flies through a stormy city' },
  { id: 's10', seed: 73110, text: 'A farmer catches falling apples in the orchard' },
  { id: 's11', seed: 73111, text: 'A dog races a cat through a candy land' },
  { id: 's12', seed: 73112, text: 'A penguin slides down an icy mountain' },
];

const VIEWPORTS = {
  desktop: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 },
  phone: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true },
};

/** Karta ukázky robota a hláška poctivosti existují jen kvůli měření; HUD zůstává. */
const MEASURING_ONLY = { content: '.play-demo-note, .play-honest { display: none !important; }' };

async function publish(base, sentence) {
  const response = await fetch(`${base}/api/play/games`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sentence: sentence.text, seed: sentence.seed }) });
  const created = await response.json();
  if (!created.versionId) throw new Error(`${sentence.id}: POST ${response.status} ${JSON.stringify(created).slice(0, 200)}`);
  const body = await (await fetch(`${base}/api/play/games/${created.versionId}`, { cache: 'no-store' })).json();
  const game = body.game ?? body;
  return { versionId: created.versionId, genre: game.spec?.genre?.id ?? null, control: game.spec?.control ?? null, setting: game.spec?.theme?.setting ?? null };
}

const tickTo = (page, tick) =>
  page.evaluate((target) => {
    let state = window.__playShell.tickByHand();
    while (state.tick < target && state.runState === 'running') state = window.__playShell.tickByHand();
    return state;
  }, tick);

async function frame(page, path) {
  await settle(page);
  // Kamera dojede k hrdinovi, který stojí: hodiny jsou ruční a nikdo netiká.
  await sleep(1500);
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
  await page.screenshot({ path, type: 'jpeg', quality: 78, timeout: 120_000 });
  return page.evaluate(() => {
    const frame = window.__playFrame?.();
    if (frame === undefined) return null;
    const [x, y, z, w] = frame.camera.quaternion;
    // Osa pohledu = (0, 0, −1) otočená kvaternionem; sklon = úhel pod vodorovnou.
    const forwardY = -2 * (y * z - w * x);
    const pitch = Math.asin(Math.max(-1, Math.min(1, -forwardY)));
    const half = ((frame.camera.fov ?? 0) * Math.PI) / 360;
    const round = (value) => (value === null || value === undefined ? null : Math.round(value * 1000) / 1000);
    return {
      fov: frame.camera.fov,
      pitchDeg: round((pitch * 180) / Math.PI),
      horizonNdc: half > 0 ? round(Math.tan(pitch) / Math.tan(half)) : null,
      heroNdc: frame.hero === null ? null : { x: round(frame.hero.x), y: round(frame.hero.y) },
      targetNdc: frame.target === null ? null : { x: round(frame.target.x), y: round(frame.target.y) },
    };
  });
}

async function shoot(browser, base, out, sentence, vp) {
  const context = await browser.newContext(VIEWPORTS[vp]);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message.slice(0, 200)));
  const row = { id: sentence.id, vp, frames: [], errors };
  try {
    const game = await publish(base, sentence);
    Object.assign(row, game);
    await page.goto(`${base}/play/${game.versionId}`, { timeout: 120_000 });
    await page.locator('canvas').first().waitFor({ timeout: 60_000 });
    await page.waitForFunction(() => typeof window.__playShell?.byHand === 'function', undefined, { timeout: 60_000 });
    await page.evaluate(() => window.__playShell.byHand(true));
    await page.addStyleTag(MEASURING_ONLY);
    const stage = page.getByTestId('arcade-stage').first();
    row.stage = await stage.getAttribute('data-control').catch(() => null);
    row.look = await stage.getAttribute('data-look').catch(() => null);
    for (const moment of MOMENTS) {
      if (moment.second > 0 && row.frames.length === 1) {
        await page.getByTestId('play-pause').click();
        await page.getByTestId('play-demo-start').click({ timeout: 30_000 });
      }
      const state = moment.second > 0 ? await tickTo(page, moment.second * ARCADE_HZ) : null;
      const file = `${sentence.id}-${vp}-${moment.id}.jpg`;
      const camera = await frame(page, join(out, file));
      row.frames.push({ moment: moment.id, file, tick: state?.tick ?? 0, runState: state?.runState ?? 'ready', camera });
    }
    row.quality = await stage.getAttribute('data-quality').catch(() => null);
  } catch (error) {
    row.error = String(error).slice(0, 300);
  } finally {
    await context.close();
  }
  console.log(`${sentence.id} ${vp}: ${row.genre ?? '?'}/${row.stage ?? '?'}/${row.setting ?? '?'} look ${row.look ?? '?'} q ${row.quality ?? '?'}${row.error ? `  ! ${row.error}` : ''}${errors.length > 0 ? `, ${errors.length} chyb` : ''}`);
  return row;
}

const fmt = (value) => (value === null || value === undefined ? '–' : String(value).replace('.', ','));

/** `index.md` z manifestu: věta, žánr, ovládání, sada prostředí a záběr kamery v 3. s (sklon, obzor, hrdina v NDC). */
function writeIndex(out, manifest, title) {
  const lines = [`# ${title}`, '', `Nafoceno ${manifest.takenAt.slice(0, 16).replace('T', ' ')} skriptem \`scripts/play/p73d-shots.mjs\`. Snímky \`<věta>-<desktop|phone>-<0start|1play|2play>.jpg\`: start, 3. a 8. s ukázky robota na ručních hodinách. Kamera v 3. s: sklon pod vodorovnou (°), obzor a hrdina jako NDC y (+1 horní hrana, −1 dolní).`, '', '| # | věta | žánr | ovládání | sada | pohled | kvalita | sklon | obzor | hrdina |', '|---|---|---|---|---|---|---|---|---|---|'];
  for (const shot of manifest.shots) {
    const text = manifest.sentences.find((item) => item.id === shot.id)?.text ?? '';
    const camera = shot.frames.find((item) => item.moment === '1play')?.camera ?? null;
    lines.push(`| ${shot.id} | ${text} | ${shot.genre ?? '–'} | ${shot.stage ?? shot.control ?? '–'} | ${shot.look ?? shot.setting ?? '–'} | ${shot.vp} | ${shot.quality ?? '–'} | ${fmt(camera?.pitchDeg)} | ${fmt(camera?.horizonNdc)} | ${fmt(camera?.heroNdc?.y)} |${shot.error ? ` chyba: ${shot.error.slice(0, 80)}` : ''}`);
  }
  writeFileSync(join(out, 'index.md'), `${lines.join('\n')}\n`);
}

async function main() {
  const options = args();
  if (options.index === true) {
    const out = resolve(ROOT, typeof options.out === 'string' ? options.out : 'evals/play/p73/sceny/before');
    writeIndex(out, JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8')), typeof options.title === 'string' ? options.title : 'P73D scény');
    return;
  }
  const port = Number(options.port);
  if (!Number.isInteger(port)) throw new Error('needs --port <n>');
  const base = `http://127.0.0.1:${port}`;
  const out = resolve(ROOT, typeof options.out === 'string' ? options.out : 'evals/play/p73/sceny/before');
  mkdirSync(out, { recursive: true });
  const only = typeof options.only === 'string' ? new Set(options.only.split(',')) : null;
  const viewports = typeof options.viewports === 'string' ? options.viewports.split(',') : Object.keys(VIEWPORTS);
  const { chromium } = require('@playwright/test');
  // Bez OpenXR (SteamVR jinak z telefonu udělá brýle), GPU přes ANGLE/GL jako QA 6. 11.
  const browser = await chromium.launch({ args: ['--disable-features=OpenXR', '--use-angle=gl', '--ignore-gpu-blocklist'] });
  const rows = [];
  try {
    for (const sentence of SENTENCES.filter((item) => only === null || only.has(item.id))) {
      for (const vp of viewports) rows.push(await shoot(browser, base, out, sentence, vp));
    }
  } finally {
    await browser.close();
  }
  const manifest = { takenAt: new Date().toISOString(), hz: ARCADE_HZ, moments: MOMENTS, sentences: SENTENCES, shots: rows };
  writeFileSync(join(out, 'manifest.json'), `${JSON.stringify(manifest, null, 1)}\n`);
  if (only === null) writeIndex(out, manifest, typeof options.title === 'string' ? options.title : 'P73D scény');
  const failed = rows.filter((row) => row.error !== undefined).length;
  console.log(`hotovo ${rows.length - failed}/${rows.length}`);
  if (failed > 0) process.exitCode = 1;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
