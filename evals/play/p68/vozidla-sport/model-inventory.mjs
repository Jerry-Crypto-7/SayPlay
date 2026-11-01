#!/usr/bin/env node
/**
 * P68V T1: inventura modelů pro věci z dev vět. Pro každé slovo `modelOf` (tag katalogu) a `sceneModelOf`
 * (tag nebo nejbližší model z `nearest.json`) z `src/play/arcade/models.ts`. Vypíše tabulku v Markdownu pro README.
 *
 *   node evals/play/p68/vozidla-sport/model-inventory.mjs
 */

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

if (!process.features.typescript) {
  const run = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', fileURLToPath(import.meta.url), ...process.argv.slice(2)], { stdio: 'inherit' });
  process.exit(run.status ?? 1);
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
await import('../../../../scripts/ts-paths.mjs');
const { modelOf, sceneModelOf } = await import(pathToFileURL(path.join(HERE, '../../../../src/play/arcade/models.ts')).href);

/** Věci z dev vět: vozidla, rekvizity tratě, věci v hromadách, minigolf. */
export const ITEMS = [
  'car', 'sports car', 'police car', 'monster truck', 'truck', 'bus', 'motorbike', 'motorcycle', 'scooter', 'tractor', 'buggy',
  'ramp', 'crate', 'box', 'barrel', 'tire', 'cone', 'fence', 'hay bale', 'trash can', 'watermelon', 'bridge',
  'golf ball', 'ball', 'hole', 'flag', 'windmill', 'golf club', 'bumper', 'log', 'pumpkin', 'coffin', 'rocket', 'castle', 'penguin',
];

console.log('| věc | `modelOf` | `sceneModelOf` | stav |');
console.log('|---|---|---|---|');
for (const item of ITEMS) {
  const tag = modelOf(item, false);
  const scene = sceneModelOf(item, false);
  const state = tag !== undefined ? 'nalezeno' : scene !== undefined ? 'nearest' : 'chybí';
  console.log(`| ${item} | ${tag ?? '–'} | ${scene ?? '–'} | ${state} |`);
}
