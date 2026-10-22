#!/usr/bin/env node
/**
 * Záznamy manifestu hrdinů z katalogu (P32C T1).
 *
 * Z `src/assets/catalog-index.json` vybere každý model, který může hrát
 * hrdinu nebo nepřítele – zvíře, pták, robot, vozidlo, loď, letadlo nebo
 * raketa, postava, příšera – a zapíše ho do `src/play/assets/entries/catalog.json` (typy: `catalog.ts`)
 * s třídou, identitou (tagy), rozměry z `bounds`, osou z `p32-forward.json`
 * a licencí z `disclosure.json`. Katalog nenese žádný rig (29. 9. 2026: 0 ze
 * 783 GLB má klip), proto jsou všechny klipy `procedural`.
 *
 * Třídu určí slova tagů a id. U dvojslova rozhoduje pořadí `CLASS_ORDER`:
 * „pirate ship“ je loď, ne pirát, „car police“ auto, „robot dog“ robot.
 * Kulisy, které slovo třídy nesou (past na medvěda, klobouk čaroděje), vyřadí
 * `CLASS_OF_MODEL`.
 *
 *   node scripts/assets/p32-manifest.mjs
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
/** Data jdou do JSON, `catalog.ts` je jen otypuje: brána licencí čte cesty v kódu jako jména modelů AI (`cc0-llama-lod1.glb`). */
const OUT = join(ROOT, 'src', 'play', 'assets', 'entries', 'catalog.json');

/** Pořadí, ve kterém slovo třídy vyhrává nad jiným ve stejném názvu. */
const CLASS_ORDER = ['boat', 'aircraft', 'vehicle', 'robot', 'monster', 'bird', 'animal', 'humanoid'];

const WORDS = {
  boat: ['boat', 'ship', 'rowboat', 'sailboat', 'motorboat', 'yacht', 'submarine', 'canoe', 'kayak', 'raft', 'ferry', 'galleon', 'vessel', 'ark'],
  aircraft: ['plane', 'airplane', 'aeroplane', 'aircraft', 'biplane', 'jet', 'helicopter', 'rocket', 'spaceship', 'starship', 'ufo', 'drone', 'quadcopter', 'balloon', 'lander'],
  vehicle: ['car', 'racecar', 'kart', 'truck', 'firetruck', 'bus', 'bike', 'bicycle', 'motorbike', 'motorcycle', 'scooter', 'skateboard', 'tank', 'train', 'tram', 'tractor', 'taxi', 'van', 'jeep', 'buggy', 'ambulance', 'sedan', 'hatchback', 'stationwagon', 'bulldozer', 'sled', 'cart', 'trolley'],
  robot: ['robot', 'android', 'droid', 'mech', 'cyborg', 'bot', 'automaton', 'roomba', 'robodog'],
  monster: ['monster', 'ghost', 'spirit', 'phantom', 'zombie', 'dragon', 'alien', 'skeleton', 'goblin', 'orc', 'troll', 'ogre', 'vampire', 'werewolf', 'mummy', 'yeti', 'slime', 'blob', 'imp', 'griffin', 'demon', 'enemy'],
  bird: ['bird', 'penguin', 'eagle', 'parrot', 'duck', 'owl', 'chicken', 'hen', 'crow', 'raven', 'pigeon', 'seagull', 'hawk', 'flamingo', 'swan', 'goose', 'toucan', 'songbird', 'phoenix'],
  animal: [
    'animal', 'cat', 'kitten', 'dog', 'puppy', 'hound', 'corgi', 'pug', 'fox', 'bear', 'rabbit', 'bunny', 'pig', 'hog', 'cow', 'horse', 'donkey', 'mouse', 'hamster', 'rodent', 'rat',
    'monkey', 'gorilla', 'lion', 'tiger', 'wolf', 'deer', 'doe', 'frog', 'fish', 'turtle', 'tortoise', 'snake', 'serpent', 'kangaroo', 'raccoon', 'seal', 'walrus', 'elephant', 'giraffe',
    'zebra', 'llama', 'sheep', 'goat', 'camel', 'panda', 'koala', 'sloth', 'otter', 'skunk', 'hedgehog', 'beaver', 'crocodile', 'alligator', 'chameleon', 'axolotl', 'unicorn',
    'shark', 'whale', 'dolphin', 'octopus', 'squid', 'crab', 'lobster', 'seahorse', 'jellyfish', 'narwhal', 'stingray', 'pufferfish', 'blowfish', 'anglerfish', 'betta', 'blobfish',
    'clownfish', 'cowfish', 'flatfish', 'goldfish', 'humphead', 'koi', 'lionfish', 'piranha', 'puffer', 'snapper', 'sunfish', 'swordfish', 'tang', 'tetra', 'tuna', 'turbot',
    'bee', 'wasp', 'butterfly', 'ladybug', 'spider', 'scorpion', 'ant', 'mosquito', 'fly', 'housefly', 'dragonfly', 'beetle', 'caterpillar', 'worm', 'snail', 'bat',
    'dinosaur', 'dino', 'trex', 'triceratops', 'velociraptor', 'apatosaurus', 'parasaurolophus',
  ],
  humanoid: [
    'man', 'woman', 'boy', 'girl', 'kid', 'child', 'person', 'human', 'hero', 'heroine', 'chef', 'firefighter', 'pirate', 'captain', 'knight', 'wizard', 'witch', 'mage', 'princess',
    'prince', 'king', 'queen', 'ninja', 'astronaut', 'spaceman', 'cosmonaut', 'explorer', 'adventurer', 'hiker', 'waiter', 'waitress', 'butler', 'cop', 'policeman', 'officer', 'police',
    'soldier', 'guard', 'warrior', 'paladin', 'cowboy', 'dwarf', 'dwarve', 'elf', 'fairy', 'mermaid', 'archer', 'viking', 'samurai', 'superhero', 'villain', 'doctor', 'nurse', 'farmer',
    'detective', 'thief', 'clown', 'baby', 'student', 'teacher', 'scientist', 'magician', 'wrestler', 'fighter', 'goalkeeper', 'goalie', 'grandma', 'granny', 'grandmother',
    'grandpa', 'mom', 'mother', 'sister', 'customer', 'shopper', 'dancer', 'drummer', 'rider', 'biker', 'survivor', 'gangster', 'thug', 'operator', 'fishmonger', 'employee', 'doll',
  ],
};

