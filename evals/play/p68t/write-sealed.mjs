#!/usr/bin/env node
/**
 * P68T T1: napíše a zapečetí novou sadu vět – 15 na `railfps`, `buildshift`, `drawsave`, 15 na `minigolf` (hlídání)
 * a 30 obecných přes 22 dosavadních žánrů – a hned ji dá slepě oštítkovat (soudce, otázka a 29 typů z
 * `../p68/genre-labels.mjs`, vlastní seed). Věty píše `claude -p` v prázdném `mkdtemp` (`ask` z P66): vidí jen popis
 * typu hry a řádek pro režiséra, nikdy kód směrování ani otevřené sady. Shodné věty se známými sadami (`./seal.ts`,
 * včetně otevřené P68R) a mezi sebou se zahodí.
 *
 *   node evals/play/p68t/write-sealed.mjs [--backup F:/Backups/Hackaton/2026-11-04]
 *
 * Píše do `SEALED_DIR` (`./seal.ts`), existující sadu nepřepíše. Vypíše jen počty a otisky, nikdy větu: kdo pak ladí
 * směrování, sadu nevidí.
 */

import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { ask, BATCH, MODEL, normalize, readAnswer } from '../p66/genre-labels.mjs';
import { DESCRIPTIONS, plan, questionFor } from '../p68/genre-labels.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

// `./seal.ts` je TypeScript; holý `node` ho načte až s odstraňováním typů.
if (isMain && !process.features.typescript) {
  const run = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', fileURLToPath(import.meta.url), ...process.argv.slice(2)], { stdio: 'inherit' });
  process.exit(run.status ?? 1);
}

export const SEED = 68201;
const PER_GAME = 15;
/** Tři hry pod prahem P68R a `minigolf`, který práh splnil a nesmí klesnout. */
export const GAMES = ['railfps', 'buildshift', 'drawsave', 'minigolf'];

/** Řádek pro režiséra: `GENRE_PITCH` v `src/play/director/prompt.ts` (u `railfps` bez slovesa z kódu, jako P68R). */
const PITCH = {
  minigolf: 'one mini golf hole: the hero is always the ball, cast things are bumpers, one with patrol sweeps across the lane, sink it within par + 3 strokes; "putt past a spinning windmill on a pirate ship"',
  railfps: 'turn and shoot foes before they reach you, a rail moves you on between waves, boss last; not roaming, sneaking or racing; "blast snow goblins from a cable car"',
  buildshift: 'build the stations of a small shop on a grid, open it and serve arriving customers their goods before the shift ends; "robots line up for pizza at my tiny diner", "serve 12 cats their milk"',
  drawsave: 'draw lines to shield a character from falling things for 10 seconds; "draw a line to save the puppy from falling rocks", "shield the frog from fifteen hailstones"',
};

/** Obecná polovina: 30 vět přes 22 dosavadních žánrů (rozpis P68R). */
const GENERAL = { voyage: 3, platformer: 2, runner: 2, shooter: 2, throw: 2, quest: 2, defense: 2, arena: 1, timing: 1, rhythm: 1, duel: 1, flap: 1, catch: 1, whack: 1, slice: 1, hop: 1, crowd: 1, merge: 1, push: 1, survivor: 1, hole: 1, steal: 1 };

/** Styl P68R plus víc různých pisatelů a méně samozřejmých nápadů – sada P68R je otevřená, nová ji nemá kopírovat. */
const STYLE = [
  '- Write like many different real people typing on a phone: kids, parents, teenagers, casual players, people whose English is not their first language (a small grammar slip is fine), some all lowercase without punctuation.',
  '- Lengths vary: some short (4 to 8 words), most medium, a few long (up to 30 words); some are requests ("make a game where...", "can you do..."), some just describe a scene, some say what the player wants to feel or win.',
  '- Vary heroes, vehicles, places, enemies and themes widely (jobs, holidays, history, space, food, sport, weather, school, family, fantasy, animals). Skip the most obvious first idea for each sentence and prefer a less common but believable one. Do not reuse the heroes, vehicles, places or wording of any example given below.',
  '- About a third of the sentences should not name the kind of game at all and only describe what happens in it.',
  '- Every sentence must still clearly ask for its own game type, not for a different kind of game.',
  '- English, one sentence each, no numbering, no quotation marks. Do not use any tools or search the web.',
];

