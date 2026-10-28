#!/usr/bin/env node
/**
 * P62 T1: audit, jak bohatou scénu dostane rychlá hra. Věty jen z odemčených sad: `evals/play/p30/dev.json`,
 * `evals/play/p58b/holdout.json` (otevřená v P58B) a každá sada vět `evals/play/p56c/*.json`; zapečetěné sady
 * (`p30/test-200.json`, `p61/holdout.json`, `p62/holdout.json`) se nečtou nikdy.
 *
 *   node evals/play/p62/audit.mjs      zapíše evals/play/p62/audit.json a evals/play/p62/missing-nouns.json
 *
 * Rychlá hra vzniká jako na dveřích `/api/play/games` s čtečkou jen pro AI verzi (`PLAY_READER_PATH=ai`, recept
 * P61): bez čtení věty, `readForChain` → řetěz mikroher (`buildChain`, kolo 1), jinak `draftGameSpecWithMeta`.
 * Semínko jako `seedFrom(věta)` v `_publish.ts` (první z `derivedSeeds`).
 *
 * Pro každou hru:
 * - žánr, `theme.look` (co napsal návrh) a sada, kterou scéna kreslí (`lookOf`);
 * - nepřítel, sbíraný předmět a překážka z popisků rolí a model, který pro ně scéna vybere (`enemyModel`,
 *   `chaserModel`, `heroChoice`, `propModels` / `namedProps` → `sceneModelOf`). `own` = jména modelu (identita
 *   manifestu, štítky katalogu včetně jména ze slepého soudu, holé id) nesou hlavní podstatné jméno popisku;
 *   `modifier` = nese je jen jiné slovo popisku („zombie shoppers“ → zombie); `substitute` = cokoli jiného
 *   (`kin`, `category`, `nearest`, `near-word`, `default` robot); `none` = scéna kreslí vlastní tvar jádra.
 *   Náhrada se nikdy nepočítá jako vlastní model;
 * - interiér (`INTERIOR_LOOKS`, výčet plánu P62) a co scéna kreslí jako podlahu a stěny (`SCENES`);
 * - kolik kulis leží uvnitř hrací plochy a kolik na okraji: řady `Scenery` přes `sceneryPlaces` s argumenty scény,
 *   orientační bod a rámující kusy (`landmarkPicks`; mimo hrací plochu je drží `landmark-places.ts`), prstenec arény
 *   (`arenaRingPlaces`). Drobnosti podlahy arény do 0,45 m (`arenaDecorPlaces`) jsou zvlášť – kulisa to není.
 *
 * Seznam chybějících jmen: hlavní podstatné jméno každé role, která vlastní model nemá, bez slov z
 * `ops/gen3d/not-nouns.txt`; řazení nepřítel > sbíraný předmět > kulisa (překážka), pak počet vět.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { register } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

// Aplikace je TypeScript; holý `node` ji načte až s odstraňováním typů.
if (isMain && !process.features.typescript) {
  const run = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', fileURLToPath(import.meta.url), ...process.argv.slice(2)], { stdio: 'inherit' });
  process.exit(run.status ?? 1);
}

/** `Scenery.tsx` je jediný potřebný modul s JSX: holý Node ho přeloží přes `transformWithOxc` z vite; vitest sám. */
const TSX_HOOK = `
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
let oxc;
export async function load(url, context, next) {
  if (!url.startsWith('file:') || !url.endsWith('.tsx')) return next(url, context);
  oxc ??= (await import(${JSON.stringify(pathToFileURL(path.join(ROOT, 'node_modules/vite/dist/node/index.js')).href)})).transformWithOxc;
  const file = fileURLToPath(url);
  const out = await oxc(readFileSync(file, 'utf8'), file, { lang: 'tsx', jsx: { runtime: 'automatic' } });
  return { format: 'module', source: out.code, shortCircuit: true };
}`;
if (!process.env.VITEST) {
  await import('../../../scripts/ts-paths.mjs');
  register(`data:text/javascript,${encodeURIComponent(TSX_HOOK)}`);
}

