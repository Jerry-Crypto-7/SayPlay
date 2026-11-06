#!/usr/bin/env node
/**
 * P73D T9 slepý soudce: pro každou z 12 vět jeden list „levá proti pravé“ – před (T1, `main`) a po
 * (konečný stav větve), každá strana desktop start + 3. s nahoře a telefon start + 3. s dole.
 * Strana „po“ se losuje ze semínka; klíč leží v `<out>/judge.json`, nikdy vedle listu.
 * Soudce je Codex přes `ask()` z `scripts/p37d/judge-sheet.mjs`: list jako `sheet.png` v prázdném
 * `mkdtemp` adresáři (paměť `codex-judge-reads-filenames`), souběh 1.
 *
 *   node --experimental-strip-types --no-warnings scripts/play/p73d-judge.mjs [--seed 7309] [--only s1,s4] [--sheets-only]
 *   (`judge-sheet.mjs` tahá přes `qa-astra.mjs` i `.ts` z `src/play/draft`; Node 22.17 je bez přepínače nenačte.)
 *
 * Listy jako JPEG do `evals/play/p73/sceny/judge/<věta>.jpg`, odpovědi a klíč do `judge.json`,
 * tabulka do `evals/play/p73/sceny/judge.md`. Hotová odpověď se při dalším běhu nepřeptává.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { args } from '../play-look-shots.mjs';
import { SENTENCES } from './p73d-shots.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCENES = join(ROOT, 'evals', 'play', 'p73', 'sceny');
const require = createRequire(import.meta.url);

export const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['winner', 'reason'],
  properties: { winner: { type: 'string', enum: ['left', 'right'] }, reason: { type: 'string' } },
};

const isVerdict = (value) => (value?.winner === 'left' || value?.winner === 'right') && typeof value.reason === 'string';

export const question = (text) =>
  `The attached image shows two versions, LEFT and RIGHT, of the same game generated from the sentence: "${text}". `
  + 'Both sides run the same game with the same seed and are captured at the same moments: the desktop screen at the start and 3 seconds into play (top row), and the phone screen at the start and 3 seconds into play (bottom row). Compare only how the scene looks. '
  + 'Which looks like a modern 2026 game with clear depth and a sensible place for this sentence: left or right? '
  + 'Reply only with the JSON the schema asks for: winner = "left" or "right", reason = one or two sentences naming what decided it.';

/**
 * Strana „po“ u každé věty: polovina vlevo, polovina vpravo, zamíchané ze semínka (mulberry32 + Fisher–Yates),
 * ať se zaujatost soudce k jedné straně vyruší.
 */
export function sides(seed, ids) {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const order = ids.map((_, index) => (index % 2 === 0 ? 'left' : 'right'));
  for (let index = order.length - 1; index > 0; index -= 1) {
    const other = Math.floor(next() * (index + 1));
    [order[index], order[other]] = [order[other], order[index]];
  }
  return Object.fromEntries(ids.map((id, index) => [id, order[index]]));
}

const dataUrl = (file) => `data:image/jpeg;base64,${readFileSync(file).toString('base64')}`;

/** Jedna strana listu: popisek, dva desktopové snímky nahoře, dva telefonní dole. Žádné jméno souboru ani „před/po“. */
function panel(label, dir, id) {
  const shot = (vp, moment) => dataUrl(join(dir, `${id}-${vp}-${moment}.jpg`));
  const cell = (src, caption, cls) => `<figure class="${cls}"><img src="${src}"><figcaption>${caption}</figcaption></figure>`;
  return `<section><h1>${label}</h1>`
    + `<div class="row">${cell(shot('desktop', '0start'), 'desktop · start', 'wide')}${cell(shot('desktop', '1play'), 'desktop · 3 s', 'wide')}</div>`
    + `<div class="row">${cell(shot('phone', '0start'), 'phone · start', 'tall')}${cell(shot('phone', '1play'), 'phone · 3 s', 'tall')}</div></section>`;
}

const PAGE_CSS = 'body{margin:0;background:#1d2126;font:600 18px Arial,sans-serif;color:#e8ecef;display:flex;gap:40px;padding:20px;width:max-content}'
  + 'section{width:960px}h1{margin:0 0 10px;font-size:34px;text-align:center}.row{display:flex;justify-content:center;gap:16px;margin-bottom:12px}'
  + 'figure{margin:0;text-align:center}figcaption{margin-top:4px;font-size:16px;color:#b4bcc4}.wide img{width:472px;height:295px}.tall img{height:560px;width:259px}';

