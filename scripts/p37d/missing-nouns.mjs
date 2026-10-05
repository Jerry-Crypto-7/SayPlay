#!/usr/bin/env node
/**
 * Podstatná jména, která porotci píšou a knihovna nemá (P37D T1).
 *
 *   node scripts/p37d/missing-nouns.mjs      zapíše evals/play/p37d/missing.json
 *
 * Věty bere z poptávky (`evals/play/demand`), sady věrnosti, `judge-10`,
 * vývojové sady P30 a – až ji P37A napíše – z `evals/play/p37a/dev-150.json`.
 * Zapečetěná `evals/play/p30/test-200.json` se nečte nikdy. K větám přidá vlastní
 * seznam častých herních jmen (`evals/play/p37d/common-nouns.json`), ať knihovna
 * nekryje jen to, co už někdo napsal.
 *
 * Každé slovo věty skončí v právě jedné přihrádce, v tomhle pořadí:
 * - `covered` – katalog ho má jako id, štítek nebo identitu hrdiny (jednotné
 *   číslo přes `singular` z `lexicon.ts`); položka kontrolního seznamu i tehdy,
 *   když katalog má některé z jejích `match` slov – ta porota uzná;
 * - `undrawable` – abstraktní („taxes“, „physics“), vědomě bez modelu;
 * - mimo seznam – `ops/gen3d/not-nouns.txt` (slovesa, přídavná jména, místa, značky);
 * - `missing` – podstatné jméno ze seznamu nebo z kontrolního seznamu věty;
 * - `settings` – prostředí z kontrolního seznamu, kreslí ho scéna, ne model;
 * - `unclassified` – nic z toho; patří do jednoho ze seznamů, ne do výroby.
 *
 * `missing` je seřazené podle počtu vět, pak podle pořadí v seznamu častých jmen.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

// Lexikon je TypeScript; holý `node` ho načte až s odstraňováním typů.
if (isMain && !process.features.typescript) {
  const run = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', fileURLToPath(import.meta.url), ...process.argv.slice(2)], { stdio: 'inherit' });
  process.exit(run.status ?? 1);
}
const { singular } = await import('../../src/play/draft/lexicon.ts');

/** Sady vět; `optional` = soubor ještě nemusí existovat. Zapečetěná sada tu chybí schválně. */
export const SETS = [
  { name: 'demand', file: 'evals/play/demand/corpus.json' },
  { name: 'fidelity', file: 'evals/play/fidelity/corpus.json' },
  { name: 'judge-10', file: 'evals/play/fidelity/judge-10.json' },
  { name: 'dev', file: 'evals/play/p30/dev.json' },
  { name: 'dev-150', file: 'evals/play/p37a/dev-150.json', optional: true },
];

const OBJECT_SLOTS = new Set(['hero', 'role', 'any']);
const EXAMPLES = 3;

/** Slova na -men, která množné číslo nejsou. */
const MEN_SINGULAR = new Set(['omen', 'amen', 'specimen', 'abdomen', 'regimen', 'stamen', 'acumen', 'hymen']);

/** `singular` z návrhu ze slov plus dvě třídy, které zkazí: „snowmen“ → „snowman“, „physics“ zůstane. */
function singularOf(word) {
  if (word.endsWith('ics')) return word;
  if (word.endsWith('men') && !MEN_SINGULAR.has(word)) return `${word.slice(0, -3)}man`;
  return singular(word);
}

/** „Café“ → „cafe“, „Zombies!“ → „zombie“. */
export function wordsOf(text) {
  const plain = text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
  return (plain.match(/[a-z]+(?:-[a-z]+)*/g) ?? []).map(singularOf);
}

/** Fráze malými písmeny, jednotné číslo posledního slova, pomlčky jako mezery („rowing-boat“ = „rowing boat“). */
export const normal = (phrase) => wordsOf(phrase.replaceAll('-', ' ')).join(' ');

/** Slova a fráze, které katalog PLAY umí nakreslit: id (bez předpony výroby), štítky a identity hrdinů. */
export function coveredVocabulary({ index, playEntries, rigged }) {
  const names = [
    ...index.assets.flatMap((asset) => [asset.assetId.replace(/^(?:cc0|gen3d)-/, ''), ...asset.tags]),
    ...playEntries.entries.flatMap((entry) => [entry.id, ...entry.identity]),
    ...rigged.flatMap((file) => file.characters.flatMap((character) => character.tags)),
  ];
  return new Set(names.map(normal).filter((name) => name !== ''));
}

/** Řádky `not-nouns.txt` bez komentářů, v tvaru slov věty („endles“ → „endle“, „tetris“ → „tetri“). */
export const parseNotNouns = (text) =>
  new Set(text.split(/\r?\n/).filter((line) => !line.startsWith('#')).flatMap((line) => line.split(/\s+/)).filter(Boolean).flatMap(wordsOf));

/** Věty sady, ať je soubor pole (poptávka) nebo `{ sentences }` (sady s kontrolním seznamem). */
const sentencesOf = (data) => (Array.isArray(data) ? data : data.sentences);

/**
 * Rozdělí slova vět do přihrádek (viz hlavička souboru).
 * `sets` = `[{ name, sentences }]`, `common` = `{ tiers: { <tier>: string[] }, abstract: string[] }`.
 */
