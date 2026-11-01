#!/usr/bin/env node
/**
 * P68 T2: stráž žánru nad štítky P68 (29 typů). Obal nad `../p66/genre-route.mjs`: stejná definice `wrong` (věta
 * s `best ≠ none`, jejíž žánr rychlé hry není v `acceptable`; `none` se nepočítá), stejný podíl a dosah – jen štítky
 * P68, dosah pěti nových her a kód, nad kterým se měří, z libovolného checkoutu (`--root`).
 *
 *   node evals/play/p68/genre-route.mjs [--root D:/caches/p68i/main] [--labels evals/play/p68/genre-labels.json]
 *     [--out evals/play/p68/route-main.json] [--commit <sha>] [--no-draft]
 *
 * `--root` (výchozí tento checkout) = kořen repa, jehož `classifyGenre` a `draftGameSpecWithMeta` se pustí; srovnávací
 * `main` je `D:/caches/p68i/main` (`688d989d`), větev se měří bez `--root` (`route-<id>.json` v T8–T12).
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { isWrong, reachOf, routeStats } from '../p66/genre-route.mjs';
import { NEW_GENRES, TEST_SET } from './genre-labels.mjs';

export { NEW_GENRES, isWrong, reachOf, routeStats };

const HERE = path.dirname(fileURLToPath(import.meta.url));
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

// Aplikace je TypeScript; holý `node` ji načte až s odstraňováním typů.
if (isMain && !process.features.typescript) {
  const run = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', fileURLToPath(import.meta.url), ...process.argv.slice(2)], { stdio: 'inherit' });
  process.exit(run.status ?? 1);
}

const flag = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : process.argv[i + 1];
};

async function main() {
  const root = path.resolve(flag('--root', path.resolve(HERE, '../../..')));
  const load = (rel) => import(pathToFileURL(path.join(root, rel)).href);
  await load('scripts/ts-paths.mjs');
  const { classifyGenre } = await load('src/play/genre/classify.ts');
  const { draftGameSpecWithMeta } = await load('src/play/draft/index.ts');
  const { loadRapier } = await load('src/play/arcade/physics/world.ts');
  await loadRapier();
  const labelsFile = path.resolve(flag('--labels', path.join(HERE, 'genre-labels.json')));
  const out = path.resolve(flag('--out', path.join(HERE, 'route-main.json')));
  const withDraft = !process.argv.includes('--no-draft');
  const commit = flag('--commit', execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim());
  const labels = JSON.parse(readFileSync(labelsFile, 'utf8'));
  const started = Date.now();
  const rows = labels.sentences.map((sentence) => {
    const top = classifyGenre(sentence.text, null).ranked[0];
    let draft = null;
    if (withDraft) {
      try {
        const meta = draftGameSpecWithMeta(sentence.text, 1);
        draft = meta.genre === null ? 'grid' : meta.genre.genre;
      } catch (error) {
        draft = `error: ${error.message.slice(0, 80)}`;
      }
    }
    return { text: sentence.text, sets: sentence.sets.map((s) => `${s.set}#${s.id}`), best: sentence.best, acceptable: sentence.acceptable, genre: top.genre, mode: top.mode, draft };
  });
  const inTest = (row) => row.sets.some((s) => s.startsWith(`${TEST_SET}#`));
  const inOpen = (row) => row.sets.some((s) => !s.startsWith(`${TEST_SET}#`));
  const groups = { test200: rows.filter(inTest), open: rows.filter(inOpen) };
  const viaDraft = (list) => list.map((row) => ({ ...row, genre: row.draft }));
  writeFileSync(out, `${JSON.stringify({
    schema: 'p68-genre-route.v1',
    commit,
    root: root.replace(/\\/g, '/'),
    measuredAt: new Date().toISOString(),
    labels: path.relative(path.resolve(HERE, '../../..'), labelsFile).replace(/\\/g, '/'),
    about: 'genre = classifyGenre(sentence, null).ranked[0] (quick game, no model); draft = draftGameSpecWithMeta(sentence, 1).genre (composer; grid = archetype fallback). wrong = best != none and genre not in acceptable; none is not counted. Labels: 29 types (P68).',
    seconds: Math.round((Date.now() - started) / 1000),
    wrongRate: { test200: routeStats(groups.test200), open: routeStats(groups.open) },
    wrongRateDraft: withDraft ? { test200: routeStats(viaDraft(groups.test200)), open: routeStats(viaDraft(groups.open)) } : null,
    reach: Object.fromEntries(NEW_GENRES.map((genre) => [genre, { test200: reachOf(groups.test200, genre), open: reachOf(groups.open, genre) }])),
    rows,
  }, null, 1)}\n`);
  console.log(`DONE ${rows.length} sentences in ${Math.round((Date.now() - started) / 1000)} s -> ${out}`);
}

if (isMain) await main();