async function drawSheets(ids, key) {
  const { chromium } = require('@playwright/test');
  const browser = await chromium.launch();
  const out = join(SCENES, 'judge');
  mkdirSync(out, { recursive: true });
  const temp = mkdtempSync(join(os.tmpdir(), 'p73d-'));
  const sheets = {};
  try {
    const page = await browser.newPage({ viewport: { width: 2040, height: 1000 } });
    for (const id of ids) {
      const dirs = key[id] === 'left' ? [join(SCENES, 'after'), join(SCENES, 'before')] : [join(SCENES, 'before'), join(SCENES, 'after')];
      await page.setContent(`<!doctype html><style>${PAGE_CSS}</style><body>${panel('LEFT', dirs[0], id)}${panel('RIGHT', dirs[1], id)}</body>`);
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

function writeReport(result) {
  const rows = result.ids.map((id) => {
    const text = SENTENCES.find((item) => item.id === id).text;
    const verdict = result.answers[id];
    const after = result.key[id];
    const won = verdict ? (verdict.winner === after ? '**po**' : 'před') : '–';
    return `| ${id} | ${text} | ${after === 'left' ? 'vlevo' : 'vpravo'} | ${won} | ${verdict ? verdict.reason.replace(/\|/g, '/') : 'bez odpovědi'} | [list](judge/${id}.jpg) |`;
  });
  const judged = result.ids.filter((id) => result.answers[id]);
  const wins = judged.filter((id) => result.answers[id].winner === result.key[id]).length;
  const leftPicks = judged.filter((id) => result.answers[id].winner === 'left').length;
  const lines = [
    '# P73D T9 – slepý soudce',
    '',
    `Souzeno ${result.judgedAt.slice(0, 16).replace('T', ' ')} skriptem \`scripts/play/p73d-judge.mjs\` (semínko ${result.seed}). Před = T1 na \`main\` 0dc32f8e (\`before/\`), po = konečný stav větve po T8b (\`after/\`). Každý list: desktop start a 3. s nahoře, telefon start a 3. s dole; strana „po“ losovaná ze semínka, klíč jen v \`judge.json\`. Soudce Codex (\`codex exec -i sheet.png\` v prázdném dočasném adresáři), otázka:`,
    '',
    `> ${question('<věta>')}`,
    '',
    `**Výsledek: „po“ vyhrálo ${wins}/${judged.length}** (brána ≥ 10/12). Soudce zvolil levou stranu ${leftPicks}×, pravou ${judged.length - leftPicks}× (strana „po“ vlevo ${result.ids.filter((id) => result.key[id] === 'left').length}×).`,
    '',
    '| # | věta | „po“ na listu | vyhrálo | důvod soudce | list |',
    '|---|---|---|---|---|---|',
    ...rows,
  ];
  writeFileSync(join(SCENES, 'judge.md'), `${lines.join('\n')}\n`);
  return { wins, judged: judged.length };
}

async function main() {
  const options = args();
  const seed = Number(options.seed ?? 7309);
  const only = typeof options.only === 'string' ? new Set(options.only.split(',')) : null;
  const ids = SENTENCES.map((item) => item.id).filter((id) => only === null || only.has(id));
  const keyFile = join(SCENES, 'judge.json');
  const previous = existsSync(keyFile) ? JSON.parse(readFileSync(keyFile, 'utf8')) : null;
  const key = sides(seed, SENTENCES.map((item) => item.id));
  const answers = previous?.seed === seed ? previous.answers : {};
  const sheets = await drawSheets(ids, key);
  const result = { seed, judgedAt: new Date().toISOString(), ids: SENTENCES.map((item) => item.id), key, answers };
  if (options['sheets-only'] !== true) {
    const { ask } = await import('../p37d/judge-sheet.mjs');
    const work = mkdtempSync(join(os.tmpdir(), 'p73d-'));
    const schemaFile = join(work, 'schema.json');
    writeFileSync(schemaFile, JSON.stringify(SCHEMA));
    for (const id of ids) {
      if (isVerdict(answers[id])) continue;
      const answerFile = join(work, `${id}.json`);
      const run = await ask(sheets[id], schemaFile, answerFile, question(SENTENCES.find((item) => item.id === id).text), 'codex', isVerdict);
      try {
        const verdict = JSON.parse(readFileSync(answerFile, 'utf8'));
        if (isVerdict(verdict)) answers[id] = verdict;
      } catch { /* bez odpovědi */ }
      console.log(`${id}: ${answers[id] ? `${answers[id].winner} (po ${key[id]}) ${run.seconds} s` : `bez odpovědi, exit ${run.code}: ${run.stderr}`}`);
      writeFileSync(keyFile, `${JSON.stringify({ ...result, answers }, null, 1)}\n`);
    }
  }
  writeFileSync(keyFile, `${JSON.stringify(result, null, 1)}\n`);
  const { wins, judged } = writeReport(result);
  console.log(`po vyhrálo ${wins}/${judged}`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
