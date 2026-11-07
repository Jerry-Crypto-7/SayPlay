#!/usr/bin/env node
/**
 * P76: listy pro majitele a soudce P73D „po proti `main`“ – kopie `p75-vs-main.mjs` s cestami P76.
 *
 * 1. `--sheets <složka>`: list `<složka>/<věta>.jpg` – před (`main` bez P75, `evals/play/p73/sceny/after`) | P75
 *    (`evals/play/p75/after`) | po (`evals/play/p76/after`), řádek desktop start + 3. s, řádek telefon start + 3. s.
 *    Jen k prohlížení okem (T1, T2), soudce je nevidí.
 * 2. Bez `--sheets`: slepý soudce jako P75 T8 (`p73d-judge.mjs`: stejná otázka, schéma, losování stran a `ask()`),
 *    `main` proti P76. Listy a klíč do `evals/play/p76/vs-main/`, tabulka do `evals/play/p76/vs-main.md`. Hotová
 *    odpověď se při dalším běhu nepřeptává; `--fresh` začne znovu.
 *
 *   node --experimental-strip-types --no-warnings scripts/play/p76-vs-main.mjs [--seed 7309] [--only s1,s4] [--sheets evals/play/p76/t1] [--fresh]
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { args } from '../play-look-shots.mjs';
import { question, SCHEMA, sides } from './p73d-judge.mjs';
import { SENTENCES } from './p73d-shots.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = join(ROOT, 'evals', 'play', 'p76');
const MAIN = join(ROOT, 'evals', 'play', 'p73', 'sceny', 'after');
const P75 = join(ROOT, 'evals', 'play', 'p75', 'after');
const AFTER = join(OUT, 'after');
const require = createRequire(import.meta.url);

const isVerdict = (value) => (value?.winner === 'left' || value?.winner === 'right') && typeof value.reason === 'string';
const dataUrl = (file) => `data:image/${file.endsWith('.png') ? 'png' : 'jpeg'};base64,${readFileSync(file).toString('base64')}`;
const shot = (dir, id, vp, moment) => dataUrl(join(dir, `${id}-${vp}-${moment}.jpg`));
const cell = (src, caption, cls) => `<figure class="${cls}"><img src="${src}"><figcaption>${caption}</figcaption></figure>`;

/** Strana listu soudce jako v P73D T9: desktop start + 3. s nahoře, telefon start + 3. s dole, bez jmen souborů. */
function panel(label, dir, id) {
  return `<section><h1>${label}</h1>`
    + `<div class="row">${cell(shot(dir, id, 'desktop', '0start'), 'desktop · start', 'wide')}${cell(shot(dir, id, 'desktop', '1play'), 'desktop · 3 s', 'wide')}</div>`
    + `<div class="row">${cell(shot(dir, id, 'phone', '0start'), 'phone · start', 'tall')}${cell(shot(dir, id, 'phone', '1play'), 'phone · 3 s', 'tall')}</div></section>`;
}

const JUDGE_CSS = 'body{margin:0;background:#1d2126;font:600 18px Arial,sans-serif;color:#e8ecef;display:flex;gap:40px;padding:20px;width:max-content}'
  + 'section{width:960px}h1{margin:0 0 10px;font-size:34px;text-align:center}.row{display:flex;justify-content:center;gap:16px;margin-bottom:12px}'
  + 'figure{margin:0;text-align:center}figcaption{margin-top:4px;font-size:16px;color:#b4bcc4}.wide img{width:472px;height:295px}.tall img{height:560px;width:259px}';

async function withPage(work) {
  const { chromium } = require('@playwright/test');
  const browser = await chromium.launch();
  try {
    return await work(await browser.newPage({ viewport: { width: 3000, height: 1000 } }));
  } finally {
    await browser.close();
  }
}

/** Listy pro oko: před | P75 | po, každý se stranou jako soudce (desktop nahoře, telefon dole). */
async function ownerSheets(ids, dir) {
  mkdirSync(dir, { recursive: true });
  await withPage(async (page) => {
    for (const id of ids) {
      const text = SENTENCES.find((item) => item.id === id).text;
      await page.setContent(
        `<!doctype html><style>${JUDGE_CSS}p{margin:0 0 8px;font-size:22px}</style><body><div><p>${id} · ${text}</p><div style="display:flex;gap:40px">`
          + `${panel('před (main)', MAIN, id)}${panel('P75', P75, id)}${panel('po (P76)', AFTER, id)}</div></div></body>`,
      );
      await (await page.$('body')).screenshot({ path: join(dir, `${id}.jpg`), type: 'jpeg', quality: 80 });
    }
  });
}

