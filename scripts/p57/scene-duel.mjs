#!/usr/bin/env node
/**
 * P57 T12: slepý soud scén před × po na 12 větách auditu (`audit-12.json`).
 *
 *   node scripts/p57/scene-duel.mjs [--before D:/caches/p57/baseline] [--after D:/caches/p57/after] [--out D:/caches/p57/scene-duel]
 *
 * Pár = věta × pohled (desktop, telefon): list se dvěma panely nad sebou, každý panel snímek
 * ve 2 s a v 15 s (`snap-audit.mjs`). Který panel je „před“, losuje `pure-rand` ze jména páru
 * (`oldFirst` souboje T8r). Soudí Opus a Codex otázkou „která scéna vypadá víc jako hotová hra
 * a víc odpovídá větě“ přes `ask()` – prázdný mkdtemp jen se `sheet.png`. Codex jde přes denní
 * strop P57 (`codex-calls.json`, místní datum); odmítnuté volání zůstane bez odpovědi a další
 * spuštění ho doplní (hotové odpovědi se znovu nečtou). Výsledek: `evals/play/p57/scene-duel.json`.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DUEL_SCHEMA, isDuelAnswer, oldFirst } from './duel.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const RESULT = path.join(ROOT, 'evals/play/p57/scene-duel.json');
export const VIEWS = { d: 'desktop', m: 'phone' };
export const MOMENTS = ['2s', '15s'];
export const JUDGES = ['claude', 'codex'];

export const sceneQuestion = (text) => `The attached image shows two versions of the same small 3D game, made from the sentence "${text}". `
  + 'Panel 1 is on top and panel 2 is below (each label is in its top-left corner); each panel shows the game at 2 seconds (left) and at 15 seconds (right). '
  + 'Which panel looks more like a finished, polished game you would find in an app store, and better matches the sentence? '
  + 'Judge only what is visible. Answer with better: 1 or 2 and one short sentence of reason.';

/** Semínko páru z jeho jména – tentýž pár dostane vždy totéž pořadí. */
export const pairSeed = (key) => createHash('sha256').update(key).digest().readUInt32LE(0);

/** Odpověď soudce → vítěz páru: `after`, `before`, nebo `null`, když odpověď nepřišla. */
export const winnerOf = (answer, beforeFirst) => (isDuelAnswer(answer) ? ((answer.better === 1) === beforeFirst ? 'before' : 'after') : null);

/** Součty výher „po“ na soudce a pohled: `{ claude: { desktop: { after, before, missing } } }`. */
export function tally(pairs) {
  const out = {};
  for (const judge of JUDGES) {
    out[judge] = {};
    for (const view of Object.values(VIEWS)) {
      const votes = pairs.filter((pair) => pair.view === view).map((pair) => pair.votes[judge] ?? null);
      out[judge][view] = { after: votes.filter((vote) => vote === 'after').length, before: votes.filter((vote) => vote === 'before').length, missing: votes.filter((vote) => vote === null).length };
    }
  }
  return out;
}

/** Panel: snímky ve 2 s a v 15 s vedle sebe se štítkem čísla panelu. */
async function panel(sharp, files, label, height) {
  const shots = await Promise.all(files.map((file) => sharp(file).resize({ height }).png().toBuffer({ resolveWithObject: true })));
  const width = shots.reduce((sum, shot) => sum + shot.info.width, 0) + 8;
  const tag = Buffer.from(`<svg width="72" height="72"><rect width="72" height="72" fill="#111"/><text x="36" y="54" font-size="52" font-family="Arial" font-weight="bold" fill="#fff" text-anchor="middle">${label}</text></svg>`);
  return sharp({ create: { width, height, channels: 3, background: '#ffffff' } })
    .composite([{ input: shots[0].data, left: 0, top: 0 }, { input: shots[1].data, left: shots[0].info.width + 8, top: 0 }, { input: tag, left: 0, top: 0 }])
    .png().toBuffer({ resolveWithObject: true });
}

async function sheetOf(sharp, top, bottom, height, file) {
  const [one, two] = [await panel(sharp, top, 1, height), await panel(sharp, bottom, 2, height)];
  const width = Math.max(one.info.width, two.info.width);
  await sharp({ create: { width, height: 2 * height + 24, channels: 3, background: '#ffffff' } })
    .composite([{ input: one.data, left: 0, top: 0 }, { input: two.data, left: 0, top: height + 24 }])
    .png().toFile(file);
}

