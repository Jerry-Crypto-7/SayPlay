#!/usr/bin/env node
/**
 * Slepý soud „je postava živá“ nad běžícím serverem (P45D T3).
 *
 *   node scripts/p45d/alive-clip.mjs --run <id> [--base http://127.0.0.1:3245]
 *     [--set evals/play/p43/panel.json] [--toy off] [--gpu] [--only f01,m03] [--max 30]
 *     [--out evals/play/p45d/alive-baseline.json]
 *
 * Pro každou větu sady s hrdinou: návrh hry (`POST /api/play/games`), robot hraje
 * ručními hodinami sondy (`__playShell.byHand`, jako klip `scripts/play-fidelity.mjs`),
 * vzorek po 9 ticích (150 ms hry). Šest po sobě jdoucích vzorků od prvního, kde se
 * hrdina pohnul (promítnutý obdélník `__playFrame().hero`), se ořízne kolem hrdiny
 * a složí do listu 3 × 2. Soudce dostane jen `sheet.png` v prázdném adresáři
 * (`evals/play/p45d/alive.ts`). `--toy off` přidá `?toy=off` – jediný vypínač
 * hračkového pohybu (P45D T5) – a kalibruje, že měřidlo měří pohyb.
 *
 * Listy a odpovědi leží v `evals/play/fidelity/runs/<run>/alive/` (mimo git, nikdy
 * v trénovacích datech); hotová odpověď se při dalším běhu nepřeptává. `--max`
 * hlídá rozpočet volání soudce; dvě selhání soudce po sobě (přihlášení, limit) běh
 * zastaví.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');

if (!process.features.typescript) {
  const run = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', fileURLToPath(import.meta.url), ...process.argv.slice(2)], { stdio: 'inherit' });
  process.exit(run.status ?? 1);
}
await import('../ts-paths.mjs');
const { ALIVE_SCHEMA, askAlive, assertOpenSet, heroOf, rowOf, summary, windowStart } = await import('../../evals/play/p45d/alive.ts');

/** Šest snímků po 9 ticích (150 ms při 60 Hz); hledá se pohyb nejvýš 40 vzorků (6 s hry). */
const FRAMES = 6;
const GAP_TICKS = 9;
const LEAD_TICKS = 30;
const SAMPLES = 40;
const CELL = 320;

// Soudce vidí jen scénu: text stránky (název, věta, HUD) by mu napověděl.
const SCENE_ONLY = { content: 'body * { visibility: hidden !important; } canvas { visibility: visible !important; }' };

const args = process.argv.slice(2);
const flag = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);

/** Pohnul se hrdina mezi dvěma vzorky? Posun nebo změna velikosti obdélníku o víc než 0,5 % obrazu. */
const movedBetween = (before, after) =>
  before !== null && after !== null && ['minX', 'maxX', 'minY', 'maxY'].some((key) => Math.abs(after[key] - before[key]) > 0.01);

/** Výřez kolem všech poloh hrdiny v okně (px), s okrajem; bez hrdiny celý obraz. */
function cropOf(boxes, width, height) {
  const seen = boxes.filter((box) => box !== null && !box.behind);
  if (seen.length === 0) return { left: 0, top: 0, width, height };
  const px = (x) => ((x + 1) / 2) * width;
  const py = (y) => ((1 - y) / 2) * height;
  const left = Math.min(...seen.map((box) => px(box.minX)));
  const right = Math.max(...seen.map((box) => px(box.maxX)));
  const top = Math.min(...seen.map((box) => py(box.maxY)));
  const bottom = Math.max(...seen.map((box) => py(box.minY)));
  const side = Math.min(Math.max(right - left, bottom - top) * 1.6 + 40, Math.min(width, height));
  const cx = (left + right) / 2;
  const cy = (top + bottom) / 2;
  const x = Math.round(Math.min(Math.max(cx - side / 2, 0), width - side));
  const y = Math.round(Math.min(Math.max(cy - side / 2, 0), height - side));
  return { left: x, top: y, width: Math.round(side), height: Math.round(side) };
}

/** Šest snímků hry hrané robotem; `moving` = okno začíná pohybem hrdiny. */
async function capture(page, base, versionId, toyOff) {
  await page.goto(`${base}/play/${versionId}${toyOff ? '?toy=off' : ''}`);
  await page.locator('canvas').first().waitFor({ timeout: 30_000 });
  const robot = await page.waitForFunction(() => typeof window.__playShell?.byHand === 'function', undefined, { timeout: 30_000 }).then(
    () => true,
    () => false,
  );
  if (!robot) return null;
  await page.evaluate(() => window.__playShell.byHand(true));
  await page.getByTestId('play-pause').click();
  await page.getByTestId('play-demo-start').click({ timeout: 30_000 });
  await page.addStyleTag(SCENE_ONLY);
  const step = (count) =>
    page.evaluate(async (ticks) => {
      for (let tick = 0; tick < ticks; tick += 1) if (window.__playShell.tickByHand().runState !== 'running') break;
      // Dva snímky prohlížeče: scéna nakreslí stav po posledním tiku dřív, než ji screenshot vezme.
      await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
      return window.__playFrame?.().hero ?? null;
    }, count);
  const samples = [];
  let hero = await step(LEAD_TICKS);
  for (let index = 0; index < SAMPLES; index += 1) {
    const next = await step(GAP_TICKS);
    samples.push({ hero: next, moved: movedBetween(hero, next), png: await page.screenshot() });
    hero = next;
    const start = windowStart(samples.map((sample) => sample.moved), FRAMES);
    if (samples[start]?.moved && samples.length >= start + FRAMES) break;
  }
  const start = windowStart(samples.map((sample) => sample.moved), FRAMES);
  const window = samples.slice(start, start + FRAMES);
  return { frames: window, moving: window[0]?.moved === true };
}

