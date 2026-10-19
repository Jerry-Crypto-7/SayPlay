#!/usr/bin/env node
/**
 * Seed feedu (P37C T6): ze startovních vět (`src/components/play/starters.ts`)
 * a vývojových vět (`evals/play/p30/dev.json`, **ne** zapečetěná sada) postaví
 * hry stejnou cestou jako `POST /api/play/games` – návrh ze slov, kompilace
 * na semínkách dveří, zpráva o kvalitě –, nechá projít jen ty, které robot
 * vyhraje a nečinný hráč prohraje, a seřadí je podle hloubky.
 *
 *   node --experimental-strip-types scripts/p37c/seed-feed.mjs              jen spočítá a vypíše
 *   node --experimental-strip-types scripts/p37c/seed-feed.mjs --builtin    obnoví náhledy zmrazené sady (builtin-games.json) a přepíše hry feedu (builtin-feed-games.json)
 *   PLAY_SEED_STORE_PREFIX=<předpona> KV_REST_API_URL=… KV_REST_API_TOKEN=… node --experimental-strip-types scripts/p37c/seed-feed.mjs
 *
 * **Do úložiště píše jen s `PLAY_SEED_STORE_PREFIX`** – samotné `KV_REST_API_*`
 * v prostředí nestačí, aby stažené produkční proměnné nezapsaly nic omylem.
 * Předpona se píše výslovně (jako u `play-extend-ttl.mjs`): produkční je
 * `WORLDSMITH_SPEND_STORE_PREFIX` z Vercelu, bez něj `worldsmith:spend`.
 * Zápis do produkce je krok P30A. Hry jdou do feedu přes `feature` (žádné
 * dveře) a započítají se do denního stropu publikací; opakovaný běh je `exists`.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// `ts-paths.mjs` (cesty `@/`, přípony, JSON), vitest sám.
if (!process.env.VITEST) await import('../ts-paths.mjs');
const { canonicalHash } = await import('@/ir/worlddoc');
const { draftGameSpecWithMeta } = await import('../../src/play/draft/index.ts');
const { loadRapier } = await import('../../src/play/arcade/physics/world.ts');
const { replay } = await import('../../src/play/arcade/kernel.ts');
const { ARCADE_LIBRARY } = await import('../../src/play/arcade/library.ts');
const { ARCADE_HZ } = await import('../../src/play/arcade/contract.ts');
const { getCompiler } = await import('../../src/app/api/play/_compiler.ts');
const { previewFor, reportFor } = await import('../../src/app/api/play/_report.ts');
const { IDEAS, STARTERS } = await import('../../src/components/play/starters.ts');
const { VERSION_STORE_TIMEOUT_MS, httpVersionStore, sealVersion, writeLimitsFromEnv } = await import('../../src/play/version/index.ts');

const { previewOf } = await import('../../src/play/version/preview.ts');
const { runBot } = await import('../../src/play/arcade/verify.ts');

const ROOT = new URL('../../', import.meta.url);
/**
 * Zmrazená sada P37C (30 her `arcade-v2`): ids a světy se nemění – zamyká je `legacy-replay-v2`
 * a odkazy na ně už kolují. `--builtin` jí jen obnoví náhled robota (P54A T2).
 */
export const BUILTIN_PATH = new URL('src/play/version/builtin-games.json', ROOT);
/** Hry feedu P54A z dnešního jádra: doplní zmrazenou sadu do `BUILTIN_COUNT`. */
export const BUILTIN_FEED_PATH = new URL('src/play/version/builtin-feed-games.json', ROOT);

/** Kolik her má vestavěný pool celkem (P54A T3: aspoň 40 z aspoň 6 žánrů). */
export const BUILTIN_COUNT = 40;

/** Vestavěná sada má pevné časy, aby soubor byl deterministický; nejhlubší je nejnovější. */
const BUILTIN_EPOCH = Date.parse('2026-10-19T00:00:00.000Z');

