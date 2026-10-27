#!/usr/bin/env node
/**
 * P63 T1: proč hra po čtení hraje jinou hru, než věta říká. Pro každou větu projde cestu čtení krok po kroku, jak ji
 * jde server: čtečka (`Reading` z `readings.astra.json`, jedno čtení astry na větu) → klasifikátor
 * (`classifyGenre(věta, čtení)`) → skladba (`draftGameSpecWithMeta(věta, 1, { reading })`, žánr hry) → překlad rolí
 * (hrdina a hlavní role věty ve specifikaci) → publikace (`readingDiffers` proti rychlé hře). Krok rozchodu je první,
 * kde hra přestane hrát sloveso věty (`EXPECT`: přípustné žánry a role, ručně podle slov věty, ne podle slovníku).
 *
 *   node evals/play/p63/diagnose.mjs [--readings evals/play/p63/readings.astra.json] [--out evals/play/p63/diagnosis.json]
 *
 * Navíc zapíše žánr rychlé hry a hry po čtení pro všech 36 vět sady čtení (`all`) – výchozí stav `main` pro regresní
 * test T2. Nic neplatí: čtení jsou uložená, skladba běží v procesu.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain && !process.features.typescript) {
  const run = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '--import', pathToFileURL(path.join(ROOT, 'scripts/ts-paths.mjs')).href, fileURLToPath(import.meta.url), ...process.argv.slice(2)], { stdio: 'inherit' });
  process.exit(run.status ?? 1);
}

/** Kroky cesty čtení v pořadí, v jakém je server jde; `none` = hra po čtení hraje větu. */
export const STEPS = ['reader', 'classifier', 'compose', 'translation', 'publish', 'none'];

/** Kde krok v kódu rozhoduje (kotva = text řádku); README k němu připíše přesnou příčinu věty. */
const ANCHORS = {
  reader: ['src/play/read/prompt.ts', "'genre: the game the sentence wants"],
  classifier: ['src/play/genre/classify.ts', 'decided = reading.sure === false'],
  compose: ['src/play/compose/compose.ts', 'const sources = ranking.flatMap'],
  translation: ['src/play/compose/compose.ts', 'const requested = assemble('],
  publish: ['src/app/api/play/_upgrade.ts', 'export function readingDiffers'],
};

/** `soubor:řádek` kotvy kroku; `null` u `none` nebo když kotva z kódu zmizela. */
export function locate(step, root = ROOT) {
  const anchor = ANCHORS[step];
  if (anchor === undefined) return null;
  const lines = readFileSync(path.join(root, anchor[0]), 'utf8').split('\n');
  const index = lines.findIndex((line) => line.includes(anchor[1]));
  return index < 0 ? null : `${anchor[0]}:${index + 1}`;
}

/**
 * Co věta chce, ručně podle jejích slov (P61 README, T8 „Verdikt“). `genres`: žánr (`runner` = každý režim) nebo
 * `žánr.režim`, který hraje sloveso věty; `hero` a `roles`: hlavní slovo, které musí nést hrdina a některá role hry.
 */
export const EXPECT = {
  h02: { genres: ['arena.fight', 'duel.default'], hero: 'pirate', roles: ['monster'] },
  h11: { genres: ['arena.collect', 'arena.escape', 'quest.spatial'], hero: 'witch', roles: ['mushroom'] },
  h14: { genres: ['runner', 'voyage.race'], hero: 'skier', roles: ['tree'] },
  h15: { genres: ['quest.spatial', 'platformer.default'], hero: 'firefighter', roles: ['flame'] },
  h18: { genres: ['arena.fight', 'duel.default'], hero: 'knight', roles: ['dragon'] },
  h19: { genres: ['timing.stack'], hero: null, roles: ['pancake'] },
  h23: { genres: ['catch.default', 'timing.precision'], hero: 'seal', roles: ['ball'] },
  h24: { genres: ['flap.default', 'voyage.race'], hero: 'balloon', roles: ['cloud'] },
  s002: { genres: ['arena.escape', 'arena.collect', 'quest.spatial'], hero: 'knight', roles: ['key', 'ghost'] },
  s006: { genres: ['runner', 'platformer.default'], hero: 'corgi', roles: ['sausage'] },
};

