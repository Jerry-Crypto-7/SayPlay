#!/usr/bin/env node
/**
 * P68 T2: slepé štítky žánrů pro 29 typů her (24 dnešních + stunt závod, minigolf, střelnice na kolejích, směna se
 * stavbou obchodu, kresli-a-zachraň). Postup, soudce a tvar odpovědi jsou z P66 (`../p66/genre-labels.mjs`); mění se
 * jen seznam typů, seed a sady: sada 200, otevřené sady P66 a navíc `p66/dev.json`, `p66/holdout.json` (otevřený
 * v P66 T16) a `p68/dev.json`. Holdout P68 žije mimo repo a neštítkuje se.
 *
 *   node evals/play/p68/genre-labels.mjs [--out evals/play/p68/genre-labels.json] [--limit <dávek>] [--fresh]
 *
 * Hotové dávky se zapisují po každé dávce; další běh je přeskočí.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { uniformInt } from 'pure-rand/distribution/uniformInt';
import { xoroshiro128plus } from 'pure-rand/generator/xoroshiro128plus';

import { ANSWER_SCHEMA, BATCH, DESCRIPTIONS as P66_DESCRIPTIONS, MODEL, TEST_SET, ask, normalize, openSets as p66OpenSets, readAnswer, rowsOf } from '../p66/genre-labels.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

export const SEED = 68002;
export { ANSWER_SCHEMA, TEST_SET };

/** Pět nových typů vlastními slovy (bez id z kódu, jména produktu a jmen cizích her); 24 dnešních beze změny z P66. */
export const DESCRIPTIONS = {
  ...P66_DESCRIPTIONS,
  stunt: 'Stunt driving race: drive a car, truck or bike down a track full of ramps, fly off the jumps and crash through stacks of crates or barrels on the way to the finish line before the time runs out.',
  minigolf: 'Mini golf: aim and choose the strength of each shot to roll a ball around walls, bends and obstacles of a small course into the hole in as few strokes as possible.',
  railfps: 'Shooting from a moving ride, seen through your own eyes: you travel along a fixed route, turn to aim left and right at targets that appear around you and shoot them before they hurt you.',
  buildshift: 'Running a shop for one shift: place counters, machines or stations on a floor grid, pay for them from what you earn and serve the customers who keep arriving before they give up; build badly and the shift is lost.',
  drawsave: 'Draw to protect: draw lines with your finger that turn into walls, then something falls, rolls or attacks and the walls have to keep the protected thing safe.',
};
export const GENRE_IDS = Object.keys(DESCRIPTIONS);
export const NEW_GENRES = ['stunt', 'minigolf', 'railfps', 'buildshift', 'drawsave'];

/** Otevřené sady P66 + dev a otevřený holdout P66 + dev P68 (cesty od `evals/play`). */
export function openSets() {
  return [...p66OpenSets(), 'p66/dev.json', 'p66/holdout.json', 'p68/dev.json'].filter((set) => rowsOf(set).length > 0);
}

/** Jedinečné věty (podle `normalize`) sady 200 a otevřených sad; věta nese všechna místa, kde stojí. */
export function loadSentences() {
  const byKey = new Map();
  for (const set of [TEST_SET, ...openSets()]) {
    for (const row of rowsOf(set)) {
      const key = normalize(row.text);
      const entry = byKey.get(key) ?? { key, text: row.text, sets: [] };
      entry.sets.push({ set, id: row.id });
      byKey.set(key, entry);
    }
  }
  return [...byKey.values()];
}

/** Fisher–Yates `pure-rand` xoroshiro128plus jedním proudem: nejdřív klíče 29 typů, pak pořadí vět (jako P66). */
export function plan(sentences, seed = SEED) {
  const rng = xoroshiro128plus(seed);
  const shuffle = (list) => {
    const out = list.slice();
    for (let k = out.length - 1; k > 0; k -= 1) {
      const j = uniformInt(rng, 0, k);
      [out[k], out[j]] = [out[j], out[k]];
    }
    return out;
  };
  const keys = Object.fromEntries(shuffle(GENRE_IDS).map((genre, i) => [`G${String(i + 1).padStart(2, '0')}`, genre]));
  const order = shuffle(sentences.map((s) => s.key));
  const batches = [];
  for (let i = 0; i < order.length; i += BATCH) batches.push(order.slice(i, i + BATCH));
  return { keys, batches };
}