const { draftGameSpecWithMeta } = await import('../../../src/play/draft/index.ts');
const { singular } = await import('../../../src/play/draft/lexicon.ts');
const { readForChain } = await import('../../../src/play/chain/read.ts');
const { chainOrSingle } = await import('../../../src/play/chain/decide.ts');
const { buildChain } = await import('../../../src/play/chain/build.ts');
const { classifyGenre } = await import('../../../src/play/genre/classify.ts');
const { loadRapier } = await import('../../../src/play/arcade/physics/world.ts');
const { arcadeWorldOf } = await import('../../../src/play/arcade/compile.ts');
const { baseControlOf } = await import('../../../src/play/arcade/addons.ts');
const { UNIT } = await import('../../../src/play/arcade/contract.ts');
const { canonicalHash } = await import('../../../src/ir/worlddoc.ts');
const { chaserModel, enemyLabel, enemyModel, heroChoice, KIN, namedProps, PROP_ROLES, propModels, RIGGED_ALIAS, RIGGED_PREFIX, sceneModelOf } = await import('../../../src/play/arcade/models.ts');
const { landmarks, lookOf, sceneLook, sparseLandmarks } = await import('../../../src/play/arcade/look/index.ts');
const { BASE_ENTRIES } = await import('../../../src/play/assets/entries/base.ts');
const { CATALOG_ENTRIES } = await import('../../../src/play/assets/entries/catalog.ts');
const { RIGGED_P32_ENTRIES } = await import('../../../src/play/assets/entries/rigged-p32.ts');
const { RIGGED_P54_ENTRIES } = await import('../../../src/play/assets/entries/rigged-p54.ts');
const { sceneryPlaces } = await import('../../../src/components/play/arcade/look/Scenery.tsx');
const { landmarkPicks } = await import('../../../src/components/play/arcade/look/landmark-places.ts');
const { buildArenaFloor } = await import('../../../src/components/play/arcade/look/rig/terrain/arenaFloor.ts');
const { arenaDecorPlaces, arenaRingPlaces } = await import('../../../src/components/play/arcade/look/rig/terrain/arenaDecor.ts');
const { parseNotNouns } = await import('../../../scripts/p37d/missing-nouns.mjs');
const { normalizeSentence } = await import('../../../scripts/play-fidelity.mjs');

const readJson = (file) => JSON.parse(readFileSync(path.join(ROOT, file), 'utf8'));

/** Interiéry podle plánu P62 (Scope 2, T3): obchodní centrum, supermarket, obývák, továrna, hrad, jeskyně. */
export const INTERIOR_LOOKS = new Set(['mall', 'supermarket', 'living_room', 'factory', 'castle', 'cave']);

/** Podlahy, které se čtou jako podlaha uvnitř: dlažba a skála arény, dlažba a prkna cesty. */
const INDOOR_FLOORS = new Set(['arena-paving', 'arena-rock', 'road-paving', 'road-planks']);

/* ---------- Jména modelů ---------- */

const words = (text) => text.toLowerCase().replaceAll('-', ' ').match(/[a-z]+/g) ?? [];
/** Jednotné číslo jména: návrh ze slov, jen „physics“ zůstane (jako `singularOf` v `scripts/p37d/missing-nouns.mjs`). */
const nounOf = (word) => (word.endsWith('ics') ? word : singular(word));
/**
 * Tvary slova pro porovnání se jmény modelu: slovo, jednotné číslo návrhu a tvary, které zkouší `singulars`
 * v `models.ts` („horseshoes“ → „horseshoe“, „wolves“ → „wolf“) – jinak by vlastní model vypadal jako náhrada.
 */
const forms = (word) => {
  const out = new Set([word, nounOf(word)]);
  if (word.endsWith('ies')) out.add(`${word.slice(0, -3)}y`);
  if (word.endsWith('es')) out.add(word.slice(0, -2));
  if (word.endsWith('s')) out.add(word.slice(0, -1));
  if (word.endsWith('men')) out.add(`${word.slice(0, -3)}man`);
  if (word.endsWith('ves')) out.add(`${word.slice(0, -3)}f`).add(`${word.slice(0, -3)}fe`);
  return out;
};

const CATALOG_TAGS = new Map(readJson('src/assets/catalog-index.json').assets.map((asset) => [asset.assetId, asset.tags]));
const P54_TAGS = new Map(readJson('src/assets/rigged-p54.json').characters.map((character) => [character.id, character.tags]));
const IDENTITY = new Map([...BASE_ENTRIES, ...RIGGED_P32_ENTRIES, ...CATALOG_ENTRIES, ...RIGGED_P54_ENTRIES].map((entry) => [entry.id, entry.identity]));
/** Riggovaný zástupce statického modelu (`RIGGED_ALIAS`) je tentýž model: liška za lišku, robot za robota. */
const STOOD_FOR = new Map(Object.entries(RIGGED_ALIAS).map(([model, id]) => [id, model]));
const KIN_IDS = new Set(KIN.map(([id]) => `${RIGGED_PREFIX}${id}`));
const NEAREST = readJson('src/play/arcade/nearest.json').words;

