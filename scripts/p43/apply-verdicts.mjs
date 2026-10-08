#!/usr/bin/env node
/**
 * Verdikty slepého soudu knihovny (P43 T11) do katalogu (P43 T13).
 *
 *   node scripts/p43/apply-verdicts.mjs [--verdicts evals/assets/p43-qa/verdicts.json]
 *
 * Model, který soudce poznal jako něco jiného, dostane jména soudce jako tagy `seen:<jméno>`;
 * `models.ts` je použije jen pro slovo, které žádný jiný model nenese. Starý popisek a tagy
 * zůstávají: soudce často řekne nadřazené slovo (corgi → „dog“, zlatá rybka → „fish“) a
 * přepsání by větě s „corgi“ vzalo jediný model. Nepoznatelný model dostane
 * `qa:unrecognisable` a `models.ts` ho pro jméno nevybere. Shodu počítá znovu a shovívavěji
 * než soudce: jeho `nameFits` srovnává i přívlastek „(CC0, Quaternius)“ a celé dvojslovo tagu.
 * Měřítko se nepřepisuje – arkáda model vepisuje do těla (`fitScale`) a `bounds` musí
 * sedět s GLB. Potom přepíše `catalog-index.json`; manifest hrdinů a `nearest.json`
 * přegeneruj `p32-manifest.mjs`, `p37d/missing-nouns.mjs` a `p37a/nearest.mjs`.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain && !process.features.typescript) {
  const run = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', fileURLToPath(import.meta.url), ...process.argv.slice(2)], { stdio: 'inherit' });
  process.exit(run.status ?? 1);
}
if (!process.env.VITEST) await import('../ts-paths.mjs');
const { singular } = await import('../../src/play/draft/lexicon.ts');

export const SEEN = 'seen:';
export const UNRECOGNISABLE = 'qa:unrecognisable';

const wordsOf = (text) => (text.toLowerCase().match(/[a-z]+/g) ?? []).map((word) => singular(word));

/** Slova katalogu: popisek bez přívlastku balíčku, tagy a id bez předpony zdroje. */
function catalogWords(asset) {
  const label = asset.label.replace(/\(.*?\)/g, ' ');
  const id = asset.assetId.replace(/^(cc0|gen3d)-/, '');
  return new Set([label, id, ...asset.tags.filter((tag) => !tag.startsWith('qa:') && !tag.startsWith(SEEN))].flatMap(wordsOf));
}

/** Nese aspoň jedno jméno soudce slovo katalogu? „Perfume bottle“ je parfém, „office desk“ kancelář. */
export function fitsCatalog(asset, verdict) {
  const words = catalogWords(asset);
  return [verdict.name, ...verdict.alternatives].some((guess) => wordsOf(guess).some((word) => words.has(word)));
}

const seenTag = (name) => `${SEEN}${name.trim().toLowerCase()}`;

export function applyVerdicts(catalog, verdicts) {
  const seen = [];
  const unrecognisable = [];
  const assets = catalog.assets.map((asset) => {
    const verdict = verdicts[asset.assetId];
    if (verdict === undefined || asset.tags.includes(UNRECOGNISABLE) || asset.tags.some((tag) => tag.startsWith(SEEN))) return asset;
    if (!verdict.recognizable) {
      unrecognisable.push(asset.assetId);
      return { ...asset, tags: [...asset.tags, UNRECOGNISABLE] };
    }
    if (fitsCatalog(asset, verdict)) return asset;
    seen.push({ assetId: asset.assetId, label: asset.label, seen: verdict.name });
    return { ...asset, tags: [...asset.tags, ...new Set([verdict.name, ...verdict.alternatives].map(seenTag))] };
  });
  return { catalog: { ...catalog, assets }, seen, unrecognisable };
}

async function main() {
  const at = process.argv.indexOf('--verdicts');
  const verdictsPath = path.resolve(ROOT, at > 0 ? process.argv[at + 1] : 'evals/assets/p43-qa/verdicts.json');
  const catalogPath = path.join(ROOT, 'src/assets/catalog.json');
  const { verdicts } = JSON.parse(readFileSync(verdictsPath, 'utf8'));
  const { catalog, seen, unrecognisable } = applyVerdicts(JSON.parse(readFileSync(catalogPath, 'utf8')), verdicts);
  const { catalogIndex } = await import('../assets/cc0/promote.mjs');
  writeFileSync(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`);
  writeFileSync(path.join(ROOT, 'src/assets/catalog-index.json'), `${JSON.stringify(catalogIndex(catalog), null, 2)}\n`);
  for (const row of seen) console.log(`seen ${row.assetId}: ${row.label} -> ${row.seen}`);
  console.log(`verdicts ${Object.keys(verdicts).length}; seen as something else ${seen.length}; unrecognisable ${unrecognisable.length}${unrecognisable.length > 0 ? ` (${unrecognisable.join(', ')})` : ''}`);
}

if (isMain) await main();
