#!/usr/bin/env node
/**
 * Třída těla a pohyblivé díly každého modelu katalogu (P45D T2).
 *
 *   node scripts/p45d/motion-class.mjs      zapíše src/assets/catalog-motion.json
 *
 * Hračkový pohyb (`src/play/arcade/toy-motion.ts`) hýbe tělem podle toho, čím
 * model je: pes cupitá, pták mává, ryba se vlní, auto pruží. Třídu dává:
 *
 * 1. manifest hrdinů P32 (`src/play/assets/entries/catalog.json`) – jeho třídy
 *    už určila slova tagů a id (`scripts/assets/p32-manifest.mjs`), i s výjimkami
 *    pro kulisy, které slovo třídy jen nesou (past na medvěda, hot dog);
 * 2. jinak `heroClass` (`src/play/genre/roles.ts`) nad jednoslovným id („knight“) –
 *    štítky a popisek jmenují obsah („akvárium s rybou“), ne tělo, a víceslovné
 *    id mimo manifest je kulisa („hot-dog“, „fish-tank“);
 * 3. jinak poměr `bounds`: výška > 1,3 × max(šířka, hloubka) → biped, jinak prop.
 *
 * Model s dveřmi nebo víkem je vždy prop (mechanismus, ne tělo). Malý seznam
 * výjimek přepíše zvíře a příšeru podle slov id: ryby a hadi plavou, hmyz,
 * netopýr a drak létají. Letadla a rakety jsou flyer bez křídel (nemávají).
 *
 * `parts` = pojmenované díly s pivotem z katalogu a pojmenované uzly GLB
 * s rolí podle jména (dveře a víko u každé třídy, křídla, kola, nohy, ocas,
 * vrtule a ploutve jen u těl, která se hýbou); pivot uzlu je jeho poloha ve
 * světě modelu. `regions` = prahy oblastí pro deformaci vrcholů v jednotkách
 * modelu (`src/components/play/arcade/look/toy-deform.ts`):
 * - `wingX` – křídla od |x − midX| > 0,3 šířky (flyer s křídly),
 * - `tailZ` – ocas za z < střed − 0,25 hloubky (quadruped, swimmer),
 * - `legY` – nohy pod y < spodek + 0,25 výšky (biped, quadruped, flyer).
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

// `roles.ts` je TypeScript; holý `node` ho načte až s odstraňováním typů.
if (isMain && !process.features.typescript) {
  const run = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', fileURLToPath(import.meta.url), ...process.argv.slice(2)], { stdio: 'inherit' });
  process.exit(run.status ?? 1);
}
// Importy bez přípon (`../arcade/look`) doplní `ts-paths.mjs`, vitest sám.
if (!process.env.VITEST) await import('../ts-paths.mjs');
const { heroClass } = await import('../../src/play/genre/roles.ts');

export const OUT = 'src/assets/catalog-motion.json';

/** Třída modelu (`ModelClass`) → třída těla. */
const BODY_OF_CLASS = {
  bird: 'flyer',
  aircraft: 'flyer',
  boat: 'vehicle',
  vehicle: 'vehicle',
  humanoid: 'biped',
  robot: 'biped',
  monster: 'biped',
  animal: 'quadruped',
};

/** Zvířata a příšery, které plavou; složeniny na „-fish“ se počítají jako „fish“. */
export const SWIMMERS = new Set(['fish', 'shark', 'whale', 'orca', 'octopus', 'squid', 'eel', 'snake', 'dolphin', 'narwhal', 'ray', 'seahorse', 'piranha', 'puffer', 'koi', 'betta', 'tetra', 'tuna', 'turbot', 'snapper', 'tang', 'humphead', 'worm']);
/** Zvířata a příšery, které létají. */
export const FLYERS = new Set(['bat', 'bee', 'wasp', 'butterfly', 'dragon', 'dragonfly', 'firefly', 'housefly', 'mosquito', 'griffin', 'flying']);
/**
 * Třída těla, kterou slovo id určí lépe než manifest (robotický vysavač nemá nohy), a tvorové, které
 * `heroClass` nezná – chybějící jména kola generování (T16) a jejich budoucí modely (T19).
 */
const BODY_OF_WORD = {
  roomba: 'vehicle',
  snowmobile: 'vehicle',
  snowplow: 'vehicle',
  ...Object.fromEntries(['mole', 'hippo', 'lizard', 'rhino', 'centaur'].map((word) => [word, 'quadruped'])),
  ...Object.fromEntries(['cyclops', 'golem', 'genie', 'robber', 'spy', 'poacher', 'stickman', 'manager', 'advisor'].map((word) => [word, 'biped'])),
  peacock: 'flyer',
  trout: 'swimmer',
};