/** Fráze, které model jmenují: holé id, identita manifestu, štítky postav T3 a katalogu (i `seen:` slepého soudu). */
export function namesOfModel(model) {
  const own = (id) => [
    id.replace(/^(cc0|gen3d)-/, ''),
    ...(IDENTITY.get(id) ?? []),
    ...(P54_TAGS.get(id) ?? []),
    ...(CATALOG_TAGS.get(id) ?? []).filter((tag) => tag !== 'qa:unrecognisable').map((tag) => tag.replace(/^seen:/, '')),
  ];
  const id = model.startsWith(RIGGED_PREFIX) ? model.slice(RIGGED_PREFIX.length) : model;
  const stood = STOOD_FOR.get(id);
  return new Set([...own(id), ...(stood === undefined ? [] : own(stood))].map((name) => words(name).join(' ')).filter(Boolean));
}

/**
 * Role a model, který ji kreslí. `level` je úroveň `heroChoice` (jen postavy). Hlavní podstatné jméno je poslední
 * slovo popisku v jednotném čísle; dvojslovo („space marine“) platí, když ho model nese celé. `fromSentence` =
 * jméno stojí ve větě; jinak je to výchozí popisek žánru („turbo“, „rival car“), který věta nejmenuje.
 */
export function classify(label, model, level, sentence) {
  if (label === null || label === '') return null;
  const said = words(label);
  const head = said.at(-1);
  const noun = head === undefined ? label : nounOf(head);
  const fromSentence = sentence === undefined || words(sentence).some((word) => word === head || nounOf(word) === noun);
  const row = { label, noun, fromSentence, model: model ?? null, ...(level === undefined ? {} : { level }) };
  if (model === undefined || model === null) return { ...row, match: 'none' };
  const names = namesOfModel(model);
  const before = said.at(-2);
  const headForms = [...forms(head ?? '')].flatMap((form) => (before === undefined ? [form] : [form, `${before} ${form}`]));
  if (headForms.some((form) => names.has(form))) return { ...row, match: 'own' };
  if (said.slice(0, -1).some((word) => [...forms(word)].some((form) => names.has(form)))) return { ...row, match: 'modifier' };
  const nearest = [...forms(head ?? '')].some((form) => NEAREST[form] !== undefined || (before !== undefined && NEAREST[`${before} ${form}`] !== undefined));
  const via =
    level === 'fallback' ? 'default'
    : level === 'class' ? (KIN_IDS.has(model) ? 'kin' : 'category')
    : nearest ? 'nearest'
    : 'near-word';
  return { ...row, match: 'substitute', via };
}

/* ---------- Role hry ---------- */

const OBSTACLE_ROLES = ['obstacle', 'barrier', 'spikes', 'pipe', 'hazard'];

/** Nepřítel: role `enemy` (`enemyLabel`), jinak pronásledovatel, jinak soupeř závodu či souboje. */
function foeOf(spec, sentence) {
  const enemy = enemyLabel(spec);
  if (enemy !== '') return classify(enemy, enemyModel(spec), heroChoice(enemy, undefined, spec.control, 'enemy').level, sentence);
  const chaser = spec.roles.find((role) => role.kind === 'chaser')?.label;
  if (chaser !== undefined) return classify(chaser, chaserModel(spec), heroChoice(chaser, undefined, spec.control, 'enemy').level, sentence);
  const rival = spec.roles.find((role) => role.id === 'rival' || role.id === 'glide_rival')?.label;
  return rival === undefined ? null : classify(rival, namedProps(spec).rival, heroChoice(rival, undefined, spec.control, 'enemy').level, sentence);
}

/**
 * Sbíraný předmět: role druhu `collectible` (mince, nota rytmu, díl věže, turbo) s modelem své role; žánr arény
 * sbírá roli `item` a scéna ji kreslí jako `coin` (`namedProps`).
 */
function itemOf(spec, sentence) {
  const role = spec.roles.find((candidate) => candidate.id === 'coin') ?? spec.roles.find((candidate) => candidate.kind === 'collectible');
  if (role === undefined) return null;
  const [props, named] = [propModels(spec), namedProps(spec)];
  const key = PROP_ROLES.includes(role.id) ? role.id : 'coin';
  return { ...classify(role.label, props[key] ?? named[key], undefined, sentence), role: role.id };
}

/** Překážka: první role překážky, nástrahy nebo mantinelu. */
function obstacleOf(spec, sentence) {
  const id = OBSTACLE_ROLES.find((candidate) => spec.roles.some((role) => role.id === candidate));
  if (id === undefined) return null;
  const label = spec.roles.find((role) => role.id === id).label;
  return { ...classify(label, propModels(spec)[id] ?? namedProps(spec)[id], undefined, sentence), role: id };
}

