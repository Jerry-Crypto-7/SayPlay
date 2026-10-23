#!/usr/bin/env node
/**
 * Tabulka prostředí → rekvizity scenérie (P45H T2).
 *
 *   node scripts/p45h/build-setting-kits.mjs      zapíše src/play/arcade/look/setting-kits.json
 *
 * Věta, která jmenuje jen prostředí („ice fishing on a frozen lake“), nové
 * rekvizity P45G nenačetla: scenérii vybírá pevná tabulka sad (`look/index.ts`).
 * Mapu prostředí → rekvizity už má `evals/play/p45g/kit-nouns.json`; tady z ní
 * zůstanou jen modely povýšené do katalogu (`gen3d-<jméno>`, bez štítku
 * `qa:unrecognisable`). Prostředí bez povýšené rekvizity v tabulce není.
 *
 * Každé prostředí nese:
 * - `pattern` – regex jako v `KEYWORDS`: slova prostředí (mezi nimi mezera
 *   nebo pomlčka, poslední i v množném čísle) a ruční synonyma (`ALIASES`);
 * - `look` – nejbližší existující sada: ta, kterou `lookFor` vybere ze slov
 *   prostředí, jinak ruční volba (`NEAREST`). Výběr sady za běhu nemění;
 * - `props` – id modelu a výška kulisy v metrech (`HEIGHTS`). Katalog má
 *   modely gen3d srovnané na výšku 1, skutečnou velikost nezná. Drobnosti
 *   (korbel, mlýnek) jsou zvětšené na ~1 m jako `cc0-clownfish` v
 *   `SCENERY_MODELS`, velké věci zmenšené, ať půdorys nepřesáhne ~4 m.
 *
 * Idempotentní: po sloučení dalšího kola modelů (P45I) stačí pustit znovu.
 * Jméno bez ruční výšky dostane výšku podle třídy a skript ho vypíše.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

// `look/index.ts` je TypeScript; holý `node` ho načte až s odstraňováním typů.
if (isMain && !process.features.typescript) {
  const run = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', fileURLToPath(import.meta.url), ...process.argv.slice(2)], { stdio: 'inherit' });
  process.exit(run.status ?? 1);
}
// Importy bez přípon a JSON doplní `ts-paths.mjs`, vitest sám.
if (!process.env.VITEST) await import('../ts-paths.mjs');
const { floraIds, lookFor, LOOKS, SCENERY_MODELS, withKit } = await import('../../src/play/arcade/look/index.ts');

export const OUT = 'src/play/arcade/look/setting-kits.json';
export const MISSING = 'evals/play/p57/kit-missing.json';
/** Vstupy v pořadí: P45G a pozdější kola; pořadí prostředí i rekvizit drží první výskyt. */
export const KIT_NOUNS = ['evals/play/p45g/kit-nouns.json', 'evals/play/p46i/kit-nouns.json', 'evals/play/p47c/kit-nouns.json'];

