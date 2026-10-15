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
import { readFileSync, writeFileSync } from 'node:fs';
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
const { lookFor } = await import('../../src/play/arcade/look/index.ts');

export const OUT = 'src/play/arcade/look/setting-kits.json';
/** Vstupy v pořadí: P45G a pozdější kola; pořadí prostředí i rekvizit drží první výskyt. */
export const KIT_NOUNS = ['evals/play/p45g/kit-nouns.json', 'evals/play/p46i/kit-nouns.json'];

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
 * (podle počtu vět), takže druhý běh nad stejnými vstupy zapíše totéž.
 */
export function settingKits({ kitNouns, catalog }) {
  const known = new Set(catalog.assets.filter((asset) => !asset.tags.includes('qa:unrecognisable')).map((asset) => asset.assetId));
  const kits = new Map();
  const guessed = [];
  for (const entry of kitNouns.nouns) {
    const id = modelId(entry.noun);
    if (!known.has(id)) continue;
    const height = HEIGHTS[entry.noun] ?? entry.height ?? CLASS_HEIGHTS[entry.class] ?? CLASS_HEIGHTS.prop;
    if (HEIGHTS[entry.noun] === undefined && entry.height === undefined && entry.settings.length > 0) guessed.push(entry.noun);
    for (const setting of entry.settings.map(normalize)) {
      const kit = kits.get(setting) ?? { setting, pattern: patternOf(setting), look: lookFor(setting) ?? NEAREST[setting] ?? 'meadow', props: [] };
      if (!kit.props.some((prop) => prop.id === id)) kit.props.push({ id, height });
      kits.set(setting, kit);
    }
  }
  return { kits: [...kits.values()], guessed };
}

export function render(kits) {
  const about = 'P45H T2 – setting → scenery props, written by scripts/p45h/build-setting-kits.mjs from evals/play/p45g/kit-nouns.json and src/assets/catalog.json (promoted models only). Do not edit by hand; rerun the script.';
  return `${JSON.stringify({ about, kits }, null, 2)}\n`;
}

if (isMain) {
  const read = (file) => JSON.parse(readFileSync(path.join(ROOT, file), 'utf8'));
  // P46I: další páry prostředí → rekvizita (s vlastní výškou `height`) leží v evals/play/p46i/kit-nouns.json.
  const kitNouns = { nouns: KIT_NOUNS.flatMap((file) => read(file).nouns) };
  const { kits, guessed } = settingKits({ kitNouns, catalog: read('src/assets/catalog.json') });
  writeFileSync(path.join(ROOT, OUT), render(kits));
  const props = new Set(kits.flatMap((kit) => kit.props.map((prop) => prop.id)));
  console.log(`${OUT}: ${kits.length} prostředí, ${props.size} modelů, ${kits.filter((kit) => kit.props.length >= 2).length} prostředí se ≥ 2 rekvizitami`);
  if (guessed.length > 0) console.log(`výška podle třídy (doplň do HEIGHTS): ${guessed.join(', ')}`);
}