async function main() {
  if (!process.features.typescript) {
    const run = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', fileURLToPath(import.meta.url), ...process.argv.slice(2)], { stdio: 'inherit' });
    process.exit(run.status ?? 1);
  }
  const { CODEX_DAILY_CAP, COUNTER, takeCodexCall } = await import('./judge-library.mjs');
  const args = process.argv.slice(2);
  const flag = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
  const before = path.resolve(flag('--before', 'D:/caches/p57/baseline'));
  const after = path.resolve(flag('--after', 'D:/caches/p57/after'));
  const out = path.resolve(flag('--out', 'D:/caches/p57/scene-duel'));
  mkdirSync(path.join(out, 'answers'), { recursive: true });
  const { default: sharp } = await import('sharp');
  const { ask } = await import('../p37d/judge-sheet.mjs');
  const schemaFile = path.join(out, 'duel-schema.json');
  writeFileSync(schemaFile, JSON.stringify(DUEL_SCHEMA));
  const today = new Date().toLocaleDateString('sv-SE');
  const sentences = JSON.parse(readFileSync(path.join(ROOT, 'evals/play/p57/audit-12.json'), 'utf8')).sentences;
  const index = { before: JSON.parse(readFileSync(path.join(before, 'index.json'), 'utf8')), after: JSON.parse(readFileSync(path.join(after, 'index.json'), 'utf8')) };

  const pairs = [];
  for (const sentence of sentences) {
    for (const [key, view] of Object.entries(VIEWS)) {
      const id = `${sentence.id}-${key}`;
      const beforeFirst = oldFirst(pairSeed(`p57-scene:${id}`));
      const shots = (dir) => MOMENTS.map((moment) => path.join(dir, `${id}-${moment}.png`));
      const sheet = path.join(out, `${id}.png`);
      if (!existsSync(sheet)) await sheetOf(sharp, ...(beforeFirst ? [shots(before), shots(after)] : [shots(after), shots(before)]), key === 'd' ? 400 : 640, sheet);
      pairs.push({ id, sentence: sentence.text, view, beforeFirst, sheet, votes: {}, reasons: {} });
    }
  }

  const jobs = pairs.flatMap((pair) => JUDGES.map((judge) => ({ pair, judge, answerFile: path.join(out, 'answers', `${pair.id}-${judge}.json`) })));
  const queue = jobs.filter((job) => !existsSync(job.answerFile));
  let refused = 0;
  const worker = async () => {
    for (let job = queue.shift(); job !== undefined; job = queue.shift()) {
      if (job.judge === 'codex' && !takeCodexCall(COUNTER, today, CODEX_DAILY_CAP)) {
        refused += 1;
        continue;
      }
      await ask(job.pair.sheet, schemaFile, job.answerFile, sceneQuestion(job.pair.sentence), job.judge, isDuelAnswer);
      console.log(`${job.pair.id} ${job.judge}: ${existsSync(job.answerFile) ? 'answered' : 'no answer'}`);
    }
  };
  await Promise.all([worker(), worker()]);

  for (const { pair, judge, answerFile } of jobs) {
    const answer = existsSync(answerFile) ? JSON.parse(readFileSync(answerFile, 'utf8')) : null;
    pair.votes[judge] = winnerOf(answer, pair.beforeFirst);
    pair.reasons[judge] = answer?.reason ?? null;
  }
  const result = {
    about: 'P57 T12 blind before/after scene judge, written by scripts/p57/scene-duel.mjs.',
    before: { commit: index.before.commit, dir: before }, after: { commit: index.after.commit, dir: after }, renderer: index.after.renderer,
    tally: tally(pairs),
    pairs: pairs.map(({ sheet, ...pair }) => ({ ...pair, sheet: path.basename(sheet) })),
  };
  writeFileSync(RESULT, `${JSON.stringify(result, null, 1)}\n`);
  console.log(JSON.stringify(result.tally));
  if (refused > 0) console.log(`codex: ${refused} calls over today's cap (${today}), rerun after the date changes`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) await main();
