#!/usr/bin/env node
/**
 * Nejbližší model katalogu pro slovo, které katalog nemá (P37A T6).
 *
 *   node scripts/p37a/nearest.mjs             zapíše src/play/arcade/nearest.json, zapsaná slova P37A nechá
 *   node scripts/p37a/nearest.mjs --refresh   přepočítá i je proti dnešnímu katalogu
 *
 * Slova: podstatná jména, která porotci píšou a knihovna nemá (`missing`), seznam častých jmen (`common-nouns.json`)
 * a abstraktní slova bez modelu (`undrawable`) z `evals/play/p37d/missing.json`
 * – ta drží práh: jejich nejlepší skóre ukazuje, kolik dá shoda bez smyslu.
 * Modely: katalog, který hra kreslí (`src/assets/catalog-index.json`), popisek
 * z `src/assets/catalog.json`. Vektory počítá all-MiniLM-L6-v2 (Apache-2.0) v Pythonu
 * (`embed.py`, model z mezipaměti Hugging Face, offline); hra za běhu čte jen
 * zapsaný JSON. **Po každé dávce P37D** pusť nejdřív `missing-nouns.mjs`, pak tenhle skript.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const here = (relative) => fileURLToPath(new URL(relative, import.meta.url));
const readJson = (relative) => JSON.parse(readFileSync(here(relative), 'utf8'));

const PYTHON = process.env.P37A_PYTHON ?? 'python';

const missing = readJson('../../evals/play/p37d/missing.json');
const index = readJson('../../src/assets/catalog-index.json');
const labels = new Map(readJson('../../src/assets/catalog.json').assets.map((asset) => [asset.assetId, asset.label]));

// Seznam častých herních jmen P37D (`acorn`, `receipt`), ať tabulka nekryje jen to, co už někdo napsal.
const common = Object.values(readJson('../../evals/play/p37d/common-nouns.json').tiers).flat();
const nounOf = (entry) => (typeof entry === 'string' ? entry : entry.noun).toLowerCase();
const words = [...new Set([...missing.missing, ...missing.undrawable, ...common].map(nounOf))].sort();
const abstract = new Set(missing.undrawable.map((entry) => entry.noun.toLowerCase()));
// P43 T13: nepoznatelný model nebude nejbližším ničeho.
const assets = index.assets.filter((asset) => !asset.tags.includes('qa:unrecognisable')).map((asset) => ({ id: asset.assetId, text: labels.get(asset.assetId) ?? asset.tags.join(' ') }));

function embed(list) {
  const run = spawnSync(PYTHON, [here('./embed.py')], {
    input: JSON.stringify({ words: list, assets }),
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, CUDA_VISIBLE_DEVICES: '', HF_HOME: process.env.HF_HOME ?? 'D:/caches/huggingface', HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1' },
  });
  if (run.status !== 0) {
    console.error(run.stderr);
    process.exit(1);
  }
  return JSON.parse(run.stdout);
}

const result = embed(words);
// Zapsaný záznam slova vyhrává, ať nový běh tiše nepřepíše, co hra dnes kreslí (P44C T10: katalog narostl 794 → 912
// a 145 ze 667 slov by dostalo jiný model). `--refresh` je přepočítá proti dnešnímu katalogu – vědomě, s novým měřením.
const previous = process.argv.includes('--refresh') ? {} : readJson('../../src/play/arcade/nearest.json').words;
const table = Object.fromEntries(words.map((word) => [word, previous[word] ?? result.words[word][0]]));
const ceiling = Math.max(...[...abstract].map((word) => table[word][1]));

// P44C T10: konkrétní podstatná jména Open English WordNet 2024 (CC-BY-4.0, `scripts/vocab/build.mjs --nouns`).
// Vlastní dávka, ať se skóre slov výš nepohne; jen nad `LOOSE_MIN` v models.ts – slovo pod ním by zastavilo hledání hlavy fráze.
const LOOSE_MIN = 0.5;
const nounRun = spawnSync(process.execPath, [here('../vocab/build.mjs'), '--nouns'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
if (nounRun.status !== 0) {
  console.error(nounRun.stderr);
  process.exit(1);
}
const extra = JSON.parse(nounRun.stdout).filter((word) => !(word in table));
const extraResult = embed(extra);
const candidates = extra
  .map((word) => [word, extraResult.words[word][0]])
  .filter(([, [, score]]) => score >= LOOSE_MIN)
  .sort((a, b) => b[1][1] - a[1][1] || (a[0] < b[0] ? -1 : 1));

const render = (count) => {
  const merged = Object.fromEntries([...Object.entries(table), ...candidates.slice(0, count)].sort((a, b) => (a[0] < b[0] ? -1 : 1)));
  return `${JSON.stringify(
    {
      about: 'P37A T6: nearest catalog model for a noun the catalog lacks, [assetId, cosine] from all-MiniLM-L6-v2 text embeddings. Written by scripts/p37a/nearest.mjs; models.ts applies its own threshold. P44C T10 adds concrete nouns from Open English WordNet 2024 (CC-BY-4.0) scoring at least 0.5.',
      model: result.model,
      catalog: assets.length,
      abstractCeiling: ceiling,
      words: merged,
    },
    null,
    1,
  )}\n`;
};
// Klientský rozpočet (hlídá src/play/vocab/__tests__/nouns.test.ts): nejlepší skóre první, dokud se vejdou.
// simplified: řez podle skóre, ne podle četnosti slova – seznam četností s povolenou licencí nemáme; až bude, řaď podle něj.
const BUDGET = { raw: 200 * 1024, gzip: 48 * 1024 };
const fits = (count) => {
  const text = render(count);
  return Buffer.byteLength(text) <= BUDGET.raw && gzipSync(text).length <= BUDGET.gzip;
};
let low = 0;
let high = candidates.length;
while (low < high) {
  const middle = Math.ceil((low + high) / 2);
  if (fits(middle)) low = middle;
  else high = middle - 1;
}
writeFileSync(here('../../src/play/arcade/nearest.json'), render(low));
console.log(`OEWN nouns: ${extra.length} new, ${candidates.length} at ≥ ${LOOSE_MIN}, ${low} within the budget`);
const sorted = Object.entries(table).sort((a, b) => b[1][1] - a[1][1]);
console.log(`wrote ${words.length} words over ${assets.length} models; abstract ceiling ${ceiling}`);
for (const [word, [id, score]] of sorted) console.log(`${abstract.has(word) ? 'A' : ' '} ${score.toFixed(3)} ${word} -> ${id} | ${result.words[word].slice(1).map(([other, value]) => `${other} ${value}`).join(', ')}`);