/** Role dílu podle hlavního (posledního) slova jeho jména. */
const ROLE_WORDS = {
  door: ['door', 'doors', 'sash', 'gate'],
  lid: ['lid', 'hatch'],
  wing: ['wing', 'wings'],
  wheel: ['wheel', 'wheels', 'tire', 'tyre'],
  leg: ['leg', 'legs', 'foot', 'feet', 'paw', 'paws'],
  tail: ['tail'],
  propeller: ['propeller', 'rotor'],
  fin: ['fin', 'fins', 'flipper'],
};
const ROLE_OF_WORD = new Map(Object.entries(ROLE_WORDS).flatMap(([role, words]) => words.map((word) => [word, role])));
/** Křídlo dveří jmenuje jen díl katalogu; uzel GLB „leaf“ je list rostliny. */
const CATALOG_ROLE_OF_WORD = new Map([...ROLE_OF_WORD, ['leaf', 'door']]);
/** Role, které se hýbou u každé třídy; ostatní jen u těl, která chodí, létají, plavou nebo jezdí. */
const MECHANISM_ROLES = new Set(['door', 'lid']);
/** Hýbou se nejvýš dva díly na tělo (rozpočet sítí, T6); víc nemá smysl nést. */
const MAX_PARTS = 4;

const round = (value) => {
  const rounded = Math.round(value * 1000) / 1000;
  return rounded === 0 ? 0 : rounded;
};

/** Otisk katalogu: id a hash každého modelu. Konce řádků ani pořadí klíčů na něj nemají vliv. */
export function catalogHash(catalog) {
  const lines = catalog.assets.map((asset) => `${asset.assetId}@${asset.hash}`).sort();
  return createHash('sha256').update(lines.join('\n')).digest('hex');
}

/**
 * Role dílu podle hlavního slova jména („desk-leg“ → noha, „door-step“ → nic);
 * `catalog` = jméno dílu z katalogu, kde „leaf“ znamená křídlo dveří. `null` = nehýbe se.
 */
export function roleOf(name, catalog = false) {
  const head = name.toLowerCase().split(/[^a-z]+/).filter(Boolean).at(-1);
  return (head === undefined ? undefined : (catalog ? CATALOG_ROLE_OF_WORD : ROLE_OF_WORD).get(head)) ?? null;
}

const idWords = (assetId) => assetId.replace(/^(?:cc0|gen3d)-/, '').split('-');

/** Plave nebo létá podle slov jména (výjimky zvířat a příšer); `null` = nic z toho. */
const exceptionOf = (words) => {
  if (words.some((word) => SWIMMERS.has(word.replace(/^.+fish$/, 'fish')))) return 'swimmer';
  if (words.some((word) => FLYERS.has(word))) return 'flyer';
  return null;
};

/** Třída těla podstatného jména bez modelu (P45D T16, šablona zadání generátoru); `null` = slova třídu neznají. */
export function bodyOfNoun(noun) {
  const words = noun.toLowerCase().split(/[\s-]+/);
  const byWord = words.map((word) => BODY_OF_WORD[word]).find((body) => body !== undefined);
  if (byWord !== undefined) return byWord;
  const kind = heroClass(noun);
  if (kind === null || kind === 'animal' || kind === 'monster') {
    const exception = exceptionOf(words);
    if (exception !== null) return exception;
  }
  return kind === null ? null : BODY_OF_CLASS[kind] ?? null;
}

/** Třída těla modelu (viz hlavička souboru). */
export function bodyClassOf(asset, manifestClass, hasMechanism) {
  if (hasMechanism) return 'prop';
  const words = idWords(asset.assetId);
  const byWord = words.map((word) => BODY_OF_WORD[word]).find((body) => body !== undefined);
  if (byWord !== undefined) return byWord;
  // Víceslovné id mimo manifest je kulisa, kterou P32 vyřadil („hot-dog“, „fish-tank“).
  const kind = manifestClass ?? (words.length === 1 ? heroClass(words[0]) : null);
  if (kind === 'animal' || kind === 'monster') {
    const exception = exceptionOf(words);
    if (exception !== null) return exception;
  }
  if (kind !== null && kind !== undefined && BODY_OF_CLASS[kind] !== undefined) return BODY_OF_CLASS[kind];
  const [width, height, depth] = asset.bounds.max.map((max, axis) => max - asset.bounds.min[axis]);
  return height > 1.3 * Math.max(width, depth) ? 'biped' : 'prop';
}

