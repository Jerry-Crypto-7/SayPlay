#!/usr/bin/env node
/**
 * Seznam jmen pro `ops/gen3d/batch.py` s třídou těla (P45E): JSON ve tvaru
 * `evals/play/p45d/gen-nouns.json`, takže dávka vybere šablonu zadání podle třídy.
 *
 *   node scripts/p37d/gen-list.mjs --nouns "hippo,wolf,orca" --out <seznam.json>
 *   node scripts/p37d/gen-list.mjs --rest --out <seznam.json>
 *
 * `--rest` = chybějící jména z `evals/play/p45d/missing.json`, která nejsou v `gen-nouns.json`
 * ani mezi tagy katalogu, bez jevů a šumu z `scripts/p45d/not-models.txt`, podle počtu vět.
 * Třídu dá `bodyOfNoun` (`prop`, když ji slova neznají), plochost seznam `FLAT` z P45D.
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
const { bodyOfNoun } = await import('../p45d/motion-class.mjs');
const { FLAT, parseList } = await import('../p45d/pick-nouns.mjs');

const readJson = (file) => JSON.parse(readFileSync(path.join(ROOT, file), 'utf8'));

export const entryOf = (noun, extra = {}) => ({ noun, class: bodyOfNoun(noun) ?? 'prop', flat: FLAT.has(noun), ...extra });

/** Zbytek chybějících jmen po kole `gen-nouns.json`, od nejčastějšího. */
export function restOf({ missing, picked, tags, notModels }) {
  const skip = new Set([...picked, ...tags, ...notModels]);
  return missing
    .filter((entry) => !skip.has(entry.noun))
    .sort((a, b) => b.sentences - a.sentences || a.noun.localeCompare(b.noun))
    .map((entry) => entryOf(entry.noun, { sentences: entry.sentences }));
}

if (isMain) {
  const args = process.argv.slice(2);
  const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
  const nouns = args.includes('--rest')
    ? restOf({
        missing: readJson('evals/play/p45d/missing.json').missing,
        picked: readJson('evals/play/p45d/gen-nouns.json').nouns.map((entry) => entry.noun),
        tags: readJson('src/assets/catalog.json').assets.flatMap((asset) => asset.tags.map((tag) => tag.toLowerCase())),
        notModels: parseList(readFileSync(path.join(ROOT, 'scripts/p45d/not-models.txt'), 'utf8')),
      })
    : flag('--nouns').split(',').map((noun) => entryOf(noun.trim().toLowerCase()));
  writeFileSync(path.resolve(flag('--out')), `${JSON.stringify({ about: 'P45E noun list for ops/gen3d/batch.py, written by scripts/p37d/gen-list.mjs', nouns }, null, 1)}\n`);
  console.log(nouns.map((entry) => `${entry.noun}:${entry.flat ? 'flat' : entry.class}`).join(', '));
}
