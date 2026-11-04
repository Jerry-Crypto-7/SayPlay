#!/usr/bin/env node
/**
 * P70B T1: napíše a zapečetí novou sadu vět – 30 se zvířetem z knihovny jako hrdinou (15 druhů s riggovaným
 * modelem, `ANIMAL_COUNTS` v `./seal.ts`), 20 na golf a 20 obecných přes 14 dosavadních žánrů – a hned ji dá slepě
 * oštítkovat (soudce, otázka a 29 typů z `../p68/genre-labels.mjs`, vlastní seed). Věty píše `claude -p`
 * v prázdném `mkdtemp` (`ask` z P66): vidí jen jména zvířat a popis typů her slovy, nikdy kód ani otevřené sady.
 * Shodné věty se známými sadami (`./seal.ts`, včetně otevřené P68T a vět auditu) a mezi sebou se zahodí.
 *
 *   node evals/play/p70b/write-sealed.mjs [--backup F:/Backups/Hackaton/2026-11-04]
 *
 * Píše do `SEALED_DIR` (`./seal.ts`), existující sadu nepřepíše. Vypíše jen počty a otisky, nikdy větu: kdo pak ladí
 * směrování a výběr postavy, sadu nevidí.
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

export const SEED = 70201;
const GOLF = 20;

/** Typy her, mezi které se věty se zvířetem rozloží: dosavadní žánry bez golfu (ten má vlastní třetinu). */
const ANIMAL_TYPES = Object.keys(DESCRIPTIONS).filter((genre) => genre !== 'minigolf');

const STYLE = [
  '- Write like many different real people typing on a phone: kids, parents, teenagers, casual players, people whose English is not their first language (a small grammar slip is fine), some all lowercase without punctuation.',
  '- Lengths vary: some short (3 to 8 words), most medium, a few long (up to 25 words); some are requests ("make a game where...", "can you do..."), some just describe a scene.',
  '- Vary places, enemies, goals and themes widely. Do not reuse the wording of any example given below.',
  '- English, one sentence each, no numbering, no quotation marks. Do not use any tools or search the web.',
];

const ANIMAL_SHAPES = [
  '- The named animal is the main character of the game: the one the player plays as, guides, helps or protects. No other character is the hero.',
  '- Mix the ways people put it: about a third put the animal after a verb ("help the ...", "guide the ...", "feed the ...", "save the baby ..."), some start with the bare animal name and no article, some use a plural, a baby, little or young form, or a synonym (bunny, puppy, pony, kitten, hen, fawn), some have the animal defend or protect its home, some say "play as ...".',
  '- Spread the sentences over many different game types from the list below; give each sentence the key of the type it is meant for.',
];

const ANIMAL_SCHEMA = {
  type: 'object',
  properties: { sentences: { type: 'array', items: { type: 'object', properties: { animal: { type: 'string' }, type: { type: 'string' }, text: { type: 'string' } }, required: ['animal', 'type', 'text'], additionalProperties: false } } },
  required: ['sentences'],
  additionalProperties: false,
};
const LIST_SCHEMA = { type: 'object', properties: { sentences: { type: 'array', items: { type: 'string' } } }, required: ['sentences'], additionalProperties: false };
const TYPED_SCHEMA = {
  type: 'object',
  properties: { sentences: { type: 'array', items: { type: 'object', properties: { type: { type: 'string' }, text: { type: 'string' } }, required: ['type', 'text'], additionalProperties: false } } },
  required: ['sentences'],
  additionalProperties: false,
};

const animalQuestion = (animalKeys, typeKeys, counts) => [
  'A phone app turns one typed sentence into a short game. We are writing a test set of sentences that people might type.',
  'Write sentences in which one animal is the hero of the game. Below are the animals, each under a key, with how many sentences to write for it, and the game types, each under a key.',
  '',
  'ANIMALS:',
  ...Object.entries(animalKeys).map(([key, animal]) => `${key}: ${animal} (write ${counts[animal] + 1})`),
  '',
  'GAME TYPES:',
  ...Object.entries(typeKeys).map(([key, genre]) => `${key}: ${DESCRIPTIONS[genre]}`),
  '',
  'RULES:',
  ...ANIMAL_SHAPES,
  ...STYLE,
  'Answer only as JSON per the schema: one entry per sentence, animal = the animal key, type = the game type key.',
].join('\n');

