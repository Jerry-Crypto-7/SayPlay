/**
 * Slepý soud zábavy P54C (T17): pro deset vět dev sady P54C natočí klip průběhu
 * staré hry (server nad `main` před P54C) a nového žánru (server nad HEAD),
 * oba bez modelu (`draft-only`), a slepý párový soudce P45 (`pairwise`, Codex,
 * prázdný adresář jen se `sheet.png`) řekne, která by ho víc bavila.
 * Výsledek jde do `evals/play/p54c/fun.json`; soudce bez odpovědi (vyčerpaný
 * limit, ztráta přihlášení) = úloha přeskočena a zapsaná, ne remíza.
 *
 *   node evals/play/p54c/fun.mjs --base-a http://127.0.0.1:3101 --base-b http://127.0.0.1:3100 [--gpu]
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

/** Strana A: `main` po P52 (#39), ze kterého P54C vychází. */
export const BASE_COMMIT = '1476989e';
export const GENRES = ['catch', 'whack', 'defense', 'slice', 'hop', 'crowd', 'merge', 'push'];
export const PICK_SEED = 54017;
export const PAIRS = 10;
export const TARGET_WINS = 6;

/**
 * Deset vět: z každého žánru jedna los ze seedu, pak dvě další ze zbytku.
 * Jeden stream `pure-rand`, žánry v pořadí `GENRES` – stejný seed = stejné věty.
 */
export function pickSentences(sentences, seed = PICK_SEED) {
  const rng = xoroshiro128plus(seed);
  const targets = sentences.filter((sentence) => sentence.family === 'target');
  const picked = GENRES.map((genre) => {
    const pool = targets.filter((sentence) => sentence.expect === `${genre}.default`);
    return pool[uniformInt(rng, 0, pool.length - 1)];
  });
  const rest = targets.filter((sentence) => !picked.includes(sentence));
  while (picked.length < PAIRS) picked.push(rest.splice(uniformInt(rng, 0, rest.length - 1), 1)[0]);
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
  const run = typeof options.run === 'string' ? options.run : 'p54c-t17';
  const sides = { a: { base: options['base-a'] ?? 'http://127.0.0.1:3101', run: `${run}-a`, commit: BASE_COMMIT }, b: { base: options['base-b'] ?? 'http://127.0.0.1:3100', run: `${run}-b`, commit: execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim() } };
  const sentences = pickSentences(readJson(join(HERE, 'dev.json')).sentences);
  for (const side of [sides.a, sides.b]) await runSentences(sentences, { base: side.base, run: side.run, 'pace-clip': true, 'draft-only': true, gpu: options.gpu === true });
  const out = join(HERE, 'fun.json');
  const head = { schema: 'p54c-fun.v1', task: 'P54C T17', a: { ...sides.a, side: 'old game, main before P54C' }, b: { ...sides.b, side: 'new genre, HEAD' }, pick: `pure-rand xoroshiro128plus(${PICK_SEED}): one uniformInt per genre in order ${GENRES.join(', ')}, then ${PAIRS - GENRES.length} more from the remaining dev targets`, target: `new genre wins >= ${TARGET_WINS}/${PAIRS}` };
  let verdict;
  try {
    verdict = await pairwise({ a: sides.a.run, b: sides.b.run, seed: PAIR_SEED, out: join(RUNS, `${run}-pairwise.json`), 'a-commit': sides.a.commit, 'b-commit': sides.b.commit, concurrency: 1 });
  } catch (error) {
    writeFileSync(out, `${JSON.stringify({ ...head, skipped: true, reason: error.message.slice(0, 400) }, null, 1)}\n`);
    console.log(`fun skipped: ${error.message.slice(0, 200)} -> ${out}`);
    return;
  }
  const byId = new Map(sentences.map((sentence) => [sentence.id, sentence]));
  const pairs = verdict.pairs.map((pair) => ({ id: pair.id, text: byId.get(pair.id).text, genre: byId.get(pair.id).expect, old: played(sides.a.run, pair.id), new: played(sides.b.run, pair.id), left: pair.left, winner: pair.winner === 'b' ? 'new' : pair.winner === 'a' ? 'old' : 'tie', why: pair.why }));
  const newWins = verdict.summary.bWins;
  const result = { ...head, skipped: false, calls: pairs.length, summary: { n: verdict.summary.n, newWins, oldWins: verdict.summary.aWins, ties: verdict.summary.ties, newShare: verdict.summary.bShare, leftWinShare: verdict.summary.leftWinShare }, met: verdict.summary.n === PAIRS && newWins >= TARGET_WINS, pairs };
  writeFileSync(out, `${JSON.stringify(result, null, 1)}\n`);
  console.log(`fun: new genre wins ${newWins}/${verdict.summary.n} (target ${TARGET_WINS}/${PAIRS}) ${result.met ? 'met' : 'missed'} -> ${out}`);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) await main();
