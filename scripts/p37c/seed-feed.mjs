#!/usr/bin/env node
/**
 * Seed feedu (P37C T6): ze startovních vět (`src/components/play/starters.ts`)
 * a vývojových vět (`evals/play/p30/dev.json`, **ne** zapečetěná sada) postaví
 * hry stejnou cestou jako `POST /api/play/games` – návrh ze slov, kompilace
 * na semínkách dveří, zpráva o kvalitě –, nechá projít jen ty, které robot
 * vyhraje, nečinný hráč prohraje a jejichž náhled robota se hýbe, a seřadí je
 * podle hloubky, prokládané po žánrech.
 *
 * Vestavěný feed (`--builtin`, P70C T4) staví z vět `FEED_SENTENCES`: dvě na každý hratelný žánr registru.
 * Jen rychlá cesta (návrh ze slov, `draftGameSpecWithMeta`) – žádný režisér ani placený model, běh nic nestojí.
 *
 *   node --experimental-strip-types scripts/p37c/seed-feed.mjs              jen spočítá a vypíše
 *   node --experimental-strip-types scripts/p37c/seed-feed.mjs --builtin    obnoví náhledy zmrazené sady (builtin-games.json), přepíše hry feedu (builtin-feed-games.json) a výběr starých her ve feedu (builtin-feed-old.json); chybí-li žánru hra, skončí kódem 1
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

const { decodePreview, previewOf } = await import('../../src/play/version/preview.ts');
const { runBot } = await import('../../src/play/arcade/verify.ts');
const { instantiate, loadProgram, step } = await import('../../src/play/arcade/kernel.ts');
const { BODY, BODY_STRIDE, FLAG, HEADER, HEADER_SIZE, NO_INPUT, RUN_STATE } = await import('../../src/play/arcade/contract.ts');
const { releasePhysics } = await import('../../src/play/arcade/physics/step.ts');
const { GENRES, GENRE_MODES } = await import('../../src/play/genre/contract.ts');
const { GENRE_MODULES } = await import('../../src/play/genre/modules.ts');
const { ROUTE_PENDING } = await import('../../src/play/genre/classify.ts');
const { feedKindOf, MAX_PER_GENRE } = await import('../../src/play/version/diversify.ts');

const ROOT = new URL('../../', import.meta.url);
/**
 * Zmrazená sada P37C (30 her `arcade-v2`): ids a světy se nemění – zamyká je `legacy-replay-v2`
 * a odkazy na ně už kolují. `--builtin` jí jen obnoví náhled robota (P54A T2).
 */
export const BUILTIN_PATH = new URL('src/play/version/builtin-games.json', ROOT);
/** Hry feedu z dnešního jádra (P54A, od P70C T4 dvě na každý hratelný žánr): `--builtin` je celé přepíše. */
export const BUILTIN_FEED_PATH = new URL('src/play/version/builtin-feed-games.json', ROOT);

/** Ids starých her „choď a sbírej“ ze zmrazené sady, které feed ještě ukáže (P70C T4, `oldWalkInFeed`). */
export const BUILTIN_OLD_PATH = new URL('src/play/version/builtin-feed-old.json', ROOT);

/** Kolik her na žánr vestavěný feed má (P70C T4). */
export const PER_GENRE = 2;

/** Kolik starých her „choď a sbírej“ feed ještě ukáže (P70C T4: nejvýš čtyři). */
export const OLD_WALK_IN_FEED = 4;

/**
 * Věty vestavěného feedu (P70C T4, majitel 4. 11.: „feed tam je jen jeden druh her“): `PER_GENRE` na každý hratelný
 * žánr, krátké, aby se vešly na kartu, a s věcí, kterou je na první pohled vidět. `genre` je žánr, kam větu dá rychlá
 * cesta (`draftGameSpecWithMeta(věta).genre?.genre`) – věta, která přistane jinde, `--builtin` neprojde.
 *
 * Pořadí je pořadí feedu bez čítačů (`seedGames` prokládá po druzích): první věta každého žánru, pak druhá. Třetí
 * karta je souboj s joystickem a první souboj leží do deváté karty – na to se ptají e2e `play-feed-phone`
 * (třetí kartu hraje prstem joystickem) a `p64-thumb` (hledá ovládání `fight` v prvních devíti kartách).
 */