const LIST_SCHEMA = { type: 'object', properties: { sentences: { type: 'array', items: { type: 'string' } } }, required: ['sentences'], additionalProperties: false };
const TYPED_SCHEMA = {
  type: 'object',
  properties: { sentences: { type: 'array', items: { type: 'object', properties: { type: { type: 'string' }, text: { type: 'string' } }, required: ['type', 'text'], additionalProperties: false } } },
  required: ['sentences'],
  additionalProperties: false,
};

const gameQuestion = (game, count) => [
  'A phone app turns one typed sentence into a short game. We are writing a test set of sentences that people might type.',
  `Write ${count} different sentences that different people might type when they want the game type below.`,
  '',
  `GAME TYPE: ${DESCRIPTIONS[game]}`,
  `NOTES FOR THE GAME MAKER: ${PITCH[game]}`,
  '',
  'RULES:',
  ...STYLE,
  'Answer only as JSON per the schema.',
].join('\n');

const generalQuestion = (keys) => [
  'A phone app turns one typed sentence into a short game. We are writing a test set of sentences that people might type.',
  'Below are several game types, each under a key. For each key write the given number of different sentences that people might type when they want that game type.',
  '',
  'GAME TYPES:',
  ...Object.entries(keys).map(([key, genre]) => `${key} (write ${GENERAL[genre] + 2}): ${DESCRIPTIONS[genre]}`),
  '',
  'RULES:',
  ...STYLE,
  'Answer only as JSON per the schema: one entry per sentence, type = its key.',
].join('\n');

const flag = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : process.argv[i + 1];
};