/** Slovesa kontrolního seznamu P30 (`does`, P39), kterými věta jmenuje protivníka; `collect` je předmět, `scenery` a `reach` kulisa. */
const FOE_DOES = new Set(['shoot_at', 'avoid', 'chase_me', 'fight', 'throw_at']);

/**
 * Jména, která sada u věty zapsala ručně před během: `foe` a `item` u P58B, kontrolní seznam P30 podle `does`.
 * Sada bez nich (P56C) nic nedá – tam platí jen role rychlé hry.
 */
export function annotatedNouns(source) {
  const out = { foe: [], item: [], scenery: [] };
  for (const check of source.checklist ?? []) {
    if (check.slot !== 'role' && check.slot !== 'any') continue;
    if (FOE_DOES.has(check.does)) out.foe.push(check.item);
    else if (check.does === 'collect') out.item.push(check.item);
    else if (check.does === 'scenery' || check.does === 'reach') out.scenery.push(check.item);
  }
  if (typeof source.foe === 'string') out.foe.push(source.foe);
  if (typeof source.item === 'string') out.item.push(source.item);
  return out;
}

/**
 * Co by knihovna nakreslila pro ručně zapsané jméno: protivník jako `enemyModel` (`heroChoice` role `enemy`),
 * předmět a kulisa jako rekvizita (`sceneModelOf(…, false)`, tak je čte `namedProps`).
 */
export function annotate(nouns) {
  return {
    foe: nouns.foe.map((label) => {
      const choice = heroChoice(label, undefined, undefined, 'enemy');
      return classify(label, choice.model, choice.level);
    }),
    item: nouns.item.map((label) => classify(label, sceneModelOf(label, false))),
    scenery: nouns.scenery.map((label) => classify(label, sceneModelOf(label, false))),
  };
}

/* ---------- Scéna: kulisy, podlaha, stěny ---------- */

const box = (x0, x1, z0, z1) => (x, z) => x > x0 && x < x1 && z > z0 && z < z1;
const lane = (half) => (x) => Math.abs(x) < half;

/**
 * Scéna podle ovládání (`stageOf(baseControlOf(world.control).id)`) a argumenty jejích řad `Scenery`, hrací plocha
 * (m ve scéně) a co kreslí jako podlahu. Čísla z volání v `src/components/play/arcade/**` (cesty u řádků).
 * `rotate` = skupina otočená kolem svislé osy, `dx` = posun skupiny; `framing` = `Landmark` bez `follow`.
 * simplified: střed kusu bez paty a bez zakřivení trati (`bend` posouvá řadu i dráhu stejně); stačí, dokud řady
 * stojí metry od hrany. Scénu `steer` (segmenty silnice, plavba) a mřížku audit nemodeluje – `scenery: null`.
 */