/** Otázka P66 nad 29 typy. */
export function questionFor(texts, keys) {
  const types = Object.entries(keys).map(([key, genre]) => `${key}: ${DESCRIPTIONS[genre]}`);
  const lines = texts.map((text, i) => `${i + 1}. ${text}`);
  return [
    'Each sentence below was typed by a person who wants a short game for a phone made from it. For every sentence choose, from the game types listed, the one that would fit the sentence best, and the types that would all be acceptable readings of it.',
    '',
    'GAME TYPES:',
    ...types,
    '',
    'RULES:',
    '- best: the one type key that fits the sentence best. Use NONE only when the sentence asks for no playable action at all (a question, an essay, a chore, a request for information) so that no type could reasonably be read into it.',
    '- acceptable: 1 to 3 type keys, best included, under which a player would still recognise their sentence. Empty only when best is NONE.',
    '- Judge only from the sentence text. Do not use any tools or search the web.',
    'Answer only as JSON per the schema, one entry per sentence number n.',
    '',
    'SENTENCES:',
    ...lines,
  ].join('\n');
}

const flag = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : process.argv[i + 1];
};

async function main() {
  const out = path.resolve(flag('--out', path.join(HERE, 'genre-labels.json')));
  const limit = Number(flag('--limit', 'Infinity'));
  const sentences = loadSentences();
  const { keys, batches } = plan(sentences);
  const prior = !process.argv.includes('--fresh') && existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) : null;
  const done = new Map(Object.entries(prior?.batchResults ?? {}));
  const calls = { total: prior?.calls?.total ?? 0, failed: prior?.calls?.failed ?? 0, seconds: prior?.calls?.seconds ?? 0 };
  const byKey = new Map(sentences.map((s) => [s.key, s]));
  const write = () => {
    const labels = new Map();
    for (const [, rows] of done) for (const row of rows) labels.set(row.key, row);
    const rows = sentences.map((s) => ({ text: s.text, sets: s.sets, ...(labels.has(s.key) ? { best: labels.get(s.key).best, acceptable: labels.get(s.key).acceptable, batch: labels.get(s.key).batch } : { best: null, acceptable: null, batch: null }) }));
    const sets = Object.fromEntries([TEST_SET, ...openSets()].map((set) => [set, rowsOf(set).length]));
    writeFileSync(out, `${JSON.stringify({
      schema: 'p68-genre-labels.v1',
      about: 'Blind text judge labels per unique sentence (normalized text) of the 200 set and the open sets: best genre (or none = no game in the sentence) and 1-3 acceptable genres out of 29 (24 current + stunt, minigolf, railfps, buildshift, drawsave). Frozen before P68 wires any new game; the P68 holdout is not labelled.',
      judge: `${MODEL} (claude -p --safe-mode --tools "" in an empty mkdtemp; sees only numbered sentences and the 29 plain-word type descriptions under keys G01-G29)`,
      seed: SEED,
      generator: 'pure-rand xoroshiro128plus + uniformInt, Fisher-Yates: first the G-key order of the 29 types, then the sentence order; batches = consecutive 20',
      batchSize: BATCH,
      keys,
      descriptions: DESCRIPTIONS,
      sets,
      unique: sentences.length,
      batches: batches.length,
      batchesDone: done.size,
      calls,
      batchResults: Object.fromEntries(done),
      sentences: rows,
    }, null, 1)}\n`);
  };
  let ran = 0;
  for (let b = 0; b < batches.length && ran < limit; b += 1) {
    if (done.has(String(b))) continue;
    const texts = batches[b].map((key) => byKey.get(key).text);
    const question = questionFor(texts, keys);
    let rows = null;
    for (let attempt = 0; attempt < 2 && rows === null; attempt += 1) {
      const result = await ask(question);
      calls.total += 1;
      calls.seconds = Math.round((calls.seconds + result.seconds) * 10) / 10;
      rows = result.error === undefined ? readAnswer(result.answer, texts.length, keys) : null;
      if (rows === null) {
        calls.failed += 1;
        console.log(`batch ${b} attempt ${attempt}: ${result.error ?? 'answer does not fit the schema'} (${result.seconds} s)`);
      } else console.log(`batch ${b}/${batches.length}: ok (${result.seconds} s)`);
    }
    ran += 1;
    if (rows === null) continue;
    done.set(String(b), rows.map((row, i) => ({ key: batches[b][i], batch: b, ...row })));
    write();
  }
  write();
  console.log(`DONE batches ${done.size}/${batches.length}, calls ${calls.total} (failed ${calls.failed})`);
}

if (isMain) await main();
