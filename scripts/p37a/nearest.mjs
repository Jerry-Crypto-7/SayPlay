#!/usr/bin/env node
/**
 * Nejbližší model katalogu pro slovo, které katalog nemá (P37A T6).
 *
 *   node scripts/p37a/nearest.mjs      zapíše src/play/arcade/nearest.json
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
const assets = index.assets.map((asset) => ({ id: asset.assetId, text: labels.get(asset.assetId) ?? asset.tags.join(' ') }));

const run = spawnSync(PYTHON, [here('./embed.py')], {
  input: JSON.stringify({ words, assets }),
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
  env: { ...process.env, HF_HOME: process.env.HF_HOME ?? 'D:/caches/huggingface', HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1' },
});
if (run.status !== 0) {
  console.error(run.stderr);
  process.exit(1);
}
const result = JSON.parse(run.stdout);

const table = Object.fromEntries(words.map((word) => [word, result.words[word][0]]));
const ceiling = Math.max(...[...abstract].map((word) => table[word][1]));
writeFileSync(
  here('../../src/play/arcade/nearest.json'),
  `${JSON.stringify(
    {
      about: 'P37A T6: nearest catalog model for a noun the catalog lacks, [assetId, cosine] from all-MiniLM-L6-v2 text embeddings. Written by scripts/p37a/nearest.mjs; models.ts applies its own threshold.',
      model: result.model,
      catalog: assets.length,
      abstractCeiling: ceiling,
      words: table,
    },
    null,
    1,
  )}\n`,
);
const sorted = Object.entries(table).sort((a, b) => b[1][1] - a[1][1]);
console.log(`wrote ${words.length} words over ${assets.length} models; abstract ceiling ${ceiling}`);
for (const [word, [id, score]] of sorted) console.log(`${abstract.has(word) ? 'A' : ' '} ${score.toFixed(3)} ${word} -> ${id} | ${result.words[word].slice(1).map(([other, value]) => `${other} ${value}`).join(', ')}`);
