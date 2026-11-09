#!/usr/bin/env node
/**
 * Spočítá knihovnu modelů pro README (P79) a zapíše `evals/play/p79/catalog.json`.
 *
 * README tvrdí, kolik modelů hra má a odkud jsou. Do P79 to číslo stálo jen
 * v README a v popisu; teď ho nese soubor s datem, ze kterého ho
 * `readme-claims.mjs` ověřuje.
 *
 * ```
 * node scripts/readme-catalog-count.mjs
 * ```
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'evals/play/p79/catalog.json');
const read = (path) => JSON.parse(readFileSync(join(ROOT, path), 'utf8'));

/** Odkud model je, podle `provenance` v katalogu. Pořadí rozhoduje: první shoda vyhrává. */
const ORIGINS = [
  ['cc0', (p) => /CC0/i.test(p.license)],
  ['blenderByCode', (p) => String(p.source).startsWith('scripts/assets/blender')],
  ['threeJsByCode', (p) => String(p.source).startsWith('scripts/assets/originals')],
  ['generatedOffline', (p) => /gen3d/i.test(`${p.source} ${p.licenseEvidence ?? ''}`)],
];

const assets = read('src/assets/catalog.json').assets;
const byOrigin = Object.fromEntries([...ORIGINS.map(([name]) => [name, 0]), ['other', 0]]);
const otherSources = new Set();
for (const { provenance } of assets) {
  const origin = ORIGINS.find(([, test]) => test(provenance))?.[0] ?? 'other';
  byOrigin[origin] += 1;
  if (origin === 'other') otherSources.add(String(provenance.source));
}

const riggedFiles = ['src/assets/rigged.json', 'src/assets/rigged-p32.json', 'src/assets/rigged-p54.json'];
const riggedByFile = Object.fromEntries(riggedFiles.map((path) => [path, read(path).characters.length]));

const report = {
  about: 'P79: size and origin of the model library, counted from src/assets/catalog.json and the rigged character lists. Written by scripts/readme-catalog-count.mjs.',
  measuredOn: new Date().toISOString().slice(0, 10),
  catalogueModels: assets.length,
  byOrigin,
  otherSources: [...otherSources].sort(),
  riggedCharacters: Object.values(riggedByFile).reduce((sum, count) => sum + count, 0),
  riggedByFile,
};

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