export function missingNouns({ sets, common, notNouns, covered }) {
  const rank = new Map();
  for (const noun of Object.values(common.tiers).flat()) if (!rank.has(normal(noun))) rank.set(normal(noun), rank.size);
  const abstract = new Set(common.abstract.map(normal));
  const nouns = new Set(rank.keys());
  const settings = new Set();
  /** Slova `match` položek kontrolního seznamu: synonyma, která porota uzná. */
  const synonyms = new Map();

  // Jedna věta se počítá jednou, i když ji obsahuje víc sad (vývojová sada kopíruje korpus a judge-10).
  const sentences = new Map();
  for (const set of sets) {
    for (const sentence of set.sentences) {
      const key = wordsOf(sentence.text).join(' ');
      const seen = sentences.get(key) ?? { id: sentence.id, words: key.split(' '), sources: new Set() };
      seen.sources.add(set.name);
      sentences.set(key, seen);
      for (const item of sentence.checklist ?? []) {
        if (item.slot === 'setting') settings.add(normal(item.item));
        if (!OBJECT_SLOTS.has(item.slot)) continue;
        const noun = normal(item.item);
        nouns.add(noun);
        const own = synonyms.get(noun) ?? new Set();
        for (const word of item.match ?? []) own.add(normal(word));
        synonyms.set(noun, own);
      }
    }
  }

  const isCovered = (noun) => covered.has(noun) || [...(synonyms.get(noun) ?? [])].some((word) => covered.has(word));
  const phrases = [...new Set([...nouns, ...covered, ...settings])].filter((phrase) => phrase.includes(' '));

  /** Slovo → { počet vět, sady, příklady }. */
  const counts = new Map();
  for (const { id, words, sources } of sentences.values()) {
    const joined = ` ${words.join(' ')} `;
    const found = new Set(words.filter((word) => word.length > 2));
    for (const phrase of phrases) {
      if (!joined.includes(` ${phrase} `)) continue;
      found.add(phrase);
      for (const part of phrase.split(' ')) found.delete(part); // „space marine“, ne „space“
    }
    for (const word of found) {
      const entry = counts.get(word) ?? { sentences: 0, sources: new Set(), examples: [] };
      entry.sentences += 1;
      for (const source of sources) entry.sources.add(source);
      if (entry.examples.length < EXAMPLES) entry.examples.push(id);
      counts.set(word, entry);
    }
  }
  for (const noun of rank.keys()) {
    const entry = counts.get(noun) ?? { sentences: 0, sources: new Set(), examples: [] };
    entry.sources.add('common');
    counts.set(noun, entry);
  }

  const bins = { covered: [], undrawable: [], missing: [], settings: [], unclassified: [] };
  for (const [word, entry] of counts) {
    const row = { noun: word, sentences: entry.sentences, sources: [...entry.sources].sort(), examples: entry.examples };
    if (isCovered(word)) bins.covered.push(row);
    else if (abstract.has(word)) bins.undrawable.push(row);
    else if (notNouns.has(word)) continue;
    else if (nouns.has(word)) bins.missing.push(row);
    else if (settings.has(word)) bins.settings.push(row);
    else bins.unclassified.push(row);
  }
  const order = (a, b) =>
    b.sentences - a.sentences || (rank.get(a.noun) ?? Infinity) - (rank.get(b.noun) ?? Infinity) || a.noun.localeCompare(b.noun);
  for (const list of Object.values(bins)) list.sort(order);
  return { sentences: sentences.size, ...bins };
}

/** Vstupy z repa; `dev-150` se přidá, jakmile existuje. */
export function loadInputs(root = ROOT) {
  const read = (file) => JSON.parse(readFileSync(path.join(root, file), 'utf8'));
  const sets = SETS.filter((set) => !set.optional || existsSync(path.join(root, set.file))).map((set) => ({
    name: set.name,
    sentences: sentencesOf(read(set.file)),
  }));
  return {
    sets,
    common: read('evals/play/p37d/common-nouns.json'),
    notNouns: parseNotNouns(readFileSync(path.join(root, 'ops/gen3d/not-nouns.txt'), 'utf8')),
    covered: coveredVocabulary({
      index: read('src/assets/catalog-index.json'),
      playEntries: read('src/play/assets/entries/catalog.json'),
      rigged: [read('src/assets/rigged.json'), read('src/assets/rigged-p32.json')],
    }),
  };
}

if (isMain) {
  const inputs = loadInputs();
  const result = missingNouns(inputs);
  const compact = (rows) => rows.map((row) => JSON.stringify(row));
  const out = {
    about:
      'P37D T1: nouns jurors write that the PLAY catalog cannot draw. Sentences from the sets below (the sealed test-200 is never read) plus evals/play/p37d/common-nouns.json; one bin per word, in this order: covered (catalog id, tag or hero identity, or a checklist match word), undrawable (abstract), not-nouns.txt (dropped), missing, settings (drawn by the scene), unclassified (belongs on a list, not in production). missing is ranked by sentence count, then by the common-nouns order. Written by node scripts/p37d/missing-nouns.mjs.',
    sets: Object.fromEntries(inputs.sets.map((set) => [set.name, set.sentences.length])),
    uniqueSentences: result.sentences,
    counts: Object.fromEntries(['missing', 'undrawable', 'settings', 'unclassified', 'covered'].map((bin) => [bin, result[bin].length])),
  };
  // Jeden řádek na slovo: diff dávky je pak čitelný.
  const lines = JSON.stringify(out, null, 1).replace(/\n}$/, '');
  const bins = ['missing', 'undrawable', 'settings', 'unclassified', 'covered']
    .map((bin) => `,\n "${bin}": [\n  ${compact(result[bin]).join(',\n  ')}\n ]`)
    .join('');
  writeFileSync(path.join(ROOT, 'evals/play/p37d/missing.json'), `${lines}${bins}\n}\n`);
  console.log(JSON.stringify(out.counts));
}
