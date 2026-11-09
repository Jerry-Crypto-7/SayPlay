#!/usr/bin/env node
/**
 * P77 listy pro oko: pro každou větu sloupce vedle sebe – volitelně koncept A (`evals/play/p75/target/<věta>.png`)
 * a pak snímky ze složek `--dirs` (desktop 3. s nahoře, telefon 3. s dole). Jen k prohlížení, soudce je nevidí.
 *
 *   node scripts/play/p77-sheets.mjs --dirs evals/play/p77/base,evals/play/p77/t2 --labels před,po --out evals/play/p77/t2/sheets [--concept] [--only s1,s9]
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { args } from '../play-look-shots.mjs';
import { SENTENCES } from './p73d-shots.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(import.meta.url);

const dataUrl = (file) => `data:image/${file.endsWith('.png') ? 'png' : 'jpeg'};base64,${readFileSync(file).toString('base64')}`;
const CSS = 'body{margin:0;background:#1d2126;font:600 18px Arial,sans-serif;color:#e8ecef;padding:16px;width:max-content}p{margin:0 0 8px;font-size:22px}'
  + '.cols{display:flex;gap:24px}section{display:flex;flex-direction:column;align-items:center;gap:8px}h1{margin:0;font-size:26px}'
  + '.wide{width:640px;height:400px;object-fit:cover}.concept{width:640px;height:356px;object-fit:cover}.tall{height:560px;width:259px;object-fit:cover}';

async function main() {
  const options = args();
  const dirs = String(options.dirs ?? '').split(',').filter(Boolean).map((dir) => resolve(ROOT, dir));
  const labels = typeof options.labels === 'string' ? options.labels.split(',') : dirs.map((dir) => dir.split(/[\\/]/).at(-1));
  const out = resolve(ROOT, String(options.out));
  const only = typeof options.only === 'string' ? new Set(options.only.split(',')) : null;
  mkdirSync(out, { recursive: true });
  const { chromium } = require('@playwright/test');
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 2800, height: 1100 } });
    for (const sentence of SENTENCES.filter((item) => only === null || only.has(item.id))) {
      const columns = [];
      if (options.concept === true) columns.push(`<section><h1>koncept</h1><img class="concept" src="${dataUrl(join(ROOT, 'evals', 'play', 'p75', 'target', `${sentence.id}.png`))}"></section>`);
      dirs.forEach((dir, index) => {
        const desktop = join(dir, `${sentence.id}-desktop-1play.jpg`);
        const phone = join(dir, `${sentence.id}-phone-1play.jpg`);
        columns.push(`<section><h1>${labels[index]}</h1>${existsSync(desktop) ? `<img class="wide" src="${dataUrl(desktop)}">` : ''}${existsSync(phone) ? `<img class="tall" src="${dataUrl(phone)}">` : ''}</section>`);
      });
      await page.setContent(`<!doctype html><style>${CSS}</style><body><p>${sentence.id} · ${sentence.text}</p><div class="cols">${columns.join('')}</div></body>`);
      await (await page.$('body')).screenshot({ path: join(out, `${sentence.id}.jpg`), type: 'jpeg', quality: 80 });
    }
  } finally {
    await browser.close();
  }
  console.log(`listy → ${options.out}`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