/**
 * Semínka jako u dveří (`derivedSeeds` v `src/app/api/play/_publish.ts`), jen
 * z věty se solí `feed`: hra ze seedu tak má jiné id než hra, kterou z téže
 * startovní věty publikuje návštěvník – jeho `POST` je dál `201` a jeho hra má
 * vlastní rodokmen. Vítězné semínko jde do `origin.seed`, takže `POST`
 * s větou a tím semínkem postaví přesně tuhle hru.
 */
const MAX_SEED = 2 ** 31 - 1;
const seedOf = (value) => (Number.parseInt(canonicalHash(value).slice(0, 8), 16) % MAX_SEED) + 1;
export function feedSeeds(sentence) {
  const base = seedOf({ feed: sentence.trim() });
  return [base, ...[1, 2, 3].map((attempt) => seedOf({ base, attempt }))];
}
const SEED_DEPENDENT = new Set(['UNWINNABLE', 'LAYOUT_FAILED']);

/**
 * Věty seedu, každá jednou: startovní karty, nápady, zbytek startovních vět
 * balíčku (`golden_prompts.csv`, odkud karty pocházejí) a vývojová sada.
 */
export function seedSentences() {
  const golden = readFileSync(new URL('docs/play/pack/golden_prompts.csv', ROOT), 'utf8').trim().split(/\r?\n/).slice(1).map((line) => line.split(',').slice(1, -1).join(','));
  const dev = JSON.parse(readFileSync(new URL('evals/play/p30/dev.json', ROOT), 'utf8')).sentences.map((sentence) => sentence.text);
  return [...new Set([...STARTERS.map((starter) => starter.sentence), ...IDEAS.map((idea) => idea.sentence), ...golden, ...dev])];
}

/**
 * Hloubka hry (P36A): víc mechanik, životy, cílové skóre a délka robotova
 * vítězství v pásmu 30–90 s. Jen klíč řazení, ne hodnocení.
 */
export function depthOf(game) {
  const ids = new Set(game.spec.mechanics.map((mechanic) => mechanic.id));
  const seconds = (game.report.witness.winsAtTick ?? 0) / ARCADE_HZ;
  return ids.size + (ids.has('health') ? 1 : 0) + ((game.spec.scoring?.target ?? 0) > 0 ? 1 : 0) + (seconds >= 30 && seconds <= 90 ? 2 : 0);
}

/** Hra z věty jako z dveří, nebo důvod, proč neprošla. */
export async function buildGame(sentence, createdAt) {
  // Rapier před návrhem: skládání ze slov krokuje i fyzikální sestavy (jinak „No playable assembly … needs loadRapier()“).
  await loadRapier();
  const spec = draftGameSpecWithMeta(sentence, 1).spec;
  const compile = getCompiler();
  const seeds = feedSeeds(sentence);
  let compiled = compile(spec, seeds[0]);
  for (const seed of seeds.slice(1)) {
    if (compiled.ok || !SEED_DEPENDENT.has(compiled.reason)) break;
    compiled = compile(spec, seed);
  }
  if (!compiled.ok) return { ok: false, why: compiled.reason };
  if (compiled.value.arcade === undefined) return { ok: false, why: 'not an arcade game' };
  const report = reportFor(compiled.value);
  if (!report.publishEligible || !report.witness.certified) return { ok: false, why: 'the robot did not win or a check failed' };
  if (replay(compiled.value.arcade, [], ARCADE_LIBRARY).outcome !== 'lost') return { ok: false, why: 'a player who does nothing does not lose' };
  const game = {
    version: sealVersion(compiled.value, null, () => createdAt),
    spec,
    blueprint: compiled.value.blueprint,
    arcade: compiled.value.arcade,
    report,
    origin: { sentence, seed: compiled.value.seed },
    // Náhled robota pro feed (P54A T2) z téhož běhu, který `reportFor` právě pustil – jako u dveří.
    preview: previewFor(compiled.value),
  };
  return { ok: true, game };
}

const titleKey = (title) => title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/**
 * Ověřené hry bez opakovaného titulku (feed ho stejně schová), seřazené podle
 * hloubky a prokládané po archetypech: nejhlubší hra každého archetypu, pak
 * druhá nejhlubší… – jinak by začátek feedu byl jeden žánr. `createdAt` klesá
 * od `epoch` v tomhle pořadí, takže feed bez čítačů začne nejhlubšími.
 */
