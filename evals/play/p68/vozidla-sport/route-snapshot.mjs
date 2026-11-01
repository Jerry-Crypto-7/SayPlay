#!/usr/bin/env node
/**
 * P68V T1: snímek směrování. Pro každou větu zapečetěné sady P30 (`evals/play/p30/test-200.json`) žánr a režim
 * rychlé hry bez modelu – `classifyGenre(věta, null).ranked[0]`. Test `routing-guard.test.ts` počítá totéž na
 * aktuální větvi a selže při jakékoli změně: pruh nesmí krást věty, dokud ho P68-I nezapojí.
 *
 *   node evals/play/p68/vozidla-sport/route-snapshot.mjs [--root <checkout>] [--out <soubor>]
 *
 * `--root` = checkout, jehož klasifikátor se měří (výchozí tento). Když `origin/main` směrování legitimně změní
 * (P68-I zapojí hru), snímek se přepočítá z čistého checkoutu `origin/main` přes `--root` (README → „Směrování“).
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../../../..');
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

// Aplikace je TypeScript; holý `node` ji načte až s odstraňováním typů.
if (isMain && !process.features.typescript) {
  const run = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', fileURLToPath(import.meta.url), ...process.argv.slice(2)], { stdio: 'inherit' });
  process.exit(run.status ?? 1);
}

/** Řádky snímku v pořadí sady: `{ id, text, genre, mode }` z prvního režimu pořadí. */
export function routeRows(classifyGenre, sentences) {
  return sentences.map((s) => {
    const top = classifyGenre(s.text, null).ranked[0];
    return { id: s.id, text: s.text, genre: top.genre, mode: top.mode };
  });
}

/** Věty, jejichž žánr nebo režim se liší (nebo chybí) proti snímku; `after: null` = věta zmizela. */
export function routeChanges(before, after) {
  const now = new Map(after.map((row) => [row.id, row]));
  const changes = [];
  for (const row of before) {
    const next = now.get(row.id);
    const was = `${row.genre}/${row.mode}`;
    const is = next === undefined ? null : `${next.genre}/${next.mode}`;
    if (is !== was) changes.push({ id: row.id, text: row.text, before: was, after: is });
  }
  return changes;
}

const flag = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : process.argv[i + 1];
};

async function main() {
  const root = path.resolve(flag('--root', REPO));
  const out = path.resolve(flag('--out', path.join(HERE, 'route-before.json')));
  // Zavaděč toho checkoutu: `@/` míří do jeho `src/`.
  await import(pathToFileURL(path.join(root, 'scripts/ts-paths.mjs')).href);
  const { classifyGenre } = await import(pathToFileURL(path.join(root, 'src/play/genre/classify.ts')).href);
  const set = JSON.parse(readFileSync(path.join(root, 'evals/play/p30/test-200.json'), 'utf8'));
  const commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const rows = routeRows(classifyGenre, set.sentences);
  const genres = {};
  for (const row of rows) genres[row.genre] = (genres[row.genre] ?? 0) + 1;
  writeFileSync(out, `${JSON.stringify({
    schema: 'p68v-route.v1',
    commit,
    set: 'evals/play/p30/test-200.json',
    about: 'genre/mode = classifyGenre(sentence, null).ranked[0] (quick game, no model) on every sentence of the sealed P30 set. routing-guard.test.ts recomputes it on the branch and fails on any change.',
    count: rows.length,
    genres: Object.fromEntries(Object.entries(genres).sort((a, b) => b[1] - a[1])),
    rows,
  }, null, 1)}\n`);
  console.log(`DONE ${rows.length} sentences at ${commit} -> ${path.relative(REPO, out)}`);
}

if (isMain) await main();