export const FEED_SENTENCES = [
  { genre: 'rhythm', sentence: 'A frog drums to the beat on lily pads' },
  { genre: 'minigolf', sentence: 'Mini golf on a pirate ship deck' },
  { genre: 'arena', sentence: 'A kitten fights a gang of pigeons on a rooftop' },
  { genre: 'railfps', sentence: 'Ride a mine cart and blast zombie bats' },
  { genre: 'catch', sentence: 'Catch falling donuts, dodge the bombs' },
  { genre: 'buildshift', sentence: 'Run a pizza shop and serve 12 customers' },
  { genre: 'runner', sentence: 'A raccoon runs down a subway track' },
  { genre: 'drawsave', sentence: 'Draw walls to save a puppy from bees' },
  { genre: 'hole', sentence: 'A hole swallows a whole city' },
  { genre: 'duel', sentence: 'A knight duels a dragon on a bridge' },
  { genre: 'slice', sentence: 'A ninja slices flying watermelons' },
  { genre: 'voyage', sentence: 'A paper plane flies between skyscrapers' },
  { genre: 'steal', sentence: 'A fox steals eggs and carries them back to its den' },
  { genre: 'platformer', sentence: 'A frog jumps across floating clouds' },
  { genre: 'merge', sentence: 'Drop and merge fruits into a giant watermelon' },
  { genre: 'shooter', sentence: 'A space marine shoots alien bugs on Mars' },
  { genre: 'hop', sentence: 'A chicken crosses a busy road' },
  { genre: 'quest', sentence: 'A fox explores a maze to find the golden key' },
  { genre: 'survivor', sentence: 'Survive waves of zombies in a graveyard' },
  { genre: 'whack', sentence: 'Whack the moles in a carrot field' },
  { genre: 'timing', sentence: 'Stack pancakes as high as you can' },
  { genre: 'crowd', sentence: 'Lead a crowd of penguins through the gates' },
  { genre: 'throw', sentence: 'Throw snowballs at penguins on an ice rink' },
  { genre: 'sort', sentence: 'Sort the colored balls into tubes' },
  { genre: 'defense', sentence: 'Defend the castle lanes from marching goblins' },
  { genre: 'push', sentence: 'Sumo wrestlers push each other out of the ring' },
  { genre: 'arrows', sentence: 'Tap the boats so they sail out of the jammed harbor' },
  { genre: 'flap', sentence: 'A tiny bird flaps through a pipe forest' },
  { genre: 'rhythm', sentence: 'A DJ cat taps to the beat at a disco' },
  { genre: 'minigolf', sentence: 'Mini golf through a haunted castle' },
  { genre: 'arena', sentence: 'A puppy collects bones in a sunny park' },
  { genre: 'railfps', sentence: 'Ride a roller coaster and shoot the ghosts' },
  { genre: 'catch', sentence: 'A bear catches falling apples in an orchard' },
  { genre: 'buildshift', sentence: 'Run a coffee shop and serve the morning rush' },
  { genre: 'runner', sentence: 'A corgi sprints through a candy factory' },
  { genre: 'drawsave', sentence: 'Draw a shield to save the chick from the rain' },
  { genre: 'hole', sentence: 'A black hole eats a farm and grows' },
  { genre: 'duel', sentence: 'Two samurai duel in a cherry blossom garden' },
  { genre: 'slice', sentence: 'A chef slices flying vegetables in a kitchen' },
  { genre: 'voyage', sentence: 'Race a speedboat through a jungle river' },
  { genre: 'steal', sentence: 'A pirate steals gold and carries it back to his ship' },
  { genre: 'platformer', sentence: 'A robot jumps between rooftops at sunset' },
  { genre: 'merge', sentence: 'Combine two gems into a bigger gem' },
  { genre: 'shooter', sentence: 'Blast zombie robots in a neon mall' },
  { genre: 'hop', sentence: 'A frog hops across a busy highway' },
  { genre: 'quest', sentence: 'Pop the balloons at the fair' },
  { genre: 'survivor', sentence: 'A wizard survives endless waves of bats' },
  { genre: 'whack', sentence: 'Bonk the robots popping out of the floor' },
  { genre: 'timing', sentence: 'Stack sushi into a wobbly tower' },
  { genre: 'crowd', sentence: 'Grow an army of ducks through the gates' },
  { genre: 'throw', sentence: 'A wizard throws fireballs at castle towers' },
  { genre: 'sort', sentence: 'Sort the laundry into the right baskets' },
  { genre: 'defense', sentence: 'Defend the bakery from waves of ants' },
  { genre: 'push', sentence: 'Push the rival robots off the platform' },
  { genre: 'arrows', sentence: 'Unjam the traffic jam in a parking lot' },
  { genre: 'flap', sentence: 'A bee flaps its wings through a flower garden' },
];

