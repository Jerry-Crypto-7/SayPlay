#!/usr/bin/env node
/**
 * P75 T8: listy pro majitele a soudce P73D „po proti `main`“.
 *
 * 1. `evals/play/p75/sheets/<věta>.jpg` – koncept A | před (`main`, `evals/play/p73/sceny/after`) | po
 *    (`evals/play/p75/after`), desktop ve 3. s. Jen k prohlížení, soudce je nevidí.
 * 2. Slepý soudce jako P73D T9 (`p73d-judge.mjs`: stejná otázka, schéma, losování stran a `ask()`),
 *    jen s `main` místo P73D „před“ a s větví P75 místo „po“. Listy a klíč do `evals/play/p75/vs-main/`,
 *    tabulka do `evals/play/p75/vs-main.md`. Hotová odpověď se při dalším běhu nepřeptává.
 *
 *   node --experimental-strip-types --no-warnings scripts/play/p75-vs-main.mjs [--seed 7309] [--only s1,s4] [--sheets-only]
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
const OUT = join(ROOT, 'evals', 'play', 'p75');
const MAIN = join(ROOT, 'evals', 'play', 'p73', 'sceny', 'after');
const AFTER = join(OUT, 'after');
const TARGET = join(OUT, 'target');
const require = createRequire(import.meta.url);

const isVerdict = (value) => (value?.winner === 'left' || value?.winner === 'right') && typeof value.reason === 'string';
const dataUrl = (file) => `data:image/${file.endsWith('.png') ? 'png' : 'jpeg'};base64,${readFileSync(file).toString('base64')}`;

/** Strana listu soudce jako v P73D T9: desktop start + 3. s nahoře, telefon start + 3. s dole, bez jmen souborů. */
function panel(label, dir, id) {
  const shot = (vp, moment) => dataUrl(join(dir, `${id}-${vp}-${moment}.jpg`));
  const cell = (src, caption, cls) => `<figure class="${cls}"><img src="${src}"><figcaption>${caption}</figcaption></figure>`;
  return `<section><h1>${label}</h1>`
    + `<div class="row">${cell(shot('desktop', '0start'), 'desktop · start', 'wide')}${cell(shot('desktop', '1play'), 'desktop · 3 s', 'wide')}</div>`
    + `<div class="row">${cell(shot('phone', '0start'), 'phone · start', 'tall')}${cell(shot('phone', '1play'), 'phone · 3 s', 'tall')}</div></section>`;
}

const JUDGE_CSS = 'body{margin:0;background:#1d2126;font:600 18px Arial,sans-serif;color:#e8ecef;display:flex;gap:40px;padding:20px;width:max-content}'
  + 'section{width:960px}h1{margin:0 0 10px;font-size:34px;text-align:center}.row{display:flex;justify-content:center;gap:16px;margin-bottom:12px}'
  + 'figure{margin:0;text-align:center}figcaption{margin-top:4px;font-size:16px;color:#b4bcc4}.wide img{width:472px;height:295px}.tall img{height:560px;width:259px}';

const OWNER_CSS = 'body{margin:0;background:#1d2126;font:600 18px Arial,sans-serif;color:#e8ecef;padding:20px;width:max-content}'
  + 'p{margin:0 0 12px;font-size:20px}.row{display:flex;gap:16px}figure{margin:0;text-align:center}img{width:640px;height:360px;object-fit:cover}'
  + 'figcaption{margin-top:6px;font-size:18px;color:#b4bcc4}';

async function drawSheets(ids, key) {
  const { chromium } = require('@playwright/test');
  const browser = await chromium.launch();
  const owner = join(OUT, 'sheets');
  const judged = join(OUT, 'vs-main');
  mkdirSync(owner, { recursive: true });
  mkdirSync(judged, { recursive: true });
  const temp = mkdtempSync(join(os.tmpdir(), 'p75v-'));
  const sheets = {};
  try {
    const page = await browser.newPage({ viewport: { width: 2100, height: 1000 } });
    for (const id of ids) {
      const text = SENTENCES.find((item) => item.id === id).text;
      const cell = (file, caption) => `<figure><img src="${dataUrl(file)}"><figcaption>${caption}</figcaption></figure>`;
      await page.setContent(
        `<!doctype html><style>${OWNER_CSS}</style><body><p>${id} · ${text}</p><div class="row">`
          + `${cell(join(TARGET, `${id}.png`), 'koncept A')}${cell(join(MAIN, `${id}-desktop-1play.jpg`), 'před (main)')}${cell(join(AFTER, `${id}-desktop-1play.jpg`), 'po (P75)')}</div></body>`,
      );
      await (await page.$('body')).screenshot({ path: join(owner, `${id}.jpg`), type: 'jpeg', quality: 82 });
      const dirs = key[id] === 'left' ? [AFTER, MAIN] : [MAIN, AFTER];
      await page.setContent(`<!doctype html><style>${JUDGE_CSS}</style><body>${panel('LEFT', dirs[0], id)}${panel('RIGHT', dirs[1], id)}</body>`);
      const body = await page.$('body');
      await body.screenshot({ path: join(judged, `${id}.jpg`), type: 'jpeg', quality: 82 });
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
    const won = verdict ? (verdict.winner === after ? '**po**' : 'main') : '–';
    return `| ${id} | ${text} | ${after === 'left' ? 'vlevo' : 'vpravo'} | ${won} | ${verdict ? verdict.reason.replace(/\|/g, '/') : 'bez odpovědi'} | [list](vs-main/${id}.jpg) · [koncept/před/po](sheets/${id}.jpg) |`;
  });
  const judged = result.ids.filter((id) => result.answers[id]);
  const wins = judged.filter((id) => result.answers[id].winner === result.key[id]).length;
  const leftPicks = judged.filter((id) => result.answers[id].winner === 'left').length;
  const lines = [
    '# P75 T8 – slepý soudce P73D: větev proti `main`',
    '',
    `Souzeno ${result.judgedAt.slice(0, 16).replace('T', ' ')} skriptem \`scripts/play/p75-vs-main.mjs\` (semínko ${result.seed}). Main = \`evals/play/p73/sceny/after\`, po = \`evals/play/p75/after\`. List, otázka a losování stran jako P73D T9 (\`p73d-judge.mjs\`):`,
    '',
    `> ${question('<věta>')}`,
    '',
    `**Výsledek: „po“ vyhrálo ${wins}/${judged.length}** (brána ≥ 10/12). Soudce zvolil levou stranu ${leftPicks}×, pravou ${judged.length - leftPicks}× (strana „po“ vlevo ${result.ids.filter((id) => result.key[id] === 'left').length}×).`,
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
  const keyFile = join(OUT, 'vs-main', 'judge.json');
  const previous = existsSync(keyFile) ? JSON.parse(readFileSync(keyFile, 'utf8')) : null;
  const key = sides(seed, allIds);
  const answers = previous?.seed === seed ? previous.answers : {};
  const sheets = await drawSheets(ids, key);
  const result = { seed, judgedAt: new Date().toISOString(), ids: allIds, key, answers };
  if (options['sheets-only'] !== true) {
    const { ask } = await import('../p37d/judge-sheet.mjs');
    const work = mkdtempSync(join(os.tmpdir(), 'p75v-'));
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
  }
  writeFileSync(keyFile, `${JSON.stringify(result, null, 1)}\n`);
  const { wins, judged } = writeReport(result);
  console.log(`po vyhrálo ${wins}/${judged}`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