async function main() {
  const repo = path.resolve(HERE, '../../..');
  await import(pathToFileURL(path.join(repo, 'scripts/ts-paths.mjs')).href);
  const seal = await import(pathToFileURL(path.join(HERE, 'seal.ts')).href);
  if (existsSync(seal.HOLDOUT_PATH) || existsSync(seal.LABELS_PATH)) throw new Error(`${seal.SEALED_DIR} already holds a sealed set – refusing to overwrite it`);
  const seen = new Set(seal.knownSets().flatMap((set) => seal.textsOf(set).map((text) => normalize(text))));
  const stats = { known: seen.size, generated: 0, dropped: 0, calls: 0, failed: 0, seconds: 0 };
  const call = async (question, schema) => {
    const result = await ask(question, schema);
    stats.calls += 1;
    stats.seconds = Math.round((stats.seconds + result.seconds) * 10) / 10;
    if (result.error !== undefined || !Array.isArray(result.answer?.sentences)) {
      stats.failed += 1;
      console.log(`call failed (${result.seconds} s): ${(result.error ?? 'answer does not fit the schema').slice(0, 160)}`);
      return [];
    }
    return result.answer.sentences;
  };
  /** Přidá do `into` nové věty (bez shody se známými a už vybranými), dokud jich není `want`. */
  const keep = (texts, into, want) => {
    for (const raw of texts) {
      const text = String(raw).trim();
      stats.generated += 1;
      const key = normalize(text);
      if (text === '' || into.length >= want || seen.has(key)) {
        stats.dropped += 1;
        continue;
      }
      seen.add(key);
      into.push(text);
    }
  };

  const sentences = [];
  for (const game of GAMES) {
    const chosen = [];
    for (let attempt = 0; attempt < 3 && chosen.length < PER_GAME; attempt += 1) keep(await call(gameQuestion(game, PER_GAME + 7), LIST_SCHEMA), chosen, PER_GAME);
    if (chosen.length < PER_GAME) throw new Error(`${game}: only ${chosen.length}/${PER_GAME} new sentences after 3 calls`);
    console.log(`${game}: ${chosen.length}/${PER_GAME}`);
    for (const text of chosen) sentences.push({ half: 'new', genre: game, game, text });
  }
  const typeKeys = Object.fromEntries(Object.keys(GENERAL).map((genre, i) => [`T${String(i + 1).padStart(2, '0')}`, genre]));
  const general = Object.fromEntries(Object.keys(GENERAL).map((genre) => [genre, []]));
  for (let attempt = 0; attempt < 3 && Object.entries(general).some(([genre, list]) => list.length < GENERAL[genre]); attempt += 1) {
    for (const row of await call(generalQuestion(typeKeys), TYPED_SCHEMA)) {
      const genre = typeKeys[row.type];
      if (genre !== undefined) keep([row.text], general[genre], GENERAL[genre]);
    }
  }
  for (const [genre, list] of Object.entries(general)) {
    if (list.length < GENERAL[genre]) throw new Error(`${genre}: only ${list.length}/${GENERAL[genre]} new sentences after 3 calls`);
    for (const text of list) sentences.push({ half: 'general', genre, game: genre, text });
  }
  console.log(`general: ${Object.values(general).flat().length}/30 over ${Object.keys(GENERAL).length} genres`);
  const rows = sentences.map((s, i) => ({ id: `p68t-${String(i + 1).padStart(3, '0')}`, ...s }));

  // Slepé štítky: stejná otázka a 29 typů jako `p68/genre-labels.json`, pořadí a klíče z vlastního seedu.
  const byKey = new Map(rows.map((row) => [normalize(row.text), row]));
  const { keys, batches } = plan([...byKey.keys()].map((key) => ({ key })), SEED);
  const labels = new Map();
  for (let b = 0; b < batches.length; b += 1) {
    const texts = batches[b].map((key) => byKey.get(key).text);
    let answer = null;
    for (let attempt = 0; attempt < 3 && answer === null; attempt += 1) {
      const result = await ask(questionFor(texts, keys));
      stats.calls += 1;
      stats.seconds = Math.round((stats.seconds + result.seconds) * 10) / 10;
      answer = result.error === undefined ? readAnswer(result.answer, texts.length, keys) : null;
      if (answer === null) stats.failed += 1;
    }
    if (answer === null) throw new Error(`labels batch ${b}: no usable answer after 3 calls`);
    answer.forEach((label, i) => labels.set(batches[b][i], { ...label, batch: b }));
    console.log(`labels batch ${b + 1}/${batches.length}: ok`);
  }

  const holdout = `${JSON.stringify({ about: 'P68T sealed holdout, written 2026-11-04 (T1) by claude -p from game descriptions only, before any P68T routing change; opened once in T3.', sentences: rows }, null, 1)}\n`;
  const labelled = `${JSON.stringify({
    schema: 'p68t-holdout-labels.v1',
    about: 'Blind text judge labels for the 90 sentences of the sealed P68T holdout, written at sealing time (T1) before any routing change; same judge, question and 29 plain-word types as p68/genre-labels.json, own seed. aimed = the game or genre the sentence was written for.',
    judge: `${MODEL} (claude -p --safe-mode --tools "" in an empty mkdtemp; sees only numbered sentences and the 29 type descriptions under keys G01-G29)`,
    seed: SEED,
    batchSize: BATCH,
    keys,
    batches: batches.length,
    sentences: rows.map((row) => {
      const label = labels.get(normalize(row.text));
      return { text: row.text, sets: [{ set: 'p68t/holdout.json', id: row.id }], id: row.id, half: row.half, aimed: row.genre, best: label.best, acceptable: label.acceptable, batch: label.batch };
    }),
  }, null, 1)}\n`;
  mkdirSync(seal.SEALED_DIR, { recursive: true });
  writeFileSync(seal.HOLDOUT_PATH, holdout);
  writeFileSync(seal.LABELS_PATH, labelled);
  const backup = flag('--backup', 'F:/Backups/Hackaton/2026-11-04');
  try {
    mkdirSync(backup, { recursive: true });
    copyFileSync(seal.HOLDOUT_PATH, path.join(backup, 'p68t-holdout.json'));
    copyFileSync(seal.LABELS_PATH, path.join(backup, 'p68t-holdout-labels.json'));
    console.log(`backup: ${backup}`);
  } catch (error) {
    console.log(`backup FAILED: ${error.message}`);
  }
  console.log(JSON.stringify({ ...stats, sentences: rows.length, holdoutSha256: seal.sha256Lf(holdout), labelsSha256: seal.sha256Lf(labelled) }));
}

if (isMain) await main();