/** Prahy oblastí deformace v jednotkách modelu; `undefined` = tělo se nedeformuje. */
export function regionsOf(bounds, body, flaps) {
  const [width, height, depth] = bounds.max.map((max, axis) => max - bounds.min[axis]);
  const regions = {};
  if (body === 'flyer' && flaps) {
    regions.midX = round((bounds.min[0] + bounds.max[0]) / 2);
    regions.wingX = round(0.3 * width);
  }
  if (body === 'quadruped' || body === 'swimmer') regions.tailZ = round((bounds.min[2] + bounds.max[2]) / 2 - 0.25 * depth);
  if (body === 'biped' || body === 'quadruped' || (body === 'flyer' && flaps)) regions.legY = round(bounds.min[1] + 0.25 * height);
  return Object.keys(regions).length === 0 ? undefined : regions;
}

/** Pojmenované uzly GLB a jejich poloha ve světě modelu – jen JSON a matice, žádné načítání do three. */
export async function glbNodes(file) {
  const { NodeIO } = await import('@gltf-transform/core');
  const doc = await new NodeIO().read(file);
  return doc.getRoot().listNodes().map((node) => ({ name: node.getName(), pivot: node.getWorldTranslation().map(round) }));
}

/** Díly s rolí: pojmenované díly katalogu, pak uzly GLB; `moves` = tělo, které se hýbe (ne prop). */
export function partsOf(asset, nodes, moves) {
  const parts = [];
  const seen = new Set();
  const add = (part) => {
    if (seen.has(part.node) || parts.length >= MAX_PARTS) return;
    if (!moves && !MECHANISM_ROLES.has(part.role)) return;
    seen.add(part.node);
    parts.push(part);
  };
  for (const part of asset.parts ?? []) {
    if (/^part-\d+$/.test(part.id)) continue;
    const role = roleOf(part.id, true) ?? roleOf(part.node, true);
    if (role !== null) add({ id: part.id, node: part.node, role, pivot: part.pivot });
  }
  // Pojmenované díly katalogu mají přednost; podřízené uzly dveří („door-post“) by je zdvojily.
  if (parts.length > 0) return parts;
  for (const node of nodes) {
    // Kořen modelu se jmenuje jako model („exit-door“) – to je celé tělo, ne díl.
    const role = node.name === '' || node.name === asset.assetId ? null : roleOf(node.name);
    if (role !== null) add({ id: node.name, node: node.name, role, pivot: node.pivot });
  }
  return parts;
}

/** Celý obsah `catalog-motion.json`; `nodesOf(asset)` vrátí pojmenované uzly GLB modelu. */
export async function motionCatalog({ catalog, manifest, nodesOf }) {
  const classOf = new Map(manifest.entries.map((entry) => [entry.id, entry.class]));
  const models = {};
  for (const asset of catalog.assets) {
    const nodes = await nodesOf(asset);
    const mechanism = partsOf(asset, nodes, false).length > 0;
    const body = bodyClassOf(asset, classOf.get(asset.assetId), mechanism);
    const flaps = body === 'flyer' && classOf.get(asset.assetId) !== 'aircraft' && heroClass(idWords(asset.assetId).at(-1)) !== 'aircraft';
    const parts = partsOf(asset, nodes, body !== 'prop');
    const regions = regionsOf(asset.bounds, body, flaps);
    models[asset.assetId] = { class: body, ...(parts.length > 0 ? { parts } : {}), ...(regions !== undefined ? { regions } : {}) };
  }
  return { version: 1, catalogHash: catalogHash(catalog), models };
}

/** Jeden řádek na model: diff po povýšení dávky je čitelný. */
export function render(result) {
  const lines = Object.entries(result.models).map(([id, entry]) => `  ${JSON.stringify(id)}: ${JSON.stringify(entry)}`);
  return `{\n "version": ${result.version},\n "catalogHash": ${JSON.stringify(result.catalogHash)},\n "models": {\n${lines.join(',\n')}\n }\n}\n`;
}

if (isMain) {
  const read = (file) => JSON.parse(readFileSync(path.join(ROOT, file), 'utf8'));
  const catalog = read('src/assets/catalog.json');
  const result = await motionCatalog({
    catalog,
    manifest: read('src/play/assets/entries/catalog.json'),
    nodesOf: (asset) => glbNodes(path.join(ROOT, 'public', asset.lods[0].path)),
  });
  writeFileSync(path.join(ROOT, OUT), render(result));
  const counts = {};
  for (const entry of Object.values(result.models)) counts[entry.class] = (counts[entry.class] ?? 0) + 1;
  const withParts = Object.values(result.models).filter((entry) => entry.parts !== undefined).length;
  console.log(JSON.stringify({ models: Object.keys(result.models).length, ...counts, withParts }));
}
