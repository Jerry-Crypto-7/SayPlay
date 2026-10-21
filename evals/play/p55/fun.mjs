/**
 * Slepý soud zábavy P55 (T6, T8): pruhové žánry z `origin/main` (strana A, před P55) proti HEAD (strana B, s vrstvou
 * událostí). Věty jsou cíle dev sady P54C pro zvolené žánry, los `pure-rand` po žánrech dokola, dokud není `--pairs`
 * párů. Klipy bez modelu (`draft-only`), soudce P45 (`pairwise`, Codex, prázdný adresář jen se `sheet.png`).
 * Soudce bez odpovědi = zapsané přeskočení, ne remíza.
 *
 *   node evals/play/p55/fun.mjs --base-a http://127.0.0.1:3101 --base-b http://127.0.0.1:3100 \
 *     --genres catch --pairs 3 --target 2 --out fun-catch.json --run p55-t6 [--gpu]
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { genreOfSpec, PAIR_SEED, pairwise, runSentences } from '../../../scripts/play-fidelity.mjs';

const { xoroshiro128plus } = await import('pure-rand/generator/xoroshiro128plus');
const { uniformInt } = await import('pure-rand/distribution/uniformInt');

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..', '..');
const RUNS = join(ROOT, 'evals', 'play', 'fidelity', 'runs');

/** Strana A: `origin/main` (#42, P54C), ze kterého P55 vychází. */
export const BASE_COMMIT = 'ada7dd8b';
export const PICK_SEED = 55006;

/** `pairs` vět: po žánrech v pořadí `genres` dokola, z každého bez opakování los z jednoho streamu. */
export function pickSentences(sentences, genres, pairs, seed = PICK_SEED) {
  const rng = xoroshiro128plus(seed);
  const pools = new Map(genres.map((genre) => [genre, sentences.filter((sentence) => sentence.family === 'target' && sentence.expect === `${genre}.default`)]));
  const picked = [];
  for (let index = 0; picked.length < pairs; index += 1) {
    const pool = pools.get(genres[index % genres.length]);
    if (pool.length === 0) throw new Error(`no dev targets left for ${genres[index % genres.length]}`);
    picked.push(pool.splice(uniformInt(rng, 0, pool.length - 1), 1)[0]);
  }
  return picked.sort((a, b) => a.id.localeCompare(b.id));
}

function args() {
  const out = {};
  const list = process.argv.slice(2);
  for (let i = 0; i < list.length; i += 1) if (list[i].startsWith('--')) out[list[i].slice(2)] = list[i + 1]?.startsWith('--') === false ? list[++i] : true;
  return out;
}

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const played = (run, id) => {
  const spec = readJson(join(RUNS, run, `${id}.json`)).draft.spec;
  return { genre: genreOfSpec(spec), generator: spec.controlParams?.generator ?? null, title: spec.title ?? null };
};

async function main() {
  const options = args();
  const genres = String(options.genres ?? 'catch').split(',');
  const pairs = Number(options.pairs ?? 3);
  const target = Number(options.target ?? 2);
  const run = typeof options.run === 'string' ? options.run : 'p55-fun';
  const out = join(HERE, typeof options.out === 'string' ? options.out : 'fun.json');
  const sides = { a: { base: options['base-a'] ?? 'http://127.0.0.1:3101', run: `${run}-a`, commit: BASE_COMMIT }, b: { base: options['base-b'] ?? 'http://127.0.0.1:3100', run: `${run}-b`, commit: execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim() } };
  const sentences = pickSentences(readJson(join(ROOT, 'evals', 'play', 'p54c', 'dev.json')).sentences, genres, pairs);
  for (const side of [sides.a, sides.b]) await runSentences(sentences, { base: side.base, run: side.run, 'pace-clip': true, 'draft-only': true, gpu: options.gpu === true });
  const head = { schema: 'p55-fun.v1', a: { ...sides.a, side: 'lane genres on origin/main, before P55' }, b: { ...sides.b, side: 'lane events, HEAD' }, genres, pick: `pure-rand xoroshiro128plus(${PICK_SEED}): uniformInt without replacement per genre in turn (${genres.join(', ')}) over P54C dev targets`, target: `P55 wins >= ${target}/${pairs}` };
  let verdict;
  try {
    verdict = await pairwise({ a: sides.a.run, b: sides.b.run, seed: PAIR_SEED, out: join(RUNS, `${run}-pairwise.json`), 'a-commit': sides.a.commit, 'b-commit': sides.b.commit, concurrency: 1 });
  } catch (error) {
    writeFileSync(out, `${JSON.stringify({ ...head, skipped: true, reason: error.message.slice(0, 400) }, null, 1)}\n`);
    console.log(`fun skipped: ${error.message.slice(0, 200)} -> ${out}`);
    return;
  }
  const byId = new Map(sentences.map((sentence) => [sentence.id, sentence]));
  const rows = verdict.pairs.map((pair) => ({ id: pair.id, text: byId.get(pair.id).text, genre: byId.get(pair.id).expect, old: played(sides.a.run, pair.id), new: played(sides.b.run, pair.id), left: pair.left, winner: pair.winner === 'b' ? 'new' : pair.winner === 'a' ? 'old' : 'tie', why: pair.why }));
  const newWins = verdict.summary.bWins;
  const result = { ...head, skipped: false, summary: { n: verdict.summary.n, newWins, oldWins: verdict.summary.aWins, ties: verdict.summary.ties, leftWinShare: verdict.summary.leftWinShare }, met: verdict.summary.n === pairs && newWins >= target, pairs: rows };
  writeFileSync(out, `${JSON.stringify(result, null, 1)}\n`);
  console.log(`fun: P55 wins ${newWins}/${verdict.summary.n} (target ${target}/${pairs}) ${result.met ? 'met' : 'missed'} -> ${out}`);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) await main();