const SCENES = {
  // WorldBackdrop.tsx:97-111; hrací plocha = kužel míření ±45° do dostřelu 36 m (pieces/shooter.ts:463-464).
  shooter: () => ({ rows: [{ layout: 'sides', inner: 14, from: -4, to: 60, vegetation: true }], area: (x, z) => z > 0 && Math.abs(x) <= z && Math.hypot(x, z) <= 36, landmark: true, framing: true, floor: 'plain' }),
  // WorldBackdrop.tsx:103-111, THROW_FIELD :37.
  throw: () => ({ rows: [{ layout: 'behind', inner: 13, from: -10, to: 45, vegetation: true }], area: box(-2, 2, -3, 27), landmark: true, framing: true, floor: 'plain' }),
  // WorldBackdrop.tsx:75-91, FLAP_AREA :53.
  flap: ({ length }) => ({ rows: [{ layout: 'behind', inner: 12, from: -20, to: length + 20 }], area: lane(1.5), landmark: true, framing: false, floor: 'plain' }),
  // glide/GlideScene.tsx:70-81 (BOUND 12).
  glide: ({ length }) => ({ rows: [{ layout: 'sides', inner: 14.5, from: -10, to: length + 20, vegetation: true }], area: lane(12), landmark: true, framing: false, floor: 'plain' }),
  // walker/WalkerScene.tsx:72-88: bludiště `size` buněk po 4 m, skupina posunutá o −centre.
  walker: ({ control }) => {
    const extent = Number(control.params.size) * 4;
    const centre = (Number(control.params.size) - 1) * 2;
    return { rows: [{ layout: 'sides', inner: extent / 2 + 3, from: -4, to: extent + 4, vegetation: true, dx: -centre }], area: box(-centre - extent / 2, -centre + extent / 2, -2, extent - 2), landmark: true, framing: false, floor: 'plain' };
  },
  // ball/BallScene.tsx: bez řady kulis, PITCH_AREA :39.
  ball: () => ({ rows: [], area: box(-8, 8, -3, 22), landmark: true, framing: true, floor: 'plain' }),
  // runner/RunnerWorld.tsx:89-92 (PLAYABLE_HALF 4,5).
  runner: ({ length, look }) => ({ rows: [{ layout: 'sides', inner: 6, from: -10, to: length + 10, vegetation: true }], area: lane(4.5), landmark: true, framing: false, floor: `road-${look.surface}` }),
  // platform/PlatformWorld.tsx:90-93, SLAB_AREA :103.
  platform: ({ length, look }) => ({ rows: [{ layout: 'behind', inner: 11, from: -20, to: length + 20, vegetation: look.flora !== undefined }], area: lane(1.5), landmark: true, framing: false, floor: 'slabs' }),
  // duel/DuelScene.tsx:198-322: střed ringu midZ = 1,1 m.
  duel: () => ({ rows: [{ layout: 'behind', inner: 4, from: 1.1 - 12, to: 1.1 + 12 }], area: box(-2, 2, 1.1 - 4.5, 1.1 + 4.5), landmark: true, framing: true, floor: 'ring' }),
  // timing/TimingScene.tsx:100-106, 291-297: skupina otočená o −π/2.
  timing: () => ({ rows: [{ layout: 'behind', inner: 7, from: -14, to: 14, rotate: -Math.PI / 2 }], area: box(-5, 5, -2, 2), landmark: true, framing: true, floor: 'plain' }),
  // rhythm/RhythmScene.tsx:46-54, 164-169.
  rhythm: () => ({ rows: [{ layout: 'sides', inner: 4, from: 2, to: 60 }], area: box(-3, 3, -3, 60), landmark: true, framing: true, floor: 'lanes' }),
  move_free: (input) => arena(input),
  fight: (input) => arena(input),
  // genres/{lanes,hop,crowd,merge,push}: jen zem a kulisa za mlhou (`HorizonBackdrop`), žádná řada ani bod.
  lanes: () => ({ rows: [], area: () => false, landmark: false, framing: false, floor: 'plain' }),
  hop: () => ({ rows: [], area: () => false, landmark: false, framing: false, floor: 'plain' }),
  crowd: () => ({ rows: [], area: () => false, landmark: false, framing: false, floor: 'plain' }),
  merge: () => ({ rows: [], area: () => false, landmark: false, framing: false, floor: 'plain' }),
  push: () => ({ rows: [], area: () => false, landmark: false, framing: false, floor: 'plain' }),
};

/**
 * Aréna (arena/ArenaScene.tsx:128-131): souboj, pevná velikost hráče nebo skládání kreslí „stylovou“ arénu
 * (`ArenaFloor`: podlaha podle krytu sady, prstenec stěn, výzdoba), jinak „agar“ s holou plochou v barvě dráhy
 * (:226-229). Obě mají dvě skupiny řad otočené o 0 a π/2.
 */
function arena({ world, control, look, seed }) {
  const styled = control.id === 'fight' || control.params.size !== undefined || (world.kinds ?? []).some((kind) => kind.startsWith('thing:part_'));
  const half = Number(control.params.half) / UNIT;
  const turns = [0, Math.PI / 2];
  if (!styled) return { rows: turns.map((rotate) => ({ layout: 'sides', inner: half + 1.5, from: -half, to: half, vegetation: true, rotate })), area: box(-half, half, -half, half), landmark: true, framing: false, floor: 'plain', variant: 'agar' };
  const inner = buildArenaFloor({ look, half }).sceneryInner;
  // simplified: bez míst těl na startu (`keep` čte `drawnOf` z .tsx) – drobností je tolik, kolik by jich bylo bez děr kolem těl.
  const options = { look, half, seed, keep: [] };
  return {
    rows: turns.map((rotate) => ({ layout: 'sides', inner, from: -inner, to: inner, vegetation: true, rotate })),
    area: box(-half, half, -half, half),
    landmark: true,
    framing: false,
    floor: `arena-${look.cover}`,
    walls: true,
    variant: 'styled',
    ring: look.flora === undefined ? 0 : arenaRingPlaces(options).length,
    decorBits: arenaDecorPlaces(options).length,
  };
}