async function judgeSheets(ids, key) {
  const judged = join(OUT, 'vs-main');
  mkdirSync(judged, { recursive: true });
  const temp = mkdtempSync(join(os.tmpdir(), 'p76v-'));
  const sheets = {};
  await withPage(async (page) => {
    for (const id of ids) {
      const dirs = key[id] === 'left' ? [AFTER, MAIN] : [MAIN, AFTER];
      await page.setContent(`<!doctype html><style>${JUDGE_CSS}</style><body>${panel('LEFT', dirs[0], id)}${panel('RIGHT', dirs[1], id)}</body>`);
      const body = await page.$('body');
      await body.screenshot({ path: join(judged, `${id}.jpg`), type: 'jpeg', quality: 82 });
      sheets[id] = join(temp, `${id}.png`);
      await body.screenshot({ path: sheets[id], type: 'png' });
    }
  });
  return sheets;
}

function writeReport(result) {
  const rows = result.ids.map((id) => {
    const text = SENTENCES.find((item) => item.id === id).text;
    const verdict = result.answers[id];
    const after = result.key[id];
    const won = verdict ? (verdict.winner === after ? '**po**' : 'main') : '–';
    return `| ${id} | ${text} | ${after === 'left' ? 'vlevo' : 'vpravo'} | ${won} | ${verdict ? verdict.reason.replace(/\|/g, '/') : 'bez odpovědi'} | [list](vs-main/${id}.jpg) · [před/P75/po](sheets/${id}.jpg) |`;
  });
  const judged = result.ids.filter((id) => result.answers[id]);
  const wins = judged.filter((id) => result.answers[id].winner === result.key[id]).length;
  const leftPicks = judged.filter((id) => result.answers[id].winner === 'left').length;
  const lines = [
    '# P76 T4 – slepý soudce P73D: větev proti `main` bez P75',
    '',
    `Souzeno ${result.judgedAt.slice(0, 16).replace('T', ' ')} skriptem \`scripts/play/p76-vs-main.mjs\` (semínko ${result.seed}). Main = \`evals/play/p73/sceny/after\` (stejné „před“ jako P75 T8), po = \`evals/play/p76/after\`. List, otázka a losování stran jako P73D T9 (\`p73d-judge.mjs\`):`,
    '',
    `> ${question('<věta>')}`,
    '',
    `**Výsledek: „po“ vyhrálo ${wins}/${judged.length}** (brána ≥ 10/12; P75 T8 9/12). Soudce zvolil levou stranu ${leftPicks}×, pravou ${judged.length - leftPicks}× (strana „po“ vlevo ${result.ids.filter((id) => result.key[id] === 'left').length}×).`,
    '',
    '| # | věta | „po“ na listu | vyhrálo | důvod soudce | listy |',
    '|---|---|---|---|---|---|',
    ...rows,
  ];
  writeFileSync(join(OUT, 'vs-main.md'), `${lines.join('\n')}\n`);
  return { wins, judged: judged.length };
}

async function main() {
  const options = args();
  const seed = Number(options.seed ?? 7309);
  const only = typeof options.only === 'string' ? new Set(options.only.split(',')) : null;
  const allIds = SENTENCES.map((item) => item.id);
  const ids = allIds.filter((id) => only === null || only.has(id));
  if (typeof options.sheets === 'string') {
    await ownerSheets(ids, resolve(ROOT, options.sheets));
    console.log(`listy ${ids.join(',')} → ${options.sheets}`);
    return;
  }
  await ownerSheets(ids, join(OUT, 'sheets'));
  const keyFile = join(OUT, 'vs-main', 'judge.json');
  const previous = existsSync(keyFile) && options.fresh !== true ? JSON.parse(readFileSync(keyFile, 'utf8')) : null;
  const key = sides(seed, allIds);
  const answers = previous?.seed === seed ? previous.answers : {};
  for (const id of ids) if (options.fresh === true) delete answers[id];
  const sheets = await judgeSheets(ids, key);
  const result = { seed, judgedAt: new Date().toISOString(), ids: allIds, key, answers };
  const { ask } = await import('../p37d/judge-sheet.mjs');
  const work = mkdtempSync(join(os.tmpdir(), 'p76v-'));
  const schemaFile = join(work, 'schema.json');
  writeFileSync(schemaFile, JSON.stringify(SCHEMA));
  for (const id of ids) {
    if (isVerdict(answers[id])) continue;
    const answerFile = join(work, `${id}.json`);
    const run = await ask(sheets[id], schemaFile, answerFile, question(SENTENCES.find((item) => item.id === id).text), 'codex', isVerdict);
    try {
      const verdict = JSON.parse(readFileSync(answerFile, 'utf8'));
      if (isVerdict(verdict)) answers[id] = verdict;
    } catch {
      /* bez odpovědi */
    }
    console.log(`${id}: ${answers[id] ? `${answers[id].winner} (po ${key[id]}) ${run.seconds} s` : `bez odpovědi, exit ${run.code}: ${run.stderr}`}`);
    writeFileSync(keyFile, `${JSON.stringify({ ...result, answers }, null, 1)}\n`);
  }
  writeFileSync(keyFile, `${JSON.stringify(result, null, 1)}\n`);
  const { wins, judged } = writeReport(result);
  console.log(`po vyhrálo ${wins}/${judged}`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