/**
 * Hratelné žánry registru: aspoň jeden režim, který není kostra (`staged`), a žánr mimo bránu aktivace
 * (`ROUTE_PENDING`) – jen ty klasifikátor rychlé cesty vůbec vybere.
 */
export function playableGenres() {
  return GENRES.filter((genre) => !ROUTE_PENDING.has(genre) && GENRE_MODES[genre].some((mode) => GENRE_MODULES[genre].availability(mode) !== 'staged'));
}

/** Pohyb pod centimetr (jednotky jádra jsou milimetry) je chvění, ne pohyb. */
const MOVE_UNITS = 10;

/**
 * Kolik těl se v okně náhledu robota (P54A T2) pohne o víc než centimetr, vznikne nebo zanikne (P70C T4).
 * Nula = karta feedu by hrála stojící obraz.
 */
export function previewMotion(world, preview) {
  const { startTick, endTick, inputs } = decodePreview(preview);
  const program = loadProgram(world, ARCADE_LIBRARY);
  const state = instantiate(world);
  let start = state.slice();
  let next = 0;
  for (let tick = 0; tick < endTick - 1 && state[HEADER.runState] === RUN_STATE.running; tick += 1) {
    if (tick === startTick) start = state.slice();
    while (next < inputs.length && inputs[next].tick < tick) next += 1;
    const event = inputs[next];
    step(state, event !== undefined && event.tick === tick ? event : NO_INPUT, program);
  }
  releasePhysics(state);
  let moved = 0;
  for (let body = 0; body < Math.max(start[HEADER.bodyCount], state[HEADER.bodyCount]); body += 1) {
    const at = HEADER_SIZE + body * BODY_STRIDE;
    const shift = Math.hypot(state[at + BODY.x] - start[at + BODY.x], state[at + BODY.y] - start[at + BODY.y], state[at + BODY.z] - start[at + BODY.z]);
    if (shift > MOVE_UNITS || ((state[at + BODY.flags] ^ start[at + BODY.flags]) & FLAG.alive) !== 0) moved += 1;
  }
  return moved;
}

/**
 * Staré hry „choď a sbírej“, které zůstanou ve feedu (P70C T4): volný pohyb ze zmrazené sady (soubor jde od
 * nejhlubší), náhled robota se hýbe – staré úkoly s přepínači (Astronaut Quest, Chef Quest…) v náhledu stojí –
 * a nejvýš `MAX_PER_GENRE` z jednoho žánru, ať i konec feedu drží rozmanitost.
 */
export function oldWalkInFeed(frozen) {
  const perKind = new Map();
  const out = [];
  for (const game of frozen) {
    if (out.length === OLD_WALK_IN_FEED) break;
    const kind = feedKindOf(game.spec);
    if (game.spec.control !== 'move_free' || (perKind.get(kind) ?? 0) >= MAX_PER_GENRE || previewMotion(game.arcade, game.preview) === 0) continue;
    perKind.set(kind, (perKind.get(kind) ?? 0) + 1);
    out.push(game);
  }
  return out;
}

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

/**
 * Hra z věty jako z dveří, nebo důvod, proč neprošla. `genre` (věty feedu, P70C T4) = žánr, kam věta musí přistat
 * na rychlé cestě. Nečinný hráč musí prohrát – přísněji než brána G2 (nečinný nevyhraje).
 */
export async function buildGame(sentence, createdAt, genre) {
  // Rapier před návrhem: skládání ze slov krokuje i fyzikální sestavy (jinak „No playable assembly … needs loadRapier()“).
  await loadRapier();
  const meta = draftGameSpecWithMeta(sentence, 1);
  if (genre !== undefined && meta.genre?.genre !== genre) return { ok: false, why: `the quick path plays ${meta.genre?.genre ?? 'no genre'}, not ${genre}` };
  const spec = meta.spec;
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
  if (game.preview === null || previewMotion(game.arcade, game.preview) === 0) return { ok: false, why: 'nothing moves in the bot preview' };
  return { ok: true, game };
}