/**
 * Třída modelu, kterou slova neurčí správně; `null` = hrdinou není. Příšery
 * Quaternius a postavičky Kenney mají vlastní jména, auta Kenney jméno druhu
 * („police“, „race“), kulisy nesou slovo třídy jen jako přívlastek.
 */
const CLASS_OF_MODEL = {
  'cc0-alpaking': 'monster',
  'cc0-alpaking-evolved': 'monster',
  'cc0-armabee': 'monster',
  'cc0-armabee-evolved': 'monster',
  'cc0-glub': 'monster',
  'cc0-glub-evolved': 'monster',
  'cc0-goleling': 'monster',
  'cc0-goleling-evolved': 'monster',
  'cc0-hywirl': 'monster',
  'cc0-mushnub': 'monster',
  'cc0-mushnub-evolved': 'monster',
  'cc0-oobi': 'humanoid',
  'cc0-oodi': 'humanoid',
  'cc0-ooli': 'humanoid',
  'cc0-oopi': 'humanoid',
  'cc0-oozi': 'humanoid',
  'cc0-police': 'vehicle',
  'cc0-race': 'vehicle',
  'cc0-delivery': 'vehicle',
  'cc0-craft-racer': 'aircraft',
  aquarium: null,
  'bird-nest': null,
  'elevator-car': null,
  'wasp-nest': null,
  'seated-person': null,
  star: null,
  'cc0-bear-trap': null,
  'cc0-canoe-paddle': null,
  'cc0-gas-tank': null,
  'cc0-rocket-launcher': null,
  'gen3d-baseball-bat': null,
  'gen3d-bus-stop': null,
  'gen3d-chess-king-piece': null,
  'gen3d-hot-dog': null,
  'gen3d-knight-shield': null,
  'gen3d-party-balloon': null,
  'gen3d-spider-web': null,
  'gen3d-throne': null,
  // P35: hlava odtržená od těla, astra želvu naslepo nepoznala; hrdinou je `turtle` z `game_models.py`.
  'gen3d-tortoise': null,
  'gen3d-witch-cauldron': null,
  'gen3d-wizard-hat': null,
  // P37D dávka 4: rekvizity pojmenované po zvířeti nebo robotovi.
  'gen3d-cat-tree': null,
  'gen3d-fish-tank': null,
  'gen3d-hamster-wheel': null,
  'gen3d-robot-arm': null,
  // P57 T10: kulisy sad světů pojmenované po zvířeti.
  'gen3d-duck-pond': null,
  'gen3d-koi-pond': null,
};

/** Barva náhradního tvaru podle třídy, dokud se model nenačte. */
const FALLBACK = {
  boat: '#0369a1',
  aircraft: '#94a3b8',
  vehicle: '#dc2626',
  robot: '#64748b',
  monster: '#15803d',
  bird: '#0ea5e9',
  animal: '#b45309',
  humanoid: '#f97316',
};

const LOOKUP = new Map(CLASS_ORDER.flatMap((kind) => WORDS[kind].map((word) => [word, kind])));

/**
 * Jmenné seznamy kol gen3d s ruční třídou šablony (`batch.py --from`); pozdější seznam vyhrává.
 * Ruční `prop` nebo plochá věc hrdinou není, ať jméno nese jakékoli slovo třídy („dog kennel“,
 * „car jack“, „wizard tower“). Ruční třída těla (biped, vehicle…) je hrubší než třídy manifestu
 * (loď, letadlo, auto), tu dál určí slova.
 */
const HAND_LISTS = ['evals/play/p45d/gen-nouns.json', 'evals/play/p45f/retry-nouns.json', 'evals/play/p45g/kit-nouns.json', 'evals/play/p45i/round-nouns.json'];

