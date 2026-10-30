#!/usr/bin/env node
/**
 * P66 T1: kam padne věta dnes a jak často do špatného žánru. Pro každou větu `genre-labels.json` (sada 200 a otevřené
 * sady) pustí bez modelu `classifyGenre(věta, null)` – první režim pořadí je žánr rychlé hry – a pro srovnání i celý
 * návrh `draftGameSpecWithMeta(věta, 1)` (skladatel může první volbu přeskočit, když se nepřeloží nebo robot neprojde).
 *
 *   node evals/play/p66/genre-route.mjs [--labels evals/play/p66/genre-labels.json] [--out evals/play/p66/route-main.json]
 *     [--commit <sha>] [--no-draft]
 *
 * `wrong` = věta s `best ≠ none`, jejíž žánr rychlé hry není v `acceptable` (ne `best`: přijatelný žánr není chyba).
 * Věta `none` se nepočítá ani do čitatele, ani do jmenovatele. `wrongRate` zvlášť na sadě 200 a na otevřených sadách.
 * Dosah nových žánrů: kolik vět má nový žánr jako `best` nebo v `acceptable` a z kterých dnešních žánrů by k němu šly.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { NEW_GENRES, TEST_SET } from './genre-labels.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

// Aplikace je TypeScript; holý `node` ji načte až s odstraňováním typů.
if (isMain && !process.features.typescript) {
  const run = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', fileURLToPath(import.meta.url), ...process.argv.slice(2)], { stdio: 'inherit' });
  process.exit(run.status ?? 1);
}

/** Věta je špatně, když má hru (`best ≠ none`) a žánr rychlé hry není mezi přijatelnými. */
export const isWrong = (row) => row.best !== 'none' && !row.acceptable.includes(row.genre);

/** `rows` = `{ best, acceptable, genre }`; věty bez štítku (`best === null`) a `none` se nepočítají. */
export function routeStats(rows) {
  const labelled = rows.filter((row) => row.best !== null && row.best !== undefined);
  const counted = labelled.filter((row) => row.best !== 'none');
  const wrong = counted.filter(isWrong).length;
  return { sentences: labelled.length, none: labelled.length - counted.length, counted: counted.length, wrong, wrongRate: counted.length === 0 ? null : Math.round((wrong / counted.length) * 1000) / 1000 };
}

/** Dosah nového žánru: `best`, `acceptable` a dnešní žánry (podle `genre`), ze kterých by věty s ním v `acceptable` šly. */
export function reachOf(rows, genre) {
  const labelled = rows.filter((row) => row.best !== null && row.best !== undefined);
  const accepting = labelled.filter((row) => row.acceptable.includes(genre));
  const from = {};
  for (const row of accepting) from[row.genre] = (from[row.genre] ?? 0) + 1;
  return {
    best: labelled.filter((row) => row.best === genre).length,
    acceptable: accepting.length,
    share: labelled.length === 0 ? null : Math.round((accepting.length / labelled.length) * 1000) / 1000,
    from: Object.fromEntries(Object.entries(from).sort((a, b) => b[1] - a[1])),
  };
}

const flag = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : process.argv[i + 1];
};

async function main() {
  await import('../../../scripts/ts-paths.mjs');
  const { classifyGenre } = await import('../../../src/play/genre/classify.ts');
  const { draftGameSpecWithMeta } = await import('../../../src/play/draft/index.ts');
  const { loadRapier } = await import('../../../src/play/arcade/physics/world.ts');
  await loadRapier();

  const labelsFile = path.resolve(flag('--labels', path.join(HERE, 'genre-labels.json')));
  const out = path.resolve(flag('--out', path.join(HERE, 'route-main.json')));
  const withDraft = !process.argv.includes('--no-draft');
  const commit = flag('--commit', execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim());
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
    schema: 'p66-genre-route.v1',
    commit,
    measuredAt: new Date().toISOString(),
    labels: path.relative(ROOT, labelsFile).replace(/\\/g, '/'),
    about: 'genre = classifyGenre(sentence, null).ranked[0] (quick game, no model); draft = draftGameSpecWithMeta(sentence, 1).genre (composer, may skip a choice that does not compile or verify; grid = archetype fallback). wrong = best != none and genre not in acceptable; none is not counted.',
    seconds: Math.round((Date.now() - started) / 1000),
    wrongRate: { test200: routeStats(groups.test200), open: routeStats(groups.open) },
    wrongRateDraft: withDraft ? { test200: routeStats(viaDraft(groups.test200)), open: routeStats(viaDraft(groups.open)) } : null,
    reach: Object.fromEntries(NEW_GENRES.map((genre) => [genre, { test200: reachOf(groups.test200, genre), open: reachOf(groups.open, genre) }])),
    rows,
  }, null, 1)}\n`);
  console.log(`DONE ${rows.length} sentences in ${Math.round((Date.now() - started) / 1000)} s -> ${out}`);
}

if (isMain) await main();