/** Výška kulisy v metrech podle jména z `kit-nouns.json`. */
const HEIGHTS = {
  'ice fishing hut': 2.3,
  'ice floe': 0.5,
  'toll booth': 2.4,
  'highway sign': 4.5,
  'checkout counter': 1.1,
  'shopping basket': 0.8,
  'sea anemone': 0.9,
  'candelabra': 1.4,
  'grandfather clock': 2.1,
  'chandelier': 1.2,
  'escalator': 3.5,
  'mannequin': 1.8,
  'clothing rack': 1.6,
  'tankard': 0.9,
  'tavern sign': 2.4,
  'pet carrier': 0.8,
  'bread oven': 1.8,
  'cake stand': 0.9,
  'baguette': 0.4,
  'burnt tree': 4.5,
  'charred log': 0.7,
  'burning tree': 4.5,
  'rock arch': 2.2,
  'mesa': 1.4,
  'castle gate': 3.4,
  'portcullis': 3,
  'flagpole': 6,
  'rope bridge': 2,
  'diploma': 0.9,
  'lecture podium': 1.3,
  'music stand': 1.4,
  'crooked tower': 6,
  'crooked house': 4.5,
  'dentist chair': 1.4,
  'obelisk': 5,
  'garden hose': 0.8,
  'fruit crate': 0.7,
  'vegetable basket': 0.7,
  'rocking chair': 1.2,
  'cattail': 1.6,
  'wooden hut': 3,
  'fallen log': 0.7,
  'hiking backpack': 0.9,
  'grindstone': 1.2,
  'forge furnace': 2.2,
  'funeral wreath': 1.4,
  'ice cave': 2.6,
  'mausoleum': 3.5,
  'angel statue': 2.2,
  'ice skate': 0.7,
  'planet rover': 1.6,
  'tiki torch': 1.9,
  'medical tent': 2.4,
  'jungle vine': 3,
  'mangrove tree': 4,
  'fruit bowl': 0.6,
  'pepper mill': 0.9,
  'potion bottle': 0.9,
  'dandelion': 1,
  'pillory': 2,
  'mining helmet': 0.6,
  'stone bridge': 1.4,
  'velvet rope': 1,
  'emu': 1.7,
  'medicine cabinet': 1.8,
  'playground slide': 2.2,
  'post box': 1.3,
  'parcel': 0.7,
  'wagon wheel': 1.3,
  'planter box': 0.8,
  'air conditioner': 1.2,
  // P46G T8: stavby a věci z generování vegetace; široké tak, ať půdorys nepřesáhne ~5,5 m (dům `townhouse` 7 m má 5,4 m).
  'glass office tower': 12,
  'street tree': 5,
  'apartment block': 8,
  'red phone booth': 2.6,
  'concrete planter with tree': 2.4,
  'billboard sign': 4.5,
  'parking meter': 1.4,
  'park bench': 1,
  'park fountain': 2.2,
  'street trash can': 1.1,
  'traffic cone': 0.8,
  'log cabin': 3.6,
  'wooden watchtower': 6,
  'ruined stone tower': 6,
  'castle ruin wall': 2.4,
  'wooden signpost': 1.8,
  'maple tree': 6,
  'hollow tree trunk': 1.2,
  'exposed tree root': 0.8,
  'scree rock pile': 1.4,
  'stone idol head': 2.6,
  'tribal totem pole': 3.5,
  'wooden rope bridge': 2.4,
  'vine covered rock wall': 2.6,
  'cattail reed': 1.6,
  'adobe house': 2.8,
  'bedouin tent': 3,
  'oasis well': 1.1,
  'stone obelisk': 5,
  'beach hut': 3.2,
  'lifeguard tower': 4,
  'beach umbrella': 2.4,
  'wooden pier': 0.9,
  'snowy log cabin': 3.6,
  'ski lift tower': 7,
  'frozen waterfall': 5,
  'red barn': 5,
  'white picket fence': 1.1,
  'old stone bridge': 1.6,
  'monstera plant': 1.4,
  'cherry blossom tree': 5,
  // Kulisy sad, které obecný kit prostředí (les, džungle, sníh) jinak vytlačí z lichých míst; výška jako `SCENERY_MODELS`.
  'treehouse': 6,
  'ruin': 2.5,
  'ice igloo': 2.2,
};

/** Výška jména, které v `HEIGHTS` chybí (nový model z dalšího kola). */
const CLASS_HEIGHTS = { prop: 1.2, vehicle: 2, quadruped: 1.4, biped: 1.8, flyer: 1.2, swimmer: 1 };

/** Synonyma prostředí navíc ke slovům jeho jména (regex, malá písmena). */
const ALIASES = {
  'highway': ['\\b(?:freeway|motorway|interstate)s?\\b'],
  'underwater': ['\\bunder[\\s-]+(?:the[\\s-]+)?(?:water|sea)\\b'],
  // Návrh z „escape the haunted mansion“ píše místo jen „mansion“ (P45H T4); svícen, hodiny a lustr sedí každému sídlu.
  'haunted mansion': ['\\bhaunted[\\s-]+houses?\\b', '\\bmansions?\\b'],
  'mall': ['\\bshopping[\\s-]+cent(?:er|re)s?\\b'],
  'tavern': ['\\b(?:inn|pub)s?\\b'],
  'graveyard': ['\\bcemeter(?:y|ies)\\b'],
  'dentist office': ["\\bdentist(?:'s|s)?\\b"],
  'ice rink': ['\\bskating[\\s-]+rinks?\\b', '\\bice[\\s-]+skating\\b'],
  'forge': ['\\bblacksmith(?:\'s|s)?\\b', '\\bsmithy\\b'],
  'college': ['\\buniversit(?:y|ies)\\b', '\\bcampus\\b'],
  'museum hall': ['\\bmuseums?\\b'],
  'pharmacy': ['\\bpharmacies\\b', '\\bdrugstores?\\b'],
  'farm market': ["\\bfarmers'?[\\s-]+markets?\\b"],
  // Obecné „city“ kit nemá: kit nahradí polovinu rekvizit sady a dům `townhouse` je lepší než domy z gen3d (P46G T8).
  'downtown': ['\\bskyscrapers?\\b'],
  // Slova přístavu jako `PLACE_SURFACES` v `look/index.ts`: přístav jde po prknech a má molo.
  'harbor': ['\\bharbours?\\b', '\\bdocks?\\b', '\\bpiers?\\b', '\\bboardwalks?\\b', '\\bwharf\\b', '\\bmarinas?\\b', '\\bjett(?:y|ies)\\b'],
};