const golfQuestion = (count) => [
  'A phone app turns one typed sentence into a short game. We are writing a test set of sentences that people might type.',
  `Write ${count} different sentences that different people might type when they want to play golf.`,
  '',
  `THE GOLF GAME THE APP MAKES: ${DESCRIPTIONS.minigolf}`,
  '',
  'RULES:',
  '- About a quarter are only one to four words: the bare name of the sport or its -ing form, maybe with a request word (like "lets ..." or "i want ...").',
  '- About a quarter set the round somewhere unusual (a place, a planet, a season, a building).',
  '- About a quarter have an animal or a character playing.',
  '- About a quarter mention obstacles or hazards on the course.',
  '- Most say just "golf" or "golfing"; only a few say mini golf, crazy golf or putt.',
  ...STYLE,
  'Answer only as JSON per the schema.',
].join('\n');

const generalQuestion = (keys, counts) => [
  'A phone app turns one typed sentence into a short game. We are writing a test set of sentences that people might type.',
  'Below are several game types, each under a key. For each key write the given number of different sentences that people might type when they want that game type.',
  '',
  'GAME TYPES:',
  ...Object.entries(keys).map(([key, genre]) => `${key} (write ${counts[genre] + 2}): ${DESCRIPTIONS[genre]}`),
  '',
  'RULES:',
  '- Vary heroes, vehicles and places widely; skip the most obvious first idea and prefer a less common but believable one.',
  '- About a third of the sentences should not name the kind of game at all and only describe what happens in it.',
  '- Every sentence must still clearly ask for its own game type, not for a different kind of game.',
  ...STYLE,
  'Answer only as JSON per the schema: one entry per sentence, type = its key.',
].join('\n');

