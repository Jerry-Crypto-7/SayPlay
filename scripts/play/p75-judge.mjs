#!/usr/bin/env node
/**
 * P75 slepý soudce proti konceptu A: pro každou z 12 vět jeden list „A proti B“ – koncept
 * (`evals/play/p75/target/<věta>.png`) a snímek hry (`<game>/<věta>-desktop-<moment>.jpg` se stejným
 * výřezem, jaký koncept přemaloval). Strana hry se losuje ze semínka; klíč leží jen v `judge.json`.
 * Soudce přes `ask()` z `scripts/p37d/judge-sheet.mjs`: list jako `sheet.png` v prázdném `mkdtemp`
 * adresáři (paměť `codex-judge-reads-filenames`), souběh 1. Úspěch věty = hra vyhrála nebo SAME.
 *
 *   node --experimental-strip-types --no-warnings scripts/play/p75-judge.mjs --label main
 *     [--game evals/play/p73/sceny/after] [--moment 1play] [--seed 7501] [--only s1,s4] [--sheets-only] [--judge codex|claude]
 *
 * Každý běh má jméno (`--label`); běhy se v `evals/play/p75/judge.json` sčítají vedle sebe, takže nula
 * nad `main` zůstane zapsaná u pozdějších měření. Listy jako JPEG do `evals/play/p75/judge/<label>/`,
 * tabulka všech běhů do `evals/play/p75/judge.md`. Hotová odpověď se při dalším běhu nepřeptává.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { args } from '../play-look-shots.mjs';
import { sides } from './p73d-judge.mjs';
import { SENTENCES } from './p73d-shots.mjs';
import { CROP, SIZE } from './p75-restyle.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const EVALS = join(ROOT, 'evals', 'play', 'p75');
const require = createRequire(import.meta.url);

export const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['winner', 'reason'],
  properties: { winner: { type: 'string', enum: ['A', 'B', 'SAME'] }, reason: { type: 'string' } },
};

const isVerdict = (value) => ['A', 'B', 'SAME'].includes(value?.winner) && typeof value.reason === 'string';

export const question = (text) =>
  `The attached image shows two pictures, A (left) and B (right), of a game scene for the sentence: "${text}". `
  + 'Which one looks like a better finished game scene? Answer A, B or SAME. '
  + 'Reply only with the JSON the schema asks for: winner = "A", "B" or "SAME", reason = one or two sentences naming what decided it.';

/** Strana hry na listu: `left` z `sides()` je A. Polovina vět A, polovina B, zamíchané ze semínka. */
export const gameSides = (seed, ids) => Object.fromEntries(Object.entries(sides(seed, ids)).map(([id, side]) => [id, side === 'left' ? 'A' : 'B']));

/** Výsledek věty z pohledu hry: `hra` (vyhrála), `SAME`, `koncept` (prohrála), `null` bez odpovědi. */
export function outcome(verdict, gameSide) {
  if (!isVerdict(verdict)) return null;
  if (verdict.winner === 'SAME') return 'SAME';
  return verdict.winner === gameSide ? 'hra' : 'koncept';
}

const dataUrl = (file, type) => `data:image/${type};base64,${readFileSync(file).toString('base64')}`;

/** Hra ořezaná na výřez `CROP` a zmenšená na `SIZE` jako koncept – obě strany ukazují stejný kus scény. */
function gameCell(file) {
  const scale = SIZE.width / CROP.width;
  return `<div class="shot"><img style="width:${1440 * scale}px;left:${-CROP.x * scale}px;top:${-CROP.y * scale}px" src="${dataUrl(file, 'jpeg')}"></div>`;
}

const conceptCell = (file) => `<div class="shot"><img style="width:${SIZE.width}px;left:0;top:0" src="${dataUrl(file, 'png')}"></div>`;

const PAGE_CSS = 'body{margin:0;background:#1d2126;font:600 34px Arial,sans-serif;color:#e8ecef;display:flex;gap:32px;padding:20px;width:max-content}'
  + `section{width:${SIZE.width}px}h1{margin:0 0 10px;font-size:34px;text-align:center}`
  + `.shot{position:relative;overflow:hidden;width:${SIZE.width}px;height:${SIZE.height}px}.shot img{position:absolute;display:block}`;

async function drawSheets(ids, key, gameDir, moment, label) {
  const { chromium } = require('@playwright/test');
  const browser = await chromium.launch();
  const out = join(EVALS, 'judge', label);
  mkdirSync(out, { recursive: true });
  const temp = mkdtempSync(join(os.tmpdir(), 'p75-'));
  const sheets = {};
  try {
    const page = await browser.newPage({ viewport: { width: SIZE.width * 2 + 80, height: SIZE.height + 120 } });
    for (const id of ids) {
      const game = gameCell(join(gameDir, `${id}-desktop-${moment}.jpg`));
      const concept = conceptCell(join(EVALS, 'target', `${id}.png`));
      const [a, b] = key[id] === 'A' ? [game, concept] : [concept, game];
      await page.setContent(`<!doctype html><style>${PAGE_CSS}</style><body><section><h1>A</h1>${a}</section><section><h1>B</h1>${b}</section></body>`);
      const body = await page.$('body');
      await body.screenshot({ path: join(out, `${id}.jpg`), type: 'jpeg', quality: 82 });
      sheets[id] = join(temp, `${id}.png`);
      await body.screenshot({ path: sheets[id], type: 'png' });
    }
  } finally {
    await browser.close();
  }
  return sheets;
}