/** Nejbližší sada pro prostředí, které `lookFor` nepozná (podklad, barva, počasí). */
const NEAREST = {
  'tavern': 'castle',
  'animal shelter': 'living_room',
  'burning tree': 'forest',
  'cliff': 'desert',
  'college': 'living_room',
  'concert hall': 'mall',
  'driveway': 'city',
  'fireplace': 'living_room',
  'forge': 'castle',
  'funeral': 'graveyard',
  'mountain village': 'snow',
  'museum hall': 'mall',
  'pharmacy': 'supermarket',
  'playground': 'meadow',
  'ranch': 'meadow',
  'ski resort': 'snow',
  'parking lot': 'city',
};

/**
 * P57 T9: sady světů, do kterých věty padají nejčastěji (10 nejčastějších z `evals/play/p57/usage.json`
 * a pět z auditu), z celé knihovny místo z `kit-nouns.json`. Seznam podle přednosti: jméno
 * (`gen3d-<jméno>`) nebo celé id (`cc0-…`, model ze `SCENERY_MODELS`), u nového modelu i výška
 * v metrech. Do sady jde nejvýš `P57_MAX` modelů, které katalog má, poslední soud nedal pod 6
 * (`latestScores`), vegetace sady je nekreslí sama a sada je už neukazuje vedle kitu. Co katalog
 * nemá nebo má pod 6, zapíše skript do `evals/play/p57/kit-missing.json` k dogenerování (T10).
 * „floating island“ místo „floating islands“: vzor bere jednotné i množné číslo jen od jednotného.
 */