/** `žánr.režim` hraje některý z přípustných žánrů (`runner` = každý režim běžce). */
export function admissible(genre, genres) {
  if (genre === null) return false;
  return genres.some((allowed) => (allowed.includes('.') ? genre === allowed : genre.split('.')[0] === allowed));
}

const genreKey = (genre) => (genre == null ? null : `${genre.genre ?? genre.id}.${genre.mode}`);

/** Hrdina a role hry: popisky rolí specifikace, hrdina = role `player`. */
export function castOf(spec) {
  const roles = spec.roles.map((role) => ({ kind: role.kind, label: role.label.toLowerCase() }));
  return { hero: roles.find((role) => role.kind === 'player')?.label ?? null, roles: roles.filter((role) => role.kind !== 'player').map((role) => `${role.kind}:${role.label}`) };
}

/** Nese hra hrdinu a všechny hlavní role věty? Shoda hlavního slova v popisku (`dragon` v „red dragon“). */
export function namesCast(cast, expect) {
  const heroOk = expect.hero === null || (cast.hero ?? '').includes(expect.hero);
  return heroOk && expect.roles.every((noun) => cast.roles.some((role) => role.includes(noun)));
}

/**
 * Krok, kde se hra po čtení rozešla s větou: první z `STEPS`, jehož výsledek nehraje sloveso věty (žánr mimo
 * `expect.genres`) nebo ztratí hrdinu či hlavní roli. `publish` = hra po čtení by větu hrála, ale nevznikne (neliší se
 * od rychlé hry) a rychlá hra větu nehraje.
 */
export function divergeStep({ expect, readGenre, classified, readingGame, quickGame, published }) {
  if (!admissible(readGenre, expect.genres)) return 'reader';
  if (!admissible(classified, expect.genres)) return 'classifier';
  if (!admissible(readingGame.genre, expect.genres)) return 'compose';
  if (!namesCast(readingGame.cast, expect)) return 'translation';
  if (!published && !(admissible(quickGame.genre, expect.genres) && namesCast(quickGame.cast, expect))) return 'publish';
  return 'none';
}

/** Moduly aplikace, které diagnóza volá; test je dosadí přímo, skript je načte za zavaděčem `ts-paths`. */
export async function loadDeps() {
  const [{ draftGameSpecWithMeta }, { classifyGenre }, { readForChain }, { chainOrSingle }, { readingDiffers }, { loadRapier }] = await Promise.all([
    import('../../../src/play/draft/index.ts'),
    import('../../../src/play/genre/classify.ts'),
    import('../../../src/play/chain/read.ts'),
    import('../../../src/play/chain/decide.ts'),
    import('../../../src/app/api/play/_upgrade.ts'),
    import('../../../src/play/arcade/physics/world.ts'),
  ]);
  // Server čeká na fyziku před každým návrhem (route i práce řetězu); bez ní se míčová hra nepřeloží.
  await loadRapier();
  return { draftGameSpecWithMeta, classifyGenre, readForChain, chainOrSingle, readingDiffers };
}

/**
 * Hra návrhu: žánr, který hraje (`spec.genre`, a když ho sestavený recept nenese – „assembled.drive“ –, žánr skladby
 * `meta.genre`), buňka skladby, hrdina, role a svět.
 */
function gameOf(meta) {
  const { spec } = meta;
  return { genre: genreKey(spec.genre ?? meta.genre), specGenre: genreKey(spec.genre), cell: meta.composition?.cellId ?? null, cast: castOf(spec), look: spec.theme.look ?? spec.theme.setting ?? null };
}

/**
 * Rychlá hra a hra po čtení věty jako na serveru (`route.ts`, `_upgrade.ts`): rychlá ze slov – řetěz podle
 * `chain/read.ts`, jinak návrh –, po čtení návrh ze čtení.
 */