/** Kusy řad `Scenery` ve scéně: pozice po otočení a posunu skupiny, uvnitř nebo na okraji hrací plochy. */
function countRows(scene, look) {
  let inside = 0;
  let edge = 0;
  for (const row of scene.rows) {
    const props = row.vegetation === true ? landmarks(look) : look.props;
    const sparse = row.vegetation === true && sparseLandmarks(look);
    const [c, s] = [Math.cos(row.rotate ?? 0), Math.sin(row.rotate ?? 0)];
    for (const place of sceneryPlaces(props, row.layout, row.inner, row.from, row.to, undefined, sparse)) {
      const x = place.x * c + place.z * s + (row.dx ?? 0);
      const z = -place.x * s + place.z * c;
      if (scene.area(x, z)) inside += 1;
      else edge += 1;
    }
  }
  return { inside, edge };
}

/** Kulisy hry: kusy řad uvnitř a na okraji, orientační bod a rámující kusy (vždy mimo plochu), prstenec arény. */
function sceneryOf(scene, look, seed) {
  if (scene === null) return null;
  const { inside, edge } = countRows(scene, look);
  const picks = landmarkPicks(look, seed);
  const landmark = scene.landmark && picks.landmark !== null ? 1 : 0;
  const framing = scene.framing ? picks.framing.length : 0;
  const ring = scene.ring ?? 0;
  return { rows: inside + edge, inside, edge, landmark, framing, ring, edgeTotal: edge + landmark + framing + ring, ...(scene.decorBits === undefined ? {} : { decorBits: scene.decorBits }) };
}

/** Řádek auditu jedné rychlé hry; `sentence` rozliší jména z věty od výchozích popisků žánru. */
export function auditSpec(spec, { seed, sentence }) {
  const built = arcadeWorldOf(spec, seed);
  const world = built.ok ? built.world : null;
  const control = world === null ? null : baseControlOf(world.control);
  const grid = spec.control === undefined || spec.control === 'tap_go';
  const sceneId = grid ? 'grid' : (control?.id ?? spec.control);
  const look = sceneLook(spec.theme);
  const lookId = lookOf(spec.theme);
  const scene = world !== null && Object.hasOwn(SCENES, sceneId) ? SCENES[sceneId]({ world, control, look, seed, length: world.length / UNIT }) : null;
  const floor = scene?.floor ?? (sceneId === 'steer' ? `road-${look.surface}` : 'plain');
  return {
    genre: spec.genre === undefined ? null : `${spec.genre.id}.${spec.genre.mode}`,
    control: spec.control ?? null,
    scene: sceneId,
    ...(scene?.variant === undefined ? {} : { variant: scene.variant }),
    themeLook: spec.theme?.look ?? null,
    look: lookId,
    interior: INTERIOR_LOOKS.has(lookId),
    floor: { kind: floor, indoor: INDOOR_FLOORS.has(floor) },
    walls: scene?.walls === true,
    ceiling: look.ceiling !== undefined,
    foe: foeOf(spec, sentence),
    item: itemOf(spec, sentence),
    obstacle: obstacleOf(spec, sentence),
    scenery: sceneryOf(scene, look, seed),
    ...(world === null ? { compileIssues: built.issues } : {}),
  };
}

/* ---------- Souhrn a chybějící jména ---------- */

const ROLE_KEYS = [['foe', 'foe'], ['item', 'item'], ['obstacle', 'scenery']];
const TIERS = ['foe', 'item', 'scenery'];

/**
 * Počty po rolích jen pro jména z věty (vlastní / modifikátor / náhrada podle cesty / bez modelu; výchozí popisky
 * žánru zvlášť), interiéry a prázdné hrací plochy.
 */
export function summarize(rows) {
  const roles = Object.fromEntries(
    ROLE_KEYS.map(([key]) => {
      const all = rows.map((row) => row[key]).filter(Boolean);
      const named = all.filter((thing) => thing.fromSentence);
      const count = (match) => named.filter((thing) => thing.match === match).length;
      const via = {};
      for (const thing of named.filter((entry) => entry.match === 'substitute')) via[thing.via] = (via[thing.via] ?? 0) + 1;
      return [key, { named: named.length, own: count('own'), modifier: count('modifier'), substitute: count('substitute'), none: count('none'), via, genreDefault: all.length - named.length }];
    }),
  );
  const interiors = rows.filter((row) => row.interior);
  const modelled = rows.filter((row) => row.scenery !== null);
  const byScene = {};
  for (const row of modelled) {
    const entry = (byScene[row.scene] ??= { games: 0, emptyPlayArea: 0, inside: 0, edgeTotal: 0 });
    entry.games += 1;
    entry.emptyPlayArea += row.scenery.inside === 0 ? 1 : 0;
    entry.inside += row.scenery.inside;
    entry.edgeTotal += row.scenery.edgeTotal;
  }
  // Ručně zapsaná jména sady (P30, P58B): co by knihovna nakreslila, i když je rychlá hra do role nedala.
  const annotated = Object.fromEntries(
    TIERS.map((tier) => {
      const named = rows.flatMap((row) => row.annotated?.[tier] ?? []);
      const count = (match) => named.filter((thing) => thing.match === match).length;
      return [tier, { named: named.length, own: count('own'), modifier: count('modifier'), substitute: count('substitute'), none: count('none') }];
    }),
  );
  return {
    games: rows.length,
    chains: rows.filter((row) => row.chain === true).length,
    ...roles,
    annotated,
    interiors: interiors.length,
    interiorsWithoutFloor: interiors.filter((row) => !row.floor.indoor).length,
    interiorsWithoutWalls: interiors.filter((row) => !row.walls).length,
    sceneryModelled: modelled.length,
    emptyPlayArea: modelled.filter((row) => row.scenery.inside === 0).length,
    sceneryInside: modelled.reduce((sum, row) => sum + row.scenery.inside, 0),
    sceneryEdge: modelled.reduce((sum, row) => sum + row.scenery.edgeTotal, 0),
    byScene,
  };
}