export const P57_KITS = {
  'meadow': ['wooden fence', 'dandelion', ['haystack', 1.6], ['hay cart', 1.8], 'wooden signpost', ['log bench', 1], ['garden gnome', 0.9], ['wheelbarrow', 1], ['water pump', 1.4], ['milk can', 0.9], ['standing stone', 2.2], ['stone cairn', 1.2], ['wooden swing', 2.4], ['feeding trough', 0.8], 'white picket fence', ['mossy fallen log', 0.7], ['mossy stump', 0.8], ['wishing well', 1.8], ['weather vane', 2.5], ['gazebo', 3], ['cc0-hay-bale', 1], ['cc0-tractor', 2.4], ['scarecrow', 1.8], ['beehive', 1], ['flower cart', 1.6]],
  'castle': ['castle gate', 'portcullis', ['battlement wall', 2.6], ['castle banner', 2.4], ['tournament banner', 2.4], ['castle catapult', 2.2], ['trebuchet', 3.5], ['siege tower', 5], ['battering ram', 1.8], ['cannon tower', 3.5], ['suit of armor', 1.9], ['armor rack', 1.6], ['sword rack', 1.4], ['throne', 1.8], ['stone column', 3], ['gargoyle', 1.4], 'flagpole', ['wishing well', 1.8], ['cc0-barrel-stack', 1.4], ['hay cart', 1.8], ['market stall', 2.4], ['sword in the stone', 1.4], 'forge furnace', 'pillory', ['castle tower', 6], ['knight statue', 2.2]],
  'city': [['townhouse', 7], ['brick townhouse', 7], 'glass office tower', ['skyscraper', 12], 'red phone booth', ['street mailbox', 1.2], 'post box', ['cc0-car-sedan', 1.5], ['cc0-van', 2], ['cc0-bus', 3], ['cc0-car-police', 1.6], ['cc0-dumpster', 1.6], ['cc0-traffic-barrier', 1], 'traffic cone', ['crosswalk sign', 2.4], 'billboard sign', ['neon sign', 2], ['food truck', 2.8], ['food kiosk', 2.6], ['vending machine', 1.9], 'parking meter', ['street clock', 3.5], ['pay phone', 2], ['graffiti wall', 2.4], ['shop sign', 2.2], 'apartment block', ['newspaper stand', 1.6]],
  'jungle': ['stone idol head', 'tribal totem pole', 'wooden rope bridge', ['carved stone head', 2.4], ['tiki totem', 2.4], 'tiki torch', ['mossy ruin pillar', 2.8], ['stilt hut', 3.5], ['jungle vine bridge', 2.4], 'jungle vine', ['tribal drum', 1], ['tribal shield', 1.2], ['tiki mask', 1.2], ['golden idol', 1], ['treasure chest', 0.9], 'medical tent', ['cc0-altar-stone', 1.2], ['cc0-campfire-stones', 0.6], ['vine curtain', 3], ['camping chair', 0.9], 'hiking backpack', 'vine covered rock wall', ['jungle temple stairs', 3], 'ruin'],
  'kitchen': [['cc0-kitchencabinet', 1], ['cc0-kitchentable', 0.9], ['cc0-kitchencounter-sink', 1], ['cc0-oven', 1], ['cc0-fridge-decorated', 1.9], ['cc0-cutting-table', 1], ['cc0-counter-sink', 1], ['cc0-cooking-pot', 0.8], ['cc0-toaster', 0.7], ['cc0-chair-stool', 0.8], ['cc0-chair-wood', 1], ['microwave', 0.7], ['dishwasher', 0.9], ['espresso machine', 0.8], ['deep fryer', 1], ['griddle', 1], ['wood stove', 1.6], 'bread oven', 'cake stand', ['mortar and pestle', 0.7], 'pepper mill', ['kettle', 0.7], ['cookie jar', 0.7], ['blender', 0.8], ['teapot', 0.7], ['spice rack', 1.2], ['kitchen island', 1]],
  'park': ['street tree', 'park fountain', ['gazebo', 3], ['bandstand', 3.5], ['picnic table', 0.9], ['cc0-bench', 1], ['log bench', 1], 'playground slide', ['wooden swing', 2.4], ['seesaw', 1], ['spring rider', 1], ['merry go round', 1.4], ['carousel', 3.5], ['lamp post', 3.5], ['street lamp', 4.5], ['flower pot', 0.8], ['garden arch', 2.4], ['statue', 2.2], ['notice board', 1.8], ['trail sign', 1.8], ['food kiosk', 2.6], ['recycling bin', 1.1], 'cherry blossom tree', 'park bench', 'street trash can', ['duck pond', 0.5]],
  'village': [['timber house', 4.5], 'wooden hut', ['market stall', 2.4], ['market stall shop', 2.6], ['hay cart', 1.8], ['haystack', 1.6], ['water wheel', 3], ['wishing well', 1.8], ['forest well', 1.8], ['cc0-hay-bale', 1], ['cc0-barrel', 1], 'wagon wheel', 'wooden fence', 'white picket fence', ['notice board', 1.8], 'wooden signpost', ['outhouse', 2.2], ['doghouse', 1.2], ['cc0-workbench-anvil', 0.9], 'forge furnace', ['clock tower', 6], ['weather vane', 2.5], ['firewood basket', 0.8], ['milk can', 0.9], ['water pump', 1.4], ['cottage', 4.5], ['village church', 7], 'log cabin'],
  'beach': ['lifeguard tower', 'beach umbrella', ['beach cabana', 2.6], ['beach cooler', 0.7], ['beach flag', 2.4], ['beach bonfire', 0.8], ['sand bucket', 0.6], ['surfboard', 2], ['coconut stall', 2.4], ['driftwood log', 0.7], ['driftwood', 0.8], ['rock pool', 0.6], ['lifebuoy', 0.9], ['message in a bottle', 0.6], 'tiki torch', ['pier lamp', 3], ['wooden dock', 0.9], ['dock piling', 1.4], ['sea rock', 1.2], ['beach ball', 0.6], 'beach hut', 'wooden pier', ['ice cream cart', 1.8]],
  'dojo': [['torii gate', 4], ['stone lantern', 1.4], ['paper lantern', 0.9], ['gong', 2], ['cc0-bamboo', 3], ['bamboo cluster', 3], 'cherry blossom tree', ['sword rack', 1.4], ['armor rack', 1.6], ['standing stone', 2.2], ['stone cairn', 1.2], ['forest shrine', 2.2], ['wooden gate', 1.4], 'wooden fence', ['bullseye target', 1.4], ['teapot', 0.7], ['tribal drum', 1], ['bamboo hut', 3], ['training dummy', 1.8], ['taiko drum', 1.2], ['pagoda', 6], ['koi pond', 0.5]],
  'floating island': [['floating island', 2.5], ['cc0-cloud', 1.5], ['cc0-tree-floating', 2.5], ['airship', 3], ['blimp', 3], ['crystal cluster', 1.6], ['power crystal', 2], ['magic fountain', 2], ['orb pedestal', 1.4], ['crystal pedestal', 1.4], ['rune stone', 1.6], ['standing stone', 2.2], 'wooden rope bridge', ['plank bridge', 1], ['giant toadstool', 2], ['glowing mushroom', 1.5], ['fairy door', 1], ['gyrocopter', 2], ['cc0-tree-spiral', 3], ['cc0-tree-swirl', 3], ['weather vane', 2.5], ['sky waterfall', 4], ['floating rock', 2], ['hot air balloon', 4]],
  'frozen lake': ['ice fishing hut', 'ice floe', ['ice auger', 1], ['thin ice sign', 1.6], ['frozen signpost', 1.8], ['snowman with hat', 1.8], 'ice skate', ['hockey goal', 1.2], ['snow lantern', 1.2], ['ice lantern', 1], ['frozen log', 0.6], ['frozen barrel', 0.9], ['snowy stump', 0.7], ['snowy rock', 1], ['ice spike', 1.6], ['ice arch', 2.5], ['iceberg', 2], ['frozen fountain', 2], ['log bench', 1], ['snowy mailbox', 1.3], ['snowy lamppost', 3], ['cc0-campfire-logs', 0.6], ['firewood basket', 0.8], ['sleigh', 1.4], ['ski rack', 1.4], ['polar flag', 2.4], ['frozen pier', 0.8], ['fishing rod rack', 1.4]],
  'highway': ['toll booth', 'highway sign', ['cc0-traffic-barrier', 1], ['cc0-barrier-single', 1], ['cc0-plastic-barrier', 1], 'traffic cone', ['roadblock', 1.2], ['road sign', 2.4], ['hazard sign', 2.2], 'billboard sign', ['gas pump', 1.9], ['cc0-car-sedan', 1.5], ['cc0-car-stationwagon', 1.5], ['cc0-van', 2], ['cc0-delivery', 2.6], ['cc0-garbage-truck', 3], ['cc0-ambulance', 2.6], ['cc0-firetruck', 3], ['cc0-gas-tank', 2], ['lamp post', 3.5], ['telephone pole', 7], ['cc0-barrier-fixed', 1], ['cc0-school-bus', 3], ['guardrail', 0.9], ['highway overpass', 6], ['highway lamp', 8]],
  'supermarket': ['checkout counter', ['cc0-cabinet-shelves', 1.9], ['cc0-can-fridge', 1.9], ['deli counter', 1.2], ['deli scale', 0.8], ['display case', 1.2], ['candy display', 1.4], ['magazine rack', 1.4], ['cereal box', 0.8], ['milk carton', 0.8], ['grocery bag', 0.7], ['shopping bag', 0.6], ['cheese wheel', 0.6], ['banana bunch', 0.6], ['soda fountain', 1.4], ['vending machine', 1.9], ['turnstile', 1], ['umbrella stand', 0.9], ['berry basket', 0.6], 'shopping basket', ['egg carton', 0.6], ['ice cream freezer', 1.2], ['produce stand', 1.4]],
  'canyon': [['sandstone rock', 1.4], ['rock pillar', 4], ['standing stone', 2.2], ['stone cairn', 1.2], ['cow skull', 0.6], ['dead desert tree', 3.5], ['desert signpost', 1.8], ['desert lantern', 1.2], 'wagon wheel', ['mine cart', 1.2], ['abandoned mine entrance', 3], 'rope bridge', 'wooden rope bridge', ['cc0-campfire-stones', 0.6], ['wanted poster', 1.6], ['dinosaur skeleton', 2], ['fossil', 1], ['bone pile', 0.8], ['tnt crate', 0.9], ['ore crusher', 2.5], ['sand dune', 1.2], ['cc0-cactus-flowers', 1.2], ['saguaro cactus', 3], 'rock arch', 'mesa', ['hoodoo rock', 3], ['layered canyon rock', 2.4]],
  'desert canyon': [['cow skull', 0.6], 'bedouin tent', 'oasis well', 'adobe house', ['clay jar', 0.9], ['amphora', 1], ['sandstone rock', 1.4], ['rock pillar', 4], ['dead desert tree', 3.5], ['desert signpost', 1.8], ['desert lantern', 1.2], 'wagon wheel', ['mine cart', 1.2], ['wanted poster', 1.6], ['dinosaur skeleton', 2], ['fossil', 1], ['bone pile', 0.8], ['sand dune', 1.2], 'stone obelisk', ['cc0-cactus-flowers', 1.2], ['saguaro cactus', 3], ['joshua tree', 4], ['abandoned mine entrance', 3], ['cc0-campfire-stones', 0.6], 'rock arch', ['hoodoo rock', 3]],
};
/** Nejvýš kulis v sadě P57; víc už jen ředí řadu, kterou trať stejně nedojde. */
export const P57_MAX = 25;