const LABELS = { hra: '**hra**', SAME: 'SAME', koncept: 'koncept' };

export function passes(run) {
  const results = run.ids.map((id) => outcome(run.answers[id], run.key[id]));
  return { pass: results.filter((value) => value === 'hra' || value === 'SAME').length, judged: results.filter((value) => value !== null).length };
}

function writeReport(runs) {
  const names = Object.keys(runs);
  const summary = names.map((name) => {
    const run = runs[name];
    const { pass, judged } = passes(run);
    const aPicks = run.ids.filter((id) => run.answers[id]?.winner === 'A').length;
    const same = run.ids.filter((id) => run.answers[id]?.winner === 'SAME').length;
    return `| ${name} | \`${run.game}\` · ${run.moment} | ${run.judgedAt.slice(0, 16).replace('T', ' ')} | ${run.seed} | **${pass}/${judged}** | A ${aPicks}× · B ${judged - aPicks - same}× · SAME ${same}× |`;
  });
  const detail = names.flatMap((name) => {
    const run = runs[name];
    return [
      '',
      `## ${name}`,
      '',
      '| # | věta | hra na listu | výsledek | důvod soudce | list |',
      '|---|---|---|---|---|---|',
      ...run.ids.map((id) => {
        const verdict = run.answers[id];
        const result = outcome(verdict, run.key[id]);
        const text = SENTENCES.find((item) => item.id === id).text;
        return `| ${id} | ${text} | ${run.key[id]} | ${result ? LABELS[result] : '–'} | ${verdict ? verdict.reason.replace(/\|/g, '/') : 'bez odpovědi'} | [list](judge/${name}/${id}.jpg) |`;
      }),
    ];
  });
  const lines = [
    '# P75 – slepý soudce proti konceptu A',
    '',
    'Skript `scripts/play/p75-judge.mjs`. Každý list: vlevo A, vpravo B – koncept A (`target/<věta>.png`, FLUX.2-klein přemalování snímku hry) a desktopový snímek hry se stejným výřezem; strana hry losovaná ze semínka, klíč jen v `judge.json`. Soudce Codex (`codex exec -i sheet.png` v prázdném dočasném adresáři), otázka:',
    '',
    `> ${question('<věta>')}`,
    '',
    'Věta projde, když hra vyhraje nebo soudce řekne SAME. **Brána T8: aspoň 4/12.**',
    '',
    '| běh | hra | souzeno | semínko | hra ≥ SAME | volby soudce |',
    '|---|---|---|---|---|---|',
    ...summary,
    ...detail,
  ];
  writeFileSync(join(EVALS, 'judge.md'), `${lines.join('\n')}\n`);
}

async function main() {
  const options = args();
  const label = typeof options.label === 'string' ? options.label : 'main';
  const gameDir = resolve(ROOT, typeof options.game === 'string' ? options.game : 'evals/play/p73/sceny/after');
  const moment = typeof options.moment === 'string' ? options.moment : '1play';
  const seed = Number(options.seed ?? 7501);
  const judge = options.judge === 'claude' ? 'claude' : 'codex';
  const only = typeof options.only === 'string' ? new Set(options.only.split(',')) : null;
  const allIds = SENTENCES.map((item) => item.id);
  const ids = allIds.filter((id) => only === null || only.has(id));
  const keyFile = join(EVALS, 'judge.json');
  const stored = existsSync(keyFile) ? JSON.parse(readFileSync(keyFile, 'utf8')) : { runs: {} };
  const previous = stored.runs[label];
  const game = relative(ROOT, gameDir).replace(/\\/g, '/');
  const same = previous?.seed === seed && previous.moment === moment && previous.game === game && previous.judge === judge;
  const key = gameSides(seed, allIds);
  const answers = same ? previous.answers : {};
  const sheets = await drawSheets(ids, key, gameDir, moment, label);
  const run = { seed, judge, game, moment, judgedAt: new Date().toISOString(), ids: allIds, key, answers };
  const save = () => writeFileSync(keyFile, `${JSON.stringify({ ...stored, runs: { ...stored.runs, [label]: run } }, null, 1)}\n`);
  if (options['sheets-only'] !== true) {
    const { ask } = await import('../p37d/judge-sheet.mjs');
    const work = mkdtempSync(join(os.tmpdir(), 'p75-'));
    const schemaFile = join(work, 'schema.json');
    writeFileSync(schemaFile, JSON.stringify(SCHEMA));
    for (const id of ids) {
      if (isVerdict(answers[id])) continue;
      const answerFile = join(work, `${id}.json`);
      const result = await ask(sheets[id], schemaFile, answerFile, question(SENTENCES.find((item) => item.id === id).text), judge, isVerdict);
      try {
        const verdict = JSON.parse(readFileSync(answerFile, 'utf8'));
        if (isVerdict(verdict)) answers[id] = verdict;
      } catch { /* bez odpovědi */ }
      console.log(`${id}: ${answers[id] ? `${answers[id].winner} (hra ${key[id]}) ${result.seconds} s` : `bez odpovědi, exit ${result.code}: ${result.stderr}`}`);
      save();
    }
  }
  save();
  writeReport({ ...stored.runs, [label]: run });
  const { pass, judged } = passes(run);
  console.log(`${label}: hra ≥ SAME ${pass}/${judged}`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