const titleKey = (title) => title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/**
 * Ověřené hry bez opakovaného titulku (feed ho stejně schová), prokládané po druzích feedu (`feedKindOf`,
 * P70C T4 – dřív po archetypech): první hra každého žánru, pak druhá… – jinak by začátek feedu byl jeden žánr.
 * Uvnitř kola podle hloubky; s `genres` (věty feedu: věta → žánr, kam musí přistát) v pořadí vět, které napsal
 * provozovatel. `createdAt` klesá od `epoch` v tomhle pořadí, takže feed bez čítačů jde přesně jím.
 */
export async function seedGames(sentences, epoch, genres = new Map()) {
  const passed = [];
  const failed = [];
  for (const sentence of sentences) {
    const built = await buildGame(sentence, epoch, genres.get(sentence));
    if (built.ok) passed.push(built.game);
    else failed.push({ sentence, why: built.why });
  }
  const scored = passed.map((game) => ({ game, depth: depthOf(game) }));
  const base = genres.size > 0 ? scored : scored.sort((a, b) => b.depth - a.depth || (a.game.version.title < b.game.version.title ? -1 : 1));
  const seen = new Set();
  const perKind = new Map();
  const ranked = [];
  for (const { game, depth } of base) {
    const key = titleKey(game.version.title);
    if (seen.has(key)) continue;
    seen.add(key);
    const kind = feedKindOf(game.spec);
    const turn = perKind.get(kind) ?? 0;
    perKind.set(kind, turn + 1);
    ranked.push({ game, depth, turn });
  }
  // Stabilní řazení: uvnitř kola zůstává pořadí `base`.
  ranked.sort((a, b) => a.turn - b.turn);
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

/** Hratelné žánry, kterým vestavěný feed nedává `PER_GENRE` her, s počtem, který má (P70C T4). */
export function feedGaps(games) {
  const genreOf = new Map(FEED_SENTENCES.map((entry) => [entry.sentence, entry.genre]));
  const count = new Map();
  for (const game of games) count.set(genreOf.get(game.origin.sentence), (count.get(genreOf.get(game.origin.sentence)) ?? 0) + 1);
  return playableGenres().flatMap((genre) => ((count.get(genre) ?? 0) < PER_GENRE ? [{ genre, games: count.get(genre) ?? 0 }] : []));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const builtin = process.argv.includes('--builtin');
  // Vestavěný feed (P70C T4) staví věty feedu po žánrech; seed úložiště dál startovní a vývojové věty.
  const sentences = builtin ? FEED_SENTENCES.map((entry) => entry.sentence) : seedSentences();
  const genres = builtin ? new Map(FEED_SENTENCES.map((entry) => [entry.sentence, entry.genre])) : new Map();
  const { games, failed } = await seedGames(sentences, builtin ? BUILTIN_EPOCH : Date.now(), genres);
  console.log(`${String(games.length)} verified games from ${String(sentences.length)} sentences (${String(failed.length)} did not pass)`);
  for (const { sentence, why } of failed) console.log(`  - ${sentence}: ${why}`);
  let gaps = [];
  if (builtin) {
    const frozen = JSON.parse(readFileSync(BUILTIN_PATH, 'utf8')).map((game) => ({ ...game, preview: previewOf(game.arcade, runBot(game.arcade)) }));
    writeFileSync(BUILTIN_PATH, builtinFile(frozen));
    const taken = new Set(frozen.map((game) => titleKey(game.version.title)));
    const fresh = games.filter((game) => !taken.has(titleKey(game.version.title)));
    writeFileSync(BUILTIN_FEED_PATH, builtinFile(fresh));
    const old = oldWalkInFeed(frozen);
    writeFileSync(BUILTIN_OLD_PATH, `${JSON.stringify(old.map((game) => game.version.versionId), null, 2)}\n`);
    console.log(`builtin set: ${String(frozen.length)} frozen games with previews + ${String(fresh.length)} feed games -> src/play/version/builtin-feed-games.json`);
    console.log(`old walk-and-collect games still in the feed: ${old.map((game) => game.version.title).join(', ')} -> src/play/version/builtin-feed-old.json`);
    gaps = feedGaps(fresh);
    for (const { genre, games: have } of gaps) console.log(`  ! ${genre}: ${String(have)} of ${String(PER_GENRE)} games`);
  }
  const outcomes = await writeSeed(games, process.env);
  console.log(outcomes === null ? 'store: nothing written (set PLAY_SEED_STORE_PREFIX to write)' : `store ${process.env.PLAY_SEED_STORE_PREFIX}: ${JSON.stringify(outcomes)}`);
  process.exit(gaps.length === 0 ? 0 : 1);
}