export async function seedGames(sentences, epoch) {
  const passed = [];
  const failed = [];
  for (const sentence of sentences) {
    const built = await buildGame(sentence, epoch);
    if (built.ok) passed.push(built.game);
    else failed.push({ sentence, why: built.why });
  }
  const byDepth = passed.map((game) => ({ game, depth: depthOf(game) })).sort((a, b) => b.depth - a.depth || (a.game.version.title < b.game.version.title ? -1 : 1));
  const seen = new Set();
  const perArchetype = new Map();
  const ranked = [];
  for (const { game, depth } of byDepth) {
    const key = titleKey(game.version.title);
    if (seen.has(key)) continue;
    seen.add(key);
    const turn = perArchetype.get(game.spec.archetype) ?? 0;
    perArchetype.set(game.spec.archetype, turn + 1);
    ranked.push({ game, depth, turn });
  }
  ranked.sort((a, b) => a.turn - b.turn || b.depth - a.depth || (a.game.version.title < b.game.version.title ? -1 : 1));
  const games = ranked.map(({ game }, index) => ({ ...game, version: { ...game.version, createdAt: new Date(epoch - index * 60_000).toISOString() } }));
  return { games, failed };
}

/**
 * Zápis do úložiště zadaného `PLAY_SEED_STORE_PREFIX`; bez něj `null` a nic se
 * nezapíše. Od nejmělčí, aby nejhlubší ležela navrchu seznamu feedu.
 */
export async function writeSeed(games, env, makeStore = (config) => httpVersionStore(config)) {
  const prefix = env.PLAY_SEED_STORE_PREFIX?.trim() ?? '';
  if (prefix === '') return null;
  const url = env.WORLDSMITH_SPEND_STORE_URL || env.KV_REST_API_URL;
  const token = env.WORLDSMITH_SPEND_STORE_TOKEN || env.KV_REST_API_TOKEN;
  if (!url || !token) throw new Error('PLAY_SEED_STORE_PREFIX is set, but KV_REST_API_URL and KV_REST_API_TOKEN are missing');
  const store = makeStore({ url, token, prefix, timeoutMs: VERSION_STORE_TIMEOUT_MS, limits: writeLimitsFromEnv(env) });
  const outcomes = { stored: 0, exists: 0, conflict: 0, quota: 0 };
  for (const game of [...games].reverse()) outcomes[await store.feature(game)] += 1;
  return outcomes;
}

/** Vestavěná sada: jedna hra na řádek, ať diff ukáže, která se změnila. */
export function builtinFile(games) {
  return `[\n${games.map((game) => JSON.stringify(game)).join(',\n')}\n]\n`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const sentences = seedSentences();
  const builtin = process.argv.includes('--builtin');
  const { games, failed } = await seedGames(sentences, builtin ? BUILTIN_EPOCH : Date.now());
  console.log(`${String(games.length)} verified games from ${String(sentences.length)} sentences (${String(failed.length)} did not pass)`);
  for (const { sentence, why } of failed) console.log(`  - ${sentence}: ${why}`);
  if (builtin) {
    const frozen = JSON.parse(readFileSync(BUILTIN_PATH, 'utf8')).map((game) => ({ ...game, preview: previewOf(game.arcade, runBot(game.arcade)) }));
    writeFileSync(BUILTIN_PATH, builtinFile(frozen));
    const taken = new Set(frozen.map((game) => titleKey(game.version.title)));
    const fresh = games.filter((game) => !taken.has(titleKey(game.version.title))).slice(0, BUILTIN_COUNT - frozen.length);
    writeFileSync(BUILTIN_FEED_PATH, builtinFile(fresh));
    console.log(`builtin set: ${String(frozen.length)} frozen games with previews + ${String(fresh.length)} new -> src/play/version/builtin-feed-games.json`);
  }
  const outcomes = await writeSeed(games, process.env);
  console.log(outcomes === null ? 'store: nothing written (set PLAY_SEED_STORE_PREFIX to write)' : `store ${process.env.PLAY_SEED_STORE_PREFIX}: ${JSON.stringify(outcomes)}`);
  process.exit(0);
}
