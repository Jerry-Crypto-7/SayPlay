#!/usr/bin/env node
/**
 * P70B T5: open the sealed P70B set once and measure the quick game of every sentence on two checkouts.
 *
 *   node evals/play/p70b/holdout.measure.mjs open --commit <sha>
 *     Opens the seal (`openSealedOnce`, writes `holdout-opened.json`; a second run refuses), checks the labels'
 *     fingerprint and copies set, labels and the opening record next to this file.
 *   node evals/play/p70b/holdout.measure.mjs route --root <repo> --commit <sha> --out <route.json> [--specs <specs.json>]
 *     Runs `<repo>`'s quick game (`draftGameSpecWithMeta(sentence, 1)`) on the opened labels: game = `genre.genre`
 *     (`grid` when no genre translates), hero = `heroModel(spec)`. `--specs` also writes the spec of every sentence the
 *     quick game routes right (golf → minigolf, otherwise a genre from `acceptable`) as input for
 *     `scripts/measure/gameplay-gate.mjs` (G2), with the sentence id in `sentence`.
 *   node evals/play/p70b/holdout.measure.mjs report
 *     `route-main.json` + `route-branch.json` + `gameplay-holdout.json` → `result.json` (`result.mjs`).
 *
 * Sentences are never printed, only counts.
 */

import { spawnSync } from 'node:child_process';
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../../..');

if (!process.features.typescript) {
  const run = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', fileURLToPath(import.meta.url), ...process.argv.slice(2)], { stdio: 'inherit' });
  process.exit(run.status ?? 1);
}

const [command, ...rest] = process.argv.slice(2);
const arg = (name) => {
  const at = rest.indexOf(`--${name}`);
  return at === -1 ? undefined : rest[at + 1];
};
const need = (name) => arg(name) ?? (() => { throw new Error(`--${name} is required`); })();

const { routedRight, verdictOf } = await import(pathToFileURL(path.join(HERE, 'result.mjs')).href);
const readJson = (file) => JSON.parse(readFileSync(path.join(HERE, file), 'utf8'));

if (command === 'report') {
  const [main, branch, gameplay, opened] = ['route-main.json', 'route-branch.json', 'gameplay-holdout.json', 'holdout-opened.json'].map(readJson);
  writeFileSync(path.join(HERE, 'result.json'), `${JSON.stringify({ schema: 'p70b-result.v1', opened: opened.openedAt, mainCommit: main.commit, branchCommit: branch.commit, ...verdictOf(main, branch, gameplay) }, null, 1)}\n`);
  console.log('result.json written');
} else if (command === 'open') {
  await import(pathToFileURL(path.join(REPO, 'scripts/ts-paths.mjs')).href);
  const { HOLDOUT_PATH, LABELS_PATH, P70B_HOLDOUT_SHA256, P70B_LABELS_SHA256, SEALED_DIR, openSealedOnce, sha256Lf } = await import(pathToFileURL(path.join(HERE, 'seal.ts')).href);
  const labels = readFileSync(LABELS_PATH, 'utf8').replace(/\r\n/g, '\n');
  if (sha256Lf(labels) !== P70B_LABELS_SHA256) throw new Error('holdout-labels.json is not the sealed file');
  openSealedOnce(SEALED_DIR, P70B_HOLDOUT_SHA256, need('commit'), 'P70B T5');
  copyFileSync(HOLDOUT_PATH, path.join(HERE, 'holdout.json'));
  copyFileSync(LABELS_PATH, path.join(HERE, 'holdout-labels.json'));
  copyFileSync(path.join(SEALED_DIR, 'holdout-opened.json'), path.join(HERE, 'holdout-opened.json'));
  console.log('opened', JSON.parse(labels).sentences.length, 'sentences');
} else if (command === 'route') {
  const root = path.resolve(need('root'));
  const load = (rel) => import(pathToFileURL(path.join(root, rel)).href);
  await load('scripts/ts-paths.mjs');
  const { draftGameSpecWithMeta } = await load('src/play/draft/index.ts');
  const { heroModel } = await load('src/play/arcade/models.ts');
  const { loadRapier } = await load('src/play/arcade/physics/world.ts');
  await loadRapier();
  const labels = JSON.parse(readFileSync(path.join(HERE, 'holdout-labels.json'), 'utf8')).sentences;
  const started = Date.now();
  const rows = [];
  const specs = [];
  for (const label of labels) {
    const meta = draftGameSpecWithMeta(label.text, 1);
    const row = { id: label.id, half: label.half, aimed: label.aimed, best: label.best, acceptable: label.acceptable, heroModels: label.heroModels ?? null, game: meta.genre?.genre ?? 'grid', hero: heroModel(meta.spec) };
    rows.push(row);
    if (routedRight(row)) specs.push({ game: row.game, sentence: row.id, spec: meta.spec, seed: 1 });
  }
  writeFileSync(path.resolve(need('out')), `${JSON.stringify({ schema: 'p70b-holdout-route.v1', commit: need('commit'), root, measuredAt: new Date().toISOString(), seconds: Math.round((Date.now() - started) / 1000), about: 'game = draftGameSpecWithMeta(sentence, 1).genre.genre (grid = no genre); hero = heroModel(spec)', rows }, null, 1)}\n`);
  if (arg('specs') !== undefined) writeFileSync(path.resolve(arg('specs')), JSON.stringify({ entries: specs }));
  console.log('routed', rows.length, 'right', specs.length);
} else {
  throw new Error('usage: holdout.measure.mjs open --commit <sha> | route --root <repo> --commit <sha> --out <file> [--specs <file>] | report');
}