const flag = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : process.argv[i + 1];
};
const keyed = (list, prefix) => Object.fromEntries(list.map((value, i) => [`${prefix}${String(i + 1).padStart(2, '0')}`, value]));

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
  /** Přidá do `into` novou větu (bez shody se známými a už vybranými), dokud jich není `want`. */
  const keep = (raw, into, want, extra = {}) => {
    const text = String(raw).trim();
    stats.generated += 1;
    const key = normalize(text);
    if (key === '' || into.length >= want || seen.has(key)) {
      stats.dropped += 1;
      return;
    }
    seen.add(key);
    into.push({ text, ...extra });
  };

  // Zvířata: druh → věty; typ, na který věta míří, je `aimed`.
  const counts = seal.ANIMAL_COUNTS;
  const animalKeys = keyed(Object.keys(counts), 'A');
  const typeKeys = keyed(ANIMAL_TYPES, 'T');
  const animals = Object.fromEntries(Object.keys(counts).map((animal) => [animal, []]));
  const short = () => Object.entries(animals).some(([animal, list]) => list.length < counts[animal]);
  for (let attempt = 0; attempt < 3 && short(); attempt += 1) {
    for (const row of await call(animalQuestion(animalKeys, typeKeys, counts), ANIMAL_SCHEMA)) {
      const animal = animalKeys[row.animal];
      const aimed = typeKeys[row.type];
      if (animal !== undefined && aimed !== undefined) keep(row.text, animals[animal], counts[animal], { aimed });
    }
  }
  for (const [animal, list] of Object.entries(animals)) if (list.length < counts[animal]) throw new Error(`${animal}: only ${list.length}/${counts[animal]} new sentences after 3 calls`);
  console.log(`animals: ${Object.values(animals).flat().length}/30 over ${Object.keys(animals).length} kinds`);

  const golf = [];
  for (let attempt = 0; attempt < 3 && golf.length < GOLF; attempt += 1) for (const text of await call(golfQuestion(GOLF + 8), LIST_SCHEMA)) keep(text, golf, GOLF);
  if (golf.length < GOLF) throw new Error(`golf: only ${golf.length}/${GOLF} new sentences after 3 calls`);
  console.log(`golf: ${golf.length}/${GOLF}`);

  const generalCounts = seal.GENERAL_COUNTS;
  const generalKeys = keyed(Object.keys(generalCounts), 'T');
  const general = Object.fromEntries(Object.keys(generalCounts).map((genre) => [genre, []]));
  for (let attempt = 0; attempt < 3 && Object.entries(general).some(([genre, list]) => list.length < generalCounts[genre]); attempt += 1) {
    for (const row of await call(generalQuestion(generalKeys, generalCounts), TYPED_SCHEMA)) {
      const genre = generalKeys[row.type];
      if (genre !== undefined) keep(row.text, general[genre], generalCounts[genre]);
    }
  }
  for (const [genre, list] of Object.entries(general)) if (list.length < generalCounts[genre]) throw new Error(`${genre}: only ${list.length}/${generalCounts[genre]} new sentences after 3 calls`);
  console.log(`general: ${Object.values(general).flat().length}/20 over ${Object.keys(general).length} genres`);

  const sentences = [
    ...Object.entries(animals).flatMap(([animal, list]) => list.map(({ text, aimed }) => ({ half: 'animal', genre: aimed, hero: animal, heroModels: [...seal.ANIMALS[animal]], text }))),
    ...golf.map(({ text }) => ({ half: 'golf', genre: 'minigolf', text })),
    ...Object.entries(general).flatMap(([genre, list]) => list.map(({ text }) => ({ half: 'general', genre, text }))),
  ];
  const rows = sentences.map((s, i) => ({ id: `p70b-${String(i + 1).padStart(3, '0')}`, ...s }));

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

  const holdout = `${JSON.stringify({ about: 'P70B sealed holdout, written 2026-11-04 (T1) by claude -p from animal names and game descriptions only, before any P70B routing or model-choice change; opened once in T5.', sentences: rows }, null, 1)}\n`;
  const labelled = `${JSON.stringify({
    schema: 'p70b-holdout-labels.v1',
    about: 'Blind text judge labels for the 70 sentences of the sealed P70B holdout, written at sealing time (T1) before any change; same judge, question and 29 plain-word types as p68/genre-labels.json, own seed. aimed = the game type the sentence was written for (minigolf for golf). hero/heroModels = the animal the sentence was written for and the rigged models that count as that animal.',
    judge: `${MODEL} (claude -p --safe-mode --tools "" in an empty mkdtemp; sees only numbered sentences and the 29 type descriptions under keys G01-G29)`,
    seed: SEED,
    batchSize: BATCH,
    keys,
    batches: batches.length,
    sentences: rows.map((row) => {
      const label = labels.get(normalize(row.text));
      const hero = row.hero === undefined ? {} : { hero: row.hero, heroModels: row.heroModels };
      return { text: row.text, sets: [{ set: 'p70b/holdout.json', id: row.id }], id: row.id, half: row.half, aimed: row.genre, ...hero, best: label.best, acceptable: label.acceptable, batch: label.batch };
    }),
  }, null, 1)}\n`;
  mkdirSync(seal.SEALED_DIR, { recursive: true });
  writeFileSync(seal.HOLDOUT_PATH, holdout);
  writeFileSync(seal.LABELS_PATH, labelled);
  const backup = flag('--backup', 'F:/Backups/Hackaton/2026-11-04');
  try {
    mkdirSync(backup, { recursive: true });
    copyFileSync(seal.HOLDOUT_PATH, path.join(backup, 'p70b-holdout.json'));
    copyFileSync(seal.LABELS_PATH, path.join(backup, 'p70b-holdout-labels.json'));
    console.log(`backup: ${backup}`);
  } catch (error) {
    console.log(`backup FAILED: ${error.message}`);
  }
  console.log(JSON.stringify({ ...stats, sentences: rows.length, holdoutSha256: seal.sha256Lf(holdout), labelsSha256: seal.sha256Lf(labelled) }));
}

if (isMain) await main();