/**
 * Chybějící podstatná jména: hlavní jméno role rychlé hry nebo ručně zapsaného jména sady bez vlastního modelu
 * (`modifier`, `substitute`, `none`), bez slov z `not-nouns.txt`. Jméno nese nejvyšší roli, ve které se objevilo;
 * každá věta se počítá jednou. `from` = odkud jméno přišlo (`game` role rychlé hry, `set` zápis sady).
 */
export function missingNouns(rows, notNouns) {
  const byNoun = new Map();
  for (const row of rows) {
    const things = [...ROLE_KEYS.map(([key, tier]) => [row[key], tier, 'game']), ...TIERS.flatMap((tier) => (row.annotated?.[tier] ?? []).map((thing) => [thing, tier, 'set']))];
    for (const [thing, tier, from] of things) {
      if (!thing || !thing.fromSentence || thing.match === 'own' || notNouns.has(thing.noun)) continue;
      const entry = byNoun.get(thing.noun) ?? { noun: thing.noun, tier, sentences: new Set(), from: new Set(), drawnAs: {}, examples: [] };
      if (TIERS.indexOf(tier) < TIERS.indexOf(entry.tier)) entry.tier = tier;
      entry.sentences.add(row.id);
      entry.from.add(from);
      const shown = thing.model === null ? 'none' : `${thing.match === 'substitute' ? thing.via : thing.match}:${thing.model}`;
      entry.drawnAs[shown] = (entry.drawnAs[shown] ?? 0) + 1;
      if (entry.examples.length < 3 && !entry.examples.includes(row.id)) entry.examples.push(row.id);
      byNoun.set(thing.noun, entry);
    }
  }
  return [...byNoun.values()]
    .map((entry) => ({ ...entry, sentences: entry.sentences.size, from: [...entry.from].sort() }))
    .sort((a, b) => TIERS.indexOf(a.tier) - TIERS.indexOf(b.tier) || b.sentences - a.sentences || a.noun.localeCompare(b.noun));
}

/* ---------- Běh nad sadami ---------- */

/** Sady auditu (cesty od `evals/play`): jen soubory, které jsou sadou vět (`{ sentences: [{ text }] }` nebo pole). */
export function auditSets() {
  const p56c = readdirSync(path.join(ROOT, 'evals/play/p56c')).filter((name) => name.endsWith('.json')).map((name) => `p56c/${name}`).sort();
  return ['p30/dev.json', 'p58b/holdout.json', ...p56c].filter((set) => {
    const json = readJson(`evals/play/${set}`);
    const rows = Array.isArray(json) ? json : json.sentences;
    return Array.isArray(rows) && rows.length > 0 && rows.every((row) => typeof row.text === 'string');
  });
}

/** Semínko dveří: `seedFrom(věta.trim())` z `src/app/api/play/_publish.ts:55` (modul táhne úložiště a server). */
const seedOf = (sentence) => (Number.parseInt(canonicalHash(sentence.trim()).slice(0, 8), 16) % (2 ** 31 - 1)) + 1;

/** Rychlá hra věty jako na dveřích s čtečkou jen pro AI verzi: řetěz (kolo 1), jinak návrh ze slov. */
export function quickGame(sentence) {
  const seed = seedOf(sentence);
  const read = readForChain(sentence, null);
  if (chainOrSingle(sentence, read, classifyGenre(sentence, null)) === 'chain') {
    const built = buildChain(sentence, read, seed);
    if (built.ok) return { spec: built.chain.rounds[0].spec, seed: built.chain.rounds[0].world.seed ?? seed, chain: true, rounds: built.chain.rounds.length };
  }
  return { spec: draftGameSpecWithMeta(sentence, 1, { reading: null }).spec, seed, chain: false };
}