export function gamesOf(sentence, reading, deps) {
  const quickMeta = deps.draftGameSpecWithMeta(sentence, 1, { reading: null });
  const chain = deps.chainOrSingle(sentence, deps.readForChain(sentence, null), deps.classifyGenre(sentence, null)) === 'chain';
  const quickGame = { ...gameOf(quickMeta), ...(chain ? { genre: 'chain' } : {}), chain };
  if (reading === null) return { quickGame, readingGame: null, published: false };
  const readMeta = deps.draftGameSpecWithMeta(sentence, 1, { reading });
  const readSpec = readMeta.spec;
  const quickSpec = quickMeta.spec;
  const readingGame = { ...gameOf(readMeta), goal: readSpec.tutorial?.goalLine ?? null, objective: readSpec.objective ?? null };
  // Řetěz hru po čtení publikuje vždy (P58F), jedna hra jen když se od rychlé liší (`readingDiffers`, P61 T2).
  return { quickGame, readingGame, published: chain || deps.readingDiffers(quickSpec, readSpec) };
}

/** Celá diagnóza věty: čtení, klasifikátor, obě hry, krok rozchodu a místo v kódu. */
export function diagnoseSentence(row, reading, expect, deps) {
  const ranking = deps.classifyGenre(row.text, reading);
  const [first] = ranking.ranked;
  const { quickGame, readingGame, published } = gamesOf(row.text, reading, deps);
  const readGenre = genreKey(reading.genre);
  const classified = first === undefined ? null : `${first.genre}.${first.mode}`;
  const step = divergeStep({ expect, readGenre, classified, readingGame, quickGame, published });
  return {
    id: row.id,
    sentence: row.text,
    expect,
    reading: { genre: readGenre, sure: reading.sure, control: reading.control, verbs: reading.verbs.map((verb) => `${verb.word}:${verb.class}`), hero: reading.hero, foe: reading.foe, item: reading.item, world: reading.world, roles: reading.roles.map((role) => `${role.kind}:${role.noun}${role.count === null ? '' : `×${role.count}`}`) },
    classified: { first: classified, why: first?.why ?? null, decided: ranking.decided },
    quickGame,
    readingGame,
    published,
    step,
    location: locate(step),
  };
}

async function main() {
  const args = process.argv.slice(2);
  const flag = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
  const readingsFile = path.resolve(ROOT, flag('--readings', 'evals/play/p63/readings.astra.json'));
  const out = path.resolve(ROOT, flag('--out', 'evals/play/p63/diagnosis.json'));
  const readings = JSON.parse(readFileSync(readingsFile, 'utf8'));
  const set = JSON.parse(readFileSync(path.join(HERE, 'read-set.json'), 'utf8')).sentences;
  const readingOf = (id) => readings.rows.find((row) => row.id === id)?.models['astra@openai']?.reading ?? null;
  const deps = await loadDeps();
  const sentences = Object.entries(EXPECT).map(([id, expect]) => diagnoseSentence(set.find((row) => row.id === id), readingOf(id), expect, deps));
  const all = set.map((row) => {
    const reading = readingOf(row.id);
    const { quickGame, readingGame, published } = gamesOf(row.text, reading, deps);
    return { id: row.id, readGenre: genreKey(reading?.genre), quick: quickGame.genre, quickCell: quickGame.cell, reading: readingGame?.genre ?? null, readingCell: readingGame?.cell ?? null, published };
  });
  const record = {
    schema: 'p63-diagnosis.v1',
    readings: path.relative(ROOT, readingsFile).replaceAll('\\', '/'),
    promptVersion: readings.promptVersion,
    steps: STEPS,
    sentences,
    byStep: Object.fromEntries(STEPS.map((step) => [step, sentences.filter((row) => row.step === step).map((row) => row.id)])),
    all,
  };
  writeFileSync(out, `${JSON.stringify(record, null, 1)}\n`);
  console.log(JSON.stringify({ out: path.relative(ROOT, out), byStep: record.byStep }));
}

if (isMain) await main();