/** List 3 × 2 ze šesti snímků oříznutých stejným výřezem. */
async function sheetOf(frames, viewport, file) {
  const sharp = (await import('sharp')).default;
  const crop = cropOf(frames.map((frame) => frame.hero), viewport.width, viewport.height);
  const tiles = await Promise.all(
    frames.map((frame) => sharp(frame.png).extract(crop).resize(CELL, CELL, { fit: 'contain', background: '#000000' }).png().toBuffer()),
  );
  await sharp({ create: { width: CELL * 3, height: CELL * 2, channels: 3, background: '#000000' } })
    .composite(tiles.map((input, index) => ({ input, left: (index % 3) * CELL, top: Math.floor(index / 3) * CELL })))
    .png()
    .toFile(file);
}

async function main() {
  const runId = flag('--run');
  if (!runId) throw new Error('--run <id> is required');
  const base = flag('--base', 'http://127.0.0.1:3245');
  const setFile = path.resolve(ROOT, flag('--set', 'evals/play/p43/panel.json'));
  const toyOff = flag('--toy', 'on') === 'off';
  const max = Number(flag('--max', '30'));
  const only = flag('--only') ? new Set(flag('--only').split(',')) : null;
  const sentences = JSON.parse(readFileSync(setFile, 'utf8')).sentences;
  assertOpenSet(setFile, sentences);
  const picked = sentences.filter((sentence) => heroOf(sentence) !== null && (only === null || only.has(sentence.id)));

  const dir = path.join(ROOT, 'evals/play/fidelity/runs', runId, 'alive');
  mkdirSync(dir, { recursive: true });
  const schemaFile = path.join(dir, 'schema.json');
  writeFileSync(schemaFile, JSON.stringify(ALIVE_SCHEMA));

  const require = createRequire(import.meta.url);
  const { chromium } = require('@playwright/test');
  const angle = args.includes('--gpu') ? ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'];
  const browser = await chromium.launch({ args: angle });
  const viewport = { width: 1280, height: 800 };
  const page = await browser.newPage({ viewport });
  const rows = [];
  let calls = 0;
  let failures = 0;
  try {
    for (const sentence of picked) {
      const answerFile = path.join(dir, `${sentence.id}.answer.json`);
      const captureFile = path.join(dir, `${sentence.id}.capture.json`);
      const sheet = path.join(dir, `${sentence.id}.png`);
      if (!existsSync(captureFile)) {
        const response = await fetch(`${base}/api/play/games`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sentence: sentence.text }) });
        const created = await response.json();
        if (!created.versionId) throw new Error(`${sentence.id}: POST ${response.status} ${JSON.stringify(created).slice(0, 200)}`);
        const shot = await capture(page, base, created.versionId, toyOff);
        if (shot === null || shot.frames.length < FRAMES) {
          console.log(`${sentence.id}: no robot or too few frames – skipped`);
          continue;
        }
        await sheetOf(shot.frames, viewport, sheet);
        writeFileSync(captureFile, JSON.stringify({ versionId: created.versionId, moving: shot.moving, frames: shot.frames.length, toy: toyOff ? 'off' : 'on' }));
      }
      const captured = JSON.parse(readFileSync(captureFile, 'utf8'));
      if (!existsSync(answerFile) && calls < max) {
        calls += 1;
        const result = await askAlive(sheet, schemaFile, answerFile);
        if (!existsSync(answerFile)) {
          failures += 1;
          console.log(`${sentence.id}: judge wrote no answer (exit ${result.code}): ${result.stderr}`);
          if (failures >= 2) throw new Error('the judge failed twice in a row – login or limit; stopping');
        } else failures = 0;
      }
      const answer = existsSync(answerFile) ? JSON.parse(readFileSync(answerFile, 'utf8')) : null;
      const row = rowOf(sentence, captured, answer);
      rows.push(row);
      console.log(`${row.id} ${row.noun}: moving ${row.moving ? 'yes' : 'no'}, judge ${answer ? `"${answer.character}" / ${answer.doing} / alive ${answer.alive}` : '–'}`);
    }
  } finally {
    await browser.close();
  }
  const report = {
    about:
      'P45D T3 alive meter: 6 frames 150 ms apart of the robot playing the draft game, cropped around the hero into one 3 x 2 sheet; one blind Codex call per sentence (sheet.png only) answers what the character is (likeNoun = matches the sentence hero) and whether its body moves the way such a thing would (alive). toy = the ?toy=off switch. See scripts/p45d/alive-clip.mjs and evals/play/p45d/README.md.',
    run: runId,
    set: path.relative(ROOT, setFile).replaceAll('\\', '/'),
    toy: toyOff ? 'off' : 'on',
    measuredAt: new Date().toISOString(),
    calls,
    summary: summary(rows),
    rows,
  };
  const out = flag('--out');
  if (out) writeFileSync(path.resolve(ROOT, out), `${JSON.stringify(report, null, 1)}\n`);
  console.log(JSON.stringify(report.summary));
}

await main();