/** Poslední soud modelu: výměna T8, výměna T6, přesouzení Opusem v T6, soud T4; `null` = nesouzený. */
export function latestScores({ judge, regen, top50 }) {
  return (id) => {
    if (top50.models[id]?.result === 'replaced') return top50.models[id].newScore;
    if (regen.models[id]?.result === 'replaced') return regen.models[id].newScore;
    return regen.models[id]?.oldOpus ?? judge.models[id]?.score ?? null;
  };
}

const normalize = (text) => text.trim().replace(/\s+/g, ' ');
const escape = (word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export const modelId = (noun) => `gen3d-${normalize(noun).replace(/ /g, '-')}`;

/** Slova prostředí jako regex: mezi slovy mezera nebo pomlčka, poslední slovo i v množném čísle. */
export function patternOf(setting) {
  const phrase = `\\b${setting.split(' ').map(escape).join('[\\s-]+')}(?:e?s)?\\b`;
  return [phrase, ...(ALIASES[setting] ?? [])].join('|');
}

/**
 * Tabulka z mapy jmen a katalogu. Pořadí prostředí i rekvizit drží `kit-nouns.json`
 * (podle počtu vět), takže druhý běh nad stejnými vstupy zapíše totéž. Světy z `P57_KITS`
 * přepíše sada z knihovny (`p57Kit`) na místě, nové světy přibudou na konec.
 */
export function settingKits({ kitNouns, catalog, scoreOf = () => null }) {
  const known = new Set(catalog.assets.filter((asset) => !asset.tags.includes('qa:unrecognisable')).map((asset) => asset.assetId));
  const kits = new Map();
  const guessed = [];
  const lookOf = (setting) => lookFor(setting) ?? NEAREST[setting] ?? 'meadow';
  for (const entry of kitNouns.nouns) {
    const id = modelId(entry.noun);
    if (!known.has(id)) continue;
    const height = HEIGHTS[entry.noun] ?? entry.height ?? CLASS_HEIGHTS[entry.class] ?? CLASS_HEIGHTS.prop;
    if (HEIGHTS[entry.noun] === undefined && entry.height === undefined && entry.settings.length > 0) guessed.push(entry.noun);
    for (const setting of entry.settings.map(normalize)) {
      const kit = kits.get(setting) ?? { setting, pattern: patternOf(setting), look: lookOf(setting), props: [] };
      if (!kit.props.some((prop) => prop.id === id)) kit.props.push({ id, height });
      kits.set(setting, kit);
    }
  }
  // Výška id, které už nese jiný svět: `KIT_HEIGHTS` za běhu bere poslední výskyt, cizí svět se nesmí pohnout.
  const heights = new Map([...kits.values()].flatMap((kit) => kit.props.map((prop) => [prop.id, prop.height])));
  const missing = [];
  for (const [setting, wishes] of Object.entries(P57_KITS)) {
    const look = lookOf(setting);
    const kit = p57Kit({ setting, look, wishes, known, scoreOf, heights, missing });
    kits.set(setting, { setting, pattern: patternOf(setting), look, props: kit });
  }
  return { kits: [...kits.values()], guessed, missing };
}

/**
 * Sada P57 jednoho světa podle přednosti `wishes`. Přeskočí id, které kreslí vegetace sady
 * (`landmarks` ho z řady kulis vyhodí) nebo které sada ukazuje vedle kitu sama (liché pozice
 * `withKit`). Nedostupné id zapíše do `missing` s důvodem.
 */
function p57Kit({ setting, look, wishes, known, scoreOf, heights, missing }) {
  const flora = LOOKS[look].flora === undefined ? new Set() : floraIds(LOOKS[look].flora);
  const shown = new Set(withKit(LOOKS[look].props, ['gen3d-kit']).filter((_, index) => index % 2 === 1));
  const props = [];
  for (const wish of wishes) {
    const [name, wishHeight] = typeof wish === 'string' ? [wish, undefined] : wish;
    const id = /^cc0-/.test(name) || Object.hasOwn(SCENERY_MODELS, name) ? name : modelId(name);
    const score = scoreOf(id);
    const reason = !known.has(id) ? 'not in the catalog or qa:unrecognisable' : score !== null && score < 6 ? `score ${score}` : null;
    if (reason !== null) {
      missing.push({ setting, noun: name, id, reason });
      continue;
    }
    if (flora.has(id) || shown.has(id) || props.some((prop) => prop.id === id) || props.length >= P57_MAX) continue;
    const height = heights.get(id) ?? HEIGHTS[name] ?? wishHeight;
    if (height === undefined) throw new Error(`${setting}: ${name} nemá výšku`);
    heights.set(id, height);
    props.push({ id, height });
  }
  // `sceneryPlaces` jde po seznamu s kitem (2 × délka kitu) krokem 7: násobek 7 by ukázal jen sedminu.
  return props.length % 7 === 0 ? props.slice(0, -1) : props;
}

export function render(kits) {
  const about = 'P45H T2 – setting → scenery props, written by scripts/p45h/build-setting-kits.mjs from evals/play/p45g/kit-nouns.json and src/assets/catalog.json (promoted models only). Do not edit by hand; rerun the script.';
  return `${JSON.stringify({ about, kits }, null, 2)}\n`;
}

if (isMain) {
  const read = (file) => JSON.parse(readFileSync(path.join(ROOT, file), 'utf8'));
  // P46I: další páry prostředí → rekvizita (s vlastní výškou `height`) leží v evals/play/p46i/kit-nouns.json.
  const kitNouns = { nouns: KIT_NOUNS.flatMap((file) => read(file).nouns) };
  const top50 = existsSync(path.join(ROOT, 'evals/play/p57/top50.json')) ? read('evals/play/p57/top50.json') : { models: {} };
  const scoreOf = latestScores({ judge: read('evals/play/p57/judge.json'), regen: read('evals/play/p57/regen.json'), top50 });
  const { kits, guessed, missing } = settingKits({ kitNouns, catalog: read('src/assets/catalog.json'), scoreOf });
  writeFileSync(path.join(ROOT, OUT), render(kits));
  const about = 'P57 T9: nouns the world kits (scripts/p45h/build-setting-kits.mjs, P57_KITS) asked for but the library cannot give – not in the catalog, or last judged below 6. T10 generates them or marks them skipped.';
  writeFileSync(path.join(ROOT, MISSING), `${JSON.stringify({ about, missing }, null, 1)}\n`);
  for (const setting of Object.keys(P57_KITS)) console.log(`${setting}: ${kits.find((kit) => kit.setting === setting).props.length} kulis, chybí ${missing.filter((entry) => entry.setting === setting).map((entry) => `${entry.noun} (${entry.reason})`).join(', ') || '–'}`);
  const props = new Set(kits.flatMap((kit) => kit.props.map((prop) => prop.id)));
  console.log(`${OUT}: ${kits.length} prostředí, ${props.size} modelů, ${kits.filter((kit) => kit.props.length >= 2).length} prostředí se ≥ 2 rekvizitami`);
  if (guessed.length > 0) console.log(`výška podle třídy (doplň do HEIGHTS): ${guessed.join(', ')}`);
}