async function main() {
  await loadRapier();
  const sets = auditSets();
  const sentences = new Map();
  for (const set of sets) {
    const json = readJson(`evals/play/${set}`);
    for (const row of Array.isArray(json) ? json : json.sentences) {
      const key = normalizeSentence(row.text);
      // Id jen v rámci sady (`d06` je v p56c i p58b): první sada, kde věta stojí, a její id.
      const seen = sentences.get(key) ?? { id: `${set.replace(/\.json$/, '')}:${row.id}`, text: row.text, sets: [], nouns: { foe: [], item: [], scenery: [] } };
      seen.sets.push(`${set}#${row.id}`);
      const nouns = annotatedNouns(row);
      for (const tier of TIERS) seen.nouns[tier] = [...new Set([...seen.nouns[tier], ...nouns[tier]])];
      sentences.set(key, seen);
    }
  }
  const rows = [...sentences.values()].map(({ id, text, sets: from, nouns }) => {
    const quick = quickGame(text);
    const annotated = TIERS.some((tier) => nouns[tier].length > 0) ? { annotated: annotate(nouns) } : {};
    return { id, sets: from, sentence: text, chain: quick.chain, ...(quick.chain ? { rounds: quick.rounds } : {}), ...auditSpec(quick.spec, { seed: quick.seed, sentence: text }), ...annotated };
  });
  const commit = execFileSync('git', ['log', '-1', '--format=%H', '--', 'src'], { cwd: ROOT, encoding: 'utf8' }).trim();
  const summary = summarize(rows);
  const oneLine = (list) => `[\n  ${list.map((item) => JSON.stringify(item)).join(',\n  ')}\n ]`;
  const audit = {
    schema: 'p62-audit.v1',
    about: 'P62 T1: how rich each quick game scene is on main, computed from the spec and the placement code, not from screenshots. Quick game = the /api/play/games door with the reader only for the AI version (P61 recipe): chain round 1 or the word draft. foe/item/obstacle: own = the model names the label head noun; modifier = only another word of the label; substitute = kin, category, nearest, near-word or default robot (never own); none = the core shape; fromSentence = false marks a genre default label the sentence never says (left out of the counts). annotated = the foe/item/scenery nouns the set wrote by hand (p30 checklist by does, p58b foe/item) looked up the way enemyModel and sceneModelOf would draw them. scenery: Scenery rows via sceneryPlaces with the scene arguments (inside = in the play area), landmark/framing/ring stand off the play area by construction; decorBits = arena floor bits up to 0.45 m, not scenery. Written by evals/play/p62/audit.mjs.',
    srcCommit: commit,
    sets: Object.fromEntries(sets.map((set) => [set, [...sentences.values()].filter((row) => row.sets.some((entry) => entry.startsWith(`${set}#`))).length])),
    uniqueSentences: rows.length,
    summary,
  };
  writeFileSync(path.join(HERE, 'audit.json'), `${JSON.stringify(audit, null, 1).replace(/\n}$/, '')},\n "rows": ${oneLine(rows)}\n}\n`);

  const notNouns = parseNotNouns(readFileSync(path.join(ROOT, 'ops/gen3d/not-nouns.txt'), 'utf8'));
  const missing = missingNouns(rows, notNouns);
  const report = {
    schema: 'p62-missing-nouns.v1',
    about: 'P62 T1: head nouns of foes, collected items and scenery (obstacles, checklist scenery) that main draws without their own model (modifier, substitute or core shape), from evals/play/p62/audit.json: the quick game roles named by the sentence (from game) and the nouns the set wrote by hand (from set). Words in ops/gen3d/not-nouns.txt are dropped. Sorted foe > item > scenery, then by sentence count. drawnAs = how main draws it today (via:model).',
    srcCommit: commit,
    counts: Object.fromEntries(TIERS.map((tier) => [tier, missing.filter((entry) => entry.tier === tier).length])),
  };
  writeFileSync(path.join(HERE, 'missing-nouns.json'), `${JSON.stringify(report, null, 1).replace(/\n}$/, '')},\n "nouns": ${oneLine(missing)}\n}\n`);
  console.log(JSON.stringify({ games: summary.games, foe: summary.foe, interiors: summary.interiors, interiorsWithoutFloor: summary.interiorsWithoutFloor, emptyPlayArea: summary.emptyPlayArea, sceneryModelled: summary.sceneryModelled, missing: report.counts }));
}

if (isMain) await main();