/** `gen3d-<jméno>` → ruční třída šablony ze seznamů, které existují. */
function handClassesFromLists(lists = HAND_LISTS) {
  const classes = {};
  for (const list of lists.filter((path) => existsSync(join(ROOT, path)))) {
    for (const entry of JSON.parse(readFileSync(join(ROOT, list), 'utf8')).nouns) {
      classes[`gen3d-${entry.noun.trim().toLowerCase().split(/\s+/).join('-')}`] = entry.flat ? 'flat' : entry.class;
    }
  }
  return classes;
}

const HAND_CLASSES = handClassesFromLists();

/** „penguins“ → „penguin“, „puppies“ → „puppy“, „foxes“ → „fox“. */
const forms = (word) => [word, word.replace(/ies$/, 'y'), word.replace(/es$/, ''), word.replace(/s$/, '')];

/** Třída podle slov tagů a id; `undefined` = model hrdinou není. */
function classOf(asset, handClasses) {
  if (asset.assetId in CLASS_OF_MODEL) return CLASS_OF_MODEL[asset.assetId] ?? undefined;
  if (['prop', 'flat'].includes(handClasses[asset.assetId])) return undefined;
  // Jména ze slepého soudu P43 (`seen:hot dog`) třídu neurčují – párek by byl pes.
  const words = [...asset.tags.filter((tag) => !tag.includes(':')), asset.assetId.replace(/^(cc0|gen3d)-/, '')].flatMap((tag) => tag.toLowerCase().split(/[\s-]+/));
  const found = new Set(words.flatMap(forms).map((form) => LOOKUP.get(form)));
  return CLASS_ORDER.find((kind) => found.has(kind));
}

const setOf = (id) => (id.startsWith('cc0-') ? 'cc0' : id.startsWith('gen3d-') ? 'gen3d' : 'original');

const round = (value) => Math.max(0.001, Math.round(value * 1000) / 1000);

/**
 * Záznamy manifestu z katalogu, v pořadí katalogu. Model, který už popisuje
 * `entries/base.ts` (riggované postavy, tučňák), se přeskočí – id musí být
 * v manifestu jedinečné a riggovaná verze je lepší hrdina.
 */
export function catalogEntries({ catalog, rigged, disclosure, forward, handClasses = HAND_CLASSES }) {
  const described = new Set(['penguin', ...rigged.characters.map((character) => character.id)]);
  const licenses = new Map(disclosure.entries.map((entry) => [entry.name, entry.license]));
  const entries = [];
  for (const asset of catalog.assets) {
    const kind = classOf(asset, handClasses);
    // P43 T13: model, který slepý soud nepoznal, hrdinu ani nepřítele nehraje.
    if (kind === undefined || described.has(asset.assetId) || asset.tags.includes('qa:unrecognisable')) continue;
    const license = licenses.get(`public${asset.path}`);
    if (license === undefined) throw new Error(`${asset.assetId}: ${asset.path} nemá záznam v disclosure.json`);
    const identity = [...new Set(asset.tags.map((tag) => tag.toLowerCase().trim().replace(/\s+/g, '-')))].filter((tag) => /^[a-z][a-z-]*$/.test(tag));
    const { min, max } = asset.bounds;
    entries.push({
      id: asset.assetId,
      file: asset.path,
      identity: identity.length > 0 ? identity : [asset.assetId.replace(/^(cc0|gen3d)-/, '')],
      class: kind,
      dims: [round(max[0] - min[0]), round(max[1] - min[1]), round(max[2] - min[2])],
      pivot: Math.abs(min[1]) < 0.01 ? 'base' : 'center',
      forward: forward.models[asset.assetId] ?? forward.sets[setOf(asset.assetId)],
      clips: { idle: 'procedural', run: 'procedural', jump: 'procedural', hit: 'procedural', die: 'procedural' },
      fallback: FALLBACK[kind],
      license,
      preload: [],
    });
  }
  return entries;
}

/** Jeden záznam na řádek, ať diff ukáže, který model se změnil. */
function renderCatalog(entries) {
  const comment = 'Generuje node scripts/assets/p32-manifest.mjs (P32C T1) – needitovat ručně, změnu udělat v generátoru nebo v jeho vstupech.';
  return `{\n  "$comment": ${JSON.stringify(comment)},\n  "entries": [\n${entries.map((entry) => `    ${JSON.stringify(entry)}`).join(',\n')}\n  ]\n}\n`;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const read = (path) => JSON.parse(readFileSync(join(ROOT, path), 'utf8'));
  const entries = catalogEntries({
    catalog: read('src/assets/catalog-index.json'),
    rigged: read('src/assets/rigged.json'),
    disclosure: read('disclosure.json'),
    forward: read('scripts/assets/p32-forward.json'),
  });
  writeFileSync(OUT, renderCatalog(entries));
  const counts = {};
  for (const entry of entries) counts[entry.class] = (counts[entry.class] ?? 0) + 1;
  console.log(`${entries.length} záznamů → ${OUT}`, counts);
}
