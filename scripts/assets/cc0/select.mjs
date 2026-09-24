#!/usr/bin/env node
/**
 * Vybere z CC0 cache model pro každé podstatné jméno, které věty chtějí a
 * katalog nemá (P26A T2).
 *
 *   node scripts/assets/cc0/select.mjs      zapíše scripts/assets/cc0/selection.json
 *
 * Podstatná jména čte `readRoles` z návrhu ze slov (`src/play/draft/lexicon.ts`)
 * – tytéž role, které pak arkáda kreslí – a z kontrolních seznamů sady
 * věrnosti. Model se páruje podle slov v názvu souboru; jméno se víc
 * významy („bat“, „crane“) páruje jen tam, kde věta prozradí význam, jinak
 * jde do `ambiguous`. Co nemá model, jde do `unmatched` – vstup pro P26C.
 */
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { folderTokensOf, modelTokensOf, packTokensOf } from './tokens.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

// Lexikon je TypeScript; holý `node` ho načte až s odstraňováním typů.
if (isMain && !process.features.typescript) {
  const run = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', fileURLToPath(import.meta.url), ...process.argv.slice(2)], { stdio: 'inherit' });
  process.exit(run.status ?? 1);
}
const { FOODS, readRoles, singular } = await import('../../../src/play/draft/lexicon.ts');

export const MAX_SELECTED = 250;

/** Tvary, které `singular` vyrobí špatně, a dvě jména téže osoby – sloučí se do jednoho. */
const SPELLING = { knive: 'knife', granny: 'grandma', grannie: 'grandma' };

/** Slova, která role vyplní, ale věc nejmenují. */
const NOT_A_THING = new Set(['game', 'win', 'like', 'everything', 'anything', 'something', 'him', 'her', 'them', 'me', 'you', 'it', 'date', 'range', 'thing', 'way', 'time', 'level', 'crack', 'room', 'stuff']);

/** Pravopisné tvary a skutečná synonyma; nadřazená kategorie sem nepatří. */
const SYNONYMS = {
  roomba: ['vacuum'],
  asteroid: ['meteor'],
  spaceship: ['spacecraft', 'craft'],
  present: ['gift'],
  gift: ['present'],
  diamond: ['gem'],
  gem: ['diamond'],
  corgi: ['dog'],
  puppy: ['dog'],
  kitten: ['cat'],
  bunny: ['rabbit'],
  rabbit: ['bunny'],
  pig: ['hog'],
  automobile: ['car'],
  taxi: ['cab'],
};

/**
 * Jména s víc významy: význam vybere slovo věty (`cue`), model musí patřit
 * témuž významu (`model` nad cestou `pack/soubor`). Žádná nebo víc shod → nepárovat.
 */
const SENSES = {
  bat: [
    { sense: 'animal', cue: /\b(?:vampire|cave|haunted|halloween|spooky|night|wings?|fly|flies|flying)\b/, model: /halloween|graveyard|animal|pets/ },
    { sense: 'sports', cue: /\b(?:baseball|cricket|softball|swing|home run)\b/, model: /baseball|cricket|sport/ },
  ],
  crane: [
    { sense: 'machine', cue: /\b(?:lifts?|lifting|crates?|construction|containers?|harbou?r|port|dock|building site|cargo)\b/, model: /factory|construction|industrial|city|port|crane-(?:lift|magnet)/ },
    { sense: 'bird', cue: /\b(?:birds?|pond|lake|marsh|feathers?|flies|flying|nest)\b/, model: /bird|animal|pets/ },
  ],
  mouse: [
    { sense: 'animal', cue: /\b(?:cat|cats|cheese|trap|kitchen|hole|squeak|rodent|barn)\b/, model: /animal|pets|nature/ },
    { sense: 'computer', cue: /\b(?:computer|click|clicks|desk|keyboard|cursor|pc|laptop)\b/, model: /computer/ },
  ],
  seal: [
    { sense: 'animal', cue: /\b(?:glacier|ice|icy|arctic|antarctic|fish|ocean|sea|beach|penguins?|polar)\b/, model: /animal|pets|nature/ },
    { sense: 'stamp', cue: /\b(?:wax|stamp|letters?|envelopes?|royal decree)\b/, model: /stamp|wax|letter/ },
  ],
  bow: [
    { sense: 'ribbon', cue: /\b(?:gifts?|presents?|christmas|ribbons?|wrapping|birthday)\b/, model: /ribbon|holiday|gift|present/ },
    { sense: 'weapon', cue: /\b(?:archer|archery|arrows?|shoots?|hunter|quiver)\b/, model: /dungeon|weapon|arrow|archer|wooden/ },
  ],
  trunk: [
    { sense: 'tree', cue: /\b(?:forest|trees?|woods?|jungle|logs?|lumberjack)\b/, model: /tree|nature|log/ },
    { sense: 'luggage', cue: /\b(?:luggage|suitcases?|travel|attic|treasure|pirate)\b/, model: /luggage|suitcase|chest/ },
    { sense: 'elephant', cue: /\belephants?\b/, model: /elephant/ },
  ],
  pitcher: [
    { sense: 'jug', cue: /\b(?:water|lemonade|juice|kitchen|pour|pours|drinks?|restaurant|milk)\b/, model: /restaurant|kitchen|food|jug/ },
    { sense: 'player', cue: /\b(?:baseball|mound|batter|strikes?)\b/, model: /baseball|sport|character/ },
  ],
  mole: [
    { sense: 'animal', cue: /\b(?:garden|digs?|digging|whack|underground|burrows?|lawn|dirt)\b/, model: /animal|pets|nature/ },
    { sense: 'spy', cue: /\b(?:spy|spies|agent|secret|double|infiltrat\w*)\b/, model: /spy|agent|character/ },
  ],
};

/**
 * Složená jména, jejichž hlava sama jmenuje jinou věc: černá díra není
 * vykopaná díra, corn dog není pes. Ve větě zůstávají celá, v názvu modelu
 * takový model vylučují pro jiné jméno.
 */
const COMPOUNDS = ['black hole', 'trash can', 'garbage can', 'lily pad', 'ice cream', 'hot dog', 'corn dog', 'warning traffic', 'traffic cone', 'traffic light', 'fire hydrant', 'sea horse', 'star fish', 'jelly fish'];

/** Slova názvu, která jen zařazují („animal-dog“) a délku názvu nepočítají. */
const CATEGORY_WORDS = new Set(['animal', 'character', 'item', 'prop']);

/** Slova názvu, která dělají z věci její část nebo rozbitý kus. */
const PART = new Set(['half', 'slice', 'sliced', 'piece', 'pieces', 'chopped', 'bones', 'broken', 'demolished', 'fragment', 'part', 'raw', 'holder', 'stand', 'cutter', 'rack', 'block', 'sign', 'crate', 'base', 'top', 'fins', 'sides', 'fuel', 'dirty', 'debris', 'damaged', 'destroyed']);

export { modelTokensOf as modelTokens };

/** Hlava fráze v jednotném čísle; složené jméno z `COMPOUNDS` zůstává celé. */
function head(phrase) {
  const words = singular(phrase.toLowerCase()).split(' ');
  const pair = words.slice(-2).join(' ');
  if (words.length > 1 && COMPOUNDS.includes(pair)) return pair;
  return SPELLING[words.at(-1)] ?? words.at(-1);
}

/** Hlavy rolí, které návrh ze slov z věty přečte. */
export function sentenceNouns(text) {
  const roles = readRoles(text);
  const phrases = [roles.player, roles.chaser, roles.collectible, roles.item, roles.destination, roles.target, roles.checkpoint, roles.hazard, roles.threat?.label];
  const nouns = new Set(phrases.filter((phrase) => phrase).map(head).filter((word) => /^[a-z][a-z -]+$/.test(word) && !NOT_A_THING.has(word)));
  // Hazard čtený jedním slovem („hole“) je jen hlava složeného jména téže věty („black hole“).
  return [...nouns].filter((noun) => ![...nouns].some((other) => other.endsWith(` ${noun}`)));
}

const tokenIs = (token, word) => token === word || token === `${word}s` || token === `${word}es`;

/** Kde v názvu leží jméno: jedno slovo, složené jméno po sobě jdoucími slovy, nebo slepené („trashcan“). */
function findWord(tokens, word) {
  const parts = word.split(' ');
  if (parts.length === 1) return tokens.findIndex((token) => tokenIs(token, word));
  const glued = tokens.findIndex((token) => tokenIs(token, parts.join('')));
  if (glued >= 0) return glued;
  return tokens.findIndex((_, at) => parts.every((part, k) => (k === parts.length - 1 ? tokenIs(tokens[at + k] ?? '', part) : tokens[at + k] === part)));
}

/** Název modelu, který obsahuje složené jméno jiné věci než `noun`. */
const foreignCompound = (tokens, noun) => COMPOUNDS.some((compound) => compound !== noun && findWord(tokens, compound) >= 0);
const knownForm = (known, noun) => [noun, singular(noun)].some((form) => known.has(form));

/** Nejlepší model: nejméně slov v názvu, jméno na kraji názvu, pak pořadí balíků a abeceda. */
function best(candidates) {
  return [...candidates].sort((a, b) => a.rank[0] - b.rank[0] || a.rank[1] - b.rank[1] || a.order - b.order || a.key.localeCompare(b.key))[0];
}

function candidatesFor(models, noun, sense) {
  const out = [];
  for (const words of [[noun], SYNONYMS[noun] ?? []]) {
    for (const [order, model] of models.entries()) {
      const key = `${model.pack}/${model.file}`;
      if (sense && !sense.model.test(key.toLowerCase())) continue;
      const tokens = modelTokensOf(model.file);
      if (tokens.some((token) => PART.has(token) && !words.includes(token)) || foreignCompound(tokens, noun)) continue;
      const at = words.map((word) => findWord(tokens, word)).find((index) => index >= 0) ?? -1;
      if (at < 0) continue;
      const edge = at === 0 || at === tokens.length - 1 ? 0 : 1;
      const length = tokens.filter((token) => !CATEGORY_WORDS.has(token)).length;
      out.push({ model, key, order, rank: [length, edge], via: words === SYNONYMS[noun] ? 'synonym' : 'name' });
    }
    if (out.length) return out; // přímé jméno má přednost před synonymem
  }
  return out;
}

/**
 * @param {{ sentences: {id: string, text: string, nouns?: string[]}[], known: Set<string>, models: {pack: string, file: string}[], max?: number }} input
 */
export function selectModels({ sentences, known, models, max = MAX_SELECTED }) {
  const asked = new Map(); // noun → [{id, text}]
  for (const sentence of sentences) {
    for (const noun of new Set([...sentenceNouns(sentence.text), ...(sentence.nouns ?? []).map(head)])) {
      if (NOT_A_THING.has(noun) || knownForm(known, noun)) continue;
      if (!asked.has(noun)) asked.set(noun, []);
      asked.get(noun).push(sentence);
    }
  }

  const picks = new Map(); // noun#sense → entry
  const unmatched = [];
  const ambiguous = [];
  for (const [noun, uses] of [...asked].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))) {
    const senses = SENSES[noun];
    if (senses === undefined) {
      const found = best(candidatesFor(models, noun));
      if (found === undefined) unmatched.push({ noun, sentences: uses.map((use) => use.id) });
      else picks.set(noun, { noun, pack: found.model.pack, file: found.model.file, via: found.via, synonyms: SYNONYMS[noun] ?? [], sentences: uses.map((use) => use.id) });
      continue;
    }
    const unresolved = [];
    const missing = [];
    for (const use of uses) {
      const text = use.text.toLowerCase();
      const hits = senses.filter((sense) => sense.cue.test(text));
      if (hits.length !== 1) { unresolved.push(use.id); continue; }
      const [sense] = hits;
      const id = `${noun}#${sense.sense}`;
      if (picks.has(id)) { picks.get(id).sentences.push(use.id); continue; }
      const found = best(candidatesFor(models, noun, sense));
      if (found === undefined) { missing.push(use.id); continue; }
      picks.set(id, { noun, sense: sense.sense, pack: found.model.pack, file: found.model.file, via: found.via, synonyms: SYNONYMS[noun] ?? [], sentences: [use.id] });
    }
    if (unresolved.length) ambiguous.push({ noun, sentences: unresolved });
    if (missing.length) unmatched.push({ noun, sentences: missing });
  }
  const selected = [...picks.values()].sort((a, b) => b.sentences.length - a.sentences.length || a.noun.localeCompare(b.noun));
  return { selected: selected.slice(0, max), overflow: selected.slice(max).map((entry) => entry.noun), unmatched, ambiguous };
}

export const MAX_BROAD = 500;

/**
 * Kategorie širokého výběru (P26A T10) a slova, podle kterých se model zařadí.
 * Pořadí rozhoduje: první kategorie, jejíž slovo model nese, vyhrává; slova
 * jména se zkouší před slovy složky a ta před slovy balíku.
 */
const CATEGORIES = [
  ['monster', ['monster', 'monsters', 'enemy', 'enemies', 'zombie', 'skeleton', 'ghost', 'goblin', 'orc', 'demon', 'slime', 'dragon', 'alien', 'blob', 'cyclops', 'yeti', 'vampire', 'mummy', 'werewolf', 'witch', 'troll', 'ogre', 'imp', 'bestiary', 'mushnub', 'spider', 'golem', 'wraith']],
  ['animal', ['animal', 'animals', 'pets', 'dog', 'cat', 'cow', 'pig', 'horse', 'sheep', 'chicken', 'duck', 'fish', 'shark', 'whale', 'dolphin', 'bird', 'fox', 'wolf', 'bear', 'deer', 'stag', 'rabbit', 'bunny', 'frog', 'penguin', 'monkey', 'elephant', 'giraffe', 'lion', 'tiger', 'zebra', 'llama', 'alpaca', 'pug', 'husky', 'shiba', 'dinosaur', 'dinosaurs', 'trex', 'velociraptor', 'stegosaurus', 'triceratops', 'apatosaurus', 'parasaurolophus', 'bee', 'crab', 'octopus', 'snake', 'turtle', 'owl', 'eagle', 'parrot', 'seal', 'mouse', 'rat', 'hippo', 'rhino', 'crocodile', 'kangaroo', 'koala', 'panda', 'squirrel', 'hedgehog', 'beaver', 'raccoon', 'butterfly', 'goat', 'donkey', 'bull', 'corgi', 'puppy', 'kitten', 'hen', 'rooster', 'goldfish', 'clownfish', 'pufferfish', 'tuna', 'salmon', 'jellyfish', 'starfish', 'squid']],
  ['character', ['character', 'characters', 'man', 'woman', 'male', 'female', 'knight', 'wizard', 'ninja', 'pirate', 'astronaut', 'soldier', 'adventurer', 'farmer', 'chef', 'king', 'queen', 'princess', 'prince', 'viking', 'cowboy', 'robot', 'worker', 'doctor', 'girl', 'boy', 'person', 'rogue', 'mage', 'warrior', 'barbarian', 'cleric', 'ranger', 'monk', 'hero', 'villager', 'player', 'businessman', 'casual', 'punk', 'swat', 'hazmat', 'survivor', 'mech']],
  ['food', ['food', 'restaurant', 'sushi', ...FOODS, 'banana', 'cake', 'cheese', 'donut', 'doughnut', 'pie', 'egg', 'meat', 'steak', 'sausage', 'cookie', 'candy', 'lollipop', 'icecream', 'pancake', 'pancakes', 'cupcake', 'muffin', 'croissant', 'baguette', 'hotdog', 'chips', 'popcorn', 'pepper', 'tomato', 'potato', 'onion', 'corn', 'pumpkin', 'watermelon', 'pineapple', 'strawberry', 'cherry', 'grape', 'grapes', 'lemon', 'pear', 'peach', 'avocado', 'coconut', 'broccoli', 'lettuce', 'eggplant', 'onigiri', 'nigiri', 'maki', 'rice', 'dumpling', 'shrimp', 'chocolate', 'waffle', 'bacon', 'ham', 'drumstick', 'turkey', 'fruit', 'vegetable', 'soda', 'juice', 'cocktail', 'mug', 'cup', 'bowl', 'plate', 'dinner', 'lunch', 'breakfast']],
  ['vehicle', ['vehicle', 'vehicles', 'car', 'cars', 'truck', 'bus', 'taxi', 'van', 'police', 'ambulance', 'firetruck', 'tractor', 'train', 'tram', 'boat', 'ship', 'plane', 'airplane', 'helicopter', 'rocket', 'spaceship', 'spaceships', 'spacecraft', 'ufo', 'submarine', 'bike', 'bicycle', 'motorcycle', 'scooter', 'kart', 'tank', 'jeep', 'sedan', 'suv', 'cart', 'wagon', 'sled', 'transport', 'locomotive', 'forklift', 'excavator', 'bulldozer', 'racer', 'race', 'hatchback', 'limo', 'yacht', 'canoe', 'kayak', 'raft']],
  ['weapon', ['weapon', 'weapons', 'sword', 'axe', 'bow', 'arrow', 'dagger', 'spear', 'hammer', 'mace', 'shield', 'staff', 'wand', 'gun', 'guns', 'pistol', 'rifle', 'shotgun', 'sniper', 'blaster', 'smg', 'revolver', 'grenade', 'knife', 'club', 'crossbow', 'katana', 'scythe', 'trident', 'launcher', 'bazooka', 'uzi', 'ak', 'machinegun', 'halberd', 'flail']],
  ['collectible', ['coin', 'coins', 'gem', 'gems', 'diamond', 'crystal', 'key', 'star', 'heart', 'chest', 'treasure', 'potion', 'trophy', 'medal', 'crown', 'ring', 'gift', 'present', 'battery', 'powerup', 'powerups', 'pickup', 'pickups', 'ammo', 'money', 'book', 'scroll', 'map', 'jewel', 'pearl', 'bag', 'backpack', 'item', 'items', 'lantern', 'torch', 'candle', 'bottle', 'balloon', 'ball', 'toy', 'feather', 'shell']],
  ['obstacle', ['obstacle', 'barrel', 'crate', 'box', 'cone', 'barrier', 'spike', 'spikes', 'trap', 'boulder', 'bomb', 'mine', 'saw', 'hydrant', 'bin', 'trash', 'dumpster', 'tire', 'tyre', 'hurdle', 'pipe', 'turret', 'cannon', 'anvil', 'sack', 'hay', 'haybale', 'mailbox', 'bollard', 'pallet']],
  ['nature', ['nature', 'tree', 'trees', 'bush', 'flower', 'flowers', 'plant', 'plants', 'grass', 'rock', 'rocks', 'stone', 'mushroom', 'cactus', 'stump', 'log', 'leaf', 'leaves', 'pine', 'palm', 'fern', 'lily', 'reed', 'bamboo', 'birch', 'oak', 'willow', 'maple', 'tulip', 'rose', 'sunflower', 'clover', 'vine', 'coral', 'seaweed', 'crops', 'wheat', 'carrot', 'hedge']],
  ['furniture', ['furniture', 'chair', 'table', 'bed', 'sofa', 'couch', 'desk', 'lamp', 'shelf', 'bookcase', 'cabinet', 'drawer', 'wardrobe', 'closet', 'bench', 'stool', 'toilet', 'bathtub', 'bath', 'sink', 'fridge', 'oven', 'stove', 'tv', 'television', 'computer', 'rug', 'mirror', 'clock', 'piano', 'armchair', 'nightstand', 'dresser', 'fireplace', 'washer', 'microwave', 'radio', 'speaker', 'pot', 'vase']],
].map(([name, words]) => [name, new Set(words)]);

/** Dílky scén a prvky rozhraní: hráč je nesbírá ani nehoní, katalog je nepotřebuje. */
const SCENE_PIECE = new Set(['floor', 'floors', 'wall', 'walls', 'tile', 'tiles', 'road', 'roads', 'path', 'ground', 'roof', 'stair', 'stairs', 'corner', 'platform', 'platforms', 'window', 'door', 'doorway', 'cliff', 'terrain', 'pillar', 'column', 'arch', 'modular', 'segment', 'straight', 'curve', 'curved', 'junction', 'intersection', 'crossing', 'ramp', 'slope', 'edge', 'border', 'pavement', 'sidewalk', 'block', 'blocks', 'ui', 'icon', 'icons', 'button', 'letter', 'number', 'digit', 'cursor', 'texture', 'atlas', 'preview', 'gate', 'bridge', 'building', 'house', 'tower', 'castle', 'foundation', 'beam', 'plank', 'planks', 'railing', 'rail', 'rails', 'track', 'fence', 'post', 'banner', 'flag', 'wallpaper', 'ceiling', 'trim', 'panel', 'support', 'scaffold', 'hole', 'water', 'lava', 'river', 'dock', 'pier', 'split', 'end', 'start', 'finish', 'side', 'center', 'middle', 'inner', 'outer', 'overhang', 'balcony', 'chimney', 'awning', 'window', 'shutter']);
/** Slova varianty téhož tvaru: barva, velikost, pořadí. */
const VARIANT = new Set(['red', 'blue', 'green', 'yellow', 'white', 'black', 'orange', 'pink', 'purple', 'brown', 'grey', 'gray', 'gold', 'golden', 'silver', 'bronze', 'dark', 'light', 'color', 'colour', 'colored', 'small', 'large', 'big', 'tall', 'short', 'wide', 'thin', 'huge', 'tiny', 'medium', 'alt', 'variant', 'var', 'version', 'default', 'texture', 'textured', 'old', 'new', 'lod', 'lod0', 'lod1', 'low', 'high', 'poly', 'lowpoly', 'flat', 'simple', 'detailed', 'detail', 'type', 'style', 'cyan', 'teal', 'beige', 'snow', 'snowy', 'autumn', 'fall', 'winter', 'summer', 'spring', 'dead', 'empty', 'full', 'open', 'closed']);

/** Doplňky a díly jiné věci: pokrývka hlavy, nástavec zbraně, kus stavby. */
const ACCESSORY = new Set(['hat', 'hair', 'beard', 'glasses', 'bipod', 'grip', 'scope', 'silencer', 'stock', 'tripod', 'clip', 'magazine', 'attachment', 'bayonet', 'mast', 'structure', 'supports', 'paneling', 'hood', 'extractorhood', 'dishrack', 'street', 'blood', 'container', 'lights']);
/** Slova, která jen zařazují a jméno tvaru nenesou. */
const SHAPE_NOISE = new Set([...CATEGORY_WORDS, 'characters', 'environment', 'decoration', 'normal', 'basic', 'individual']);
/**
 * Balík zařazuje jen tehdy, když má jedno téma; „zombie“ v názvu balíku
 * neudělá ze sudu příšeru.
 */
const PACK_THEMES = new Set(['monsters', 'animals', 'pets', 'fish', 'dinosaurs', 'food', 'restaurant', 'sushi', 'cars', 'car', 'transport', 'spaceships', 'weapons', 'gun', 'blaster', 'nature', 'furniture']);

/** Kategorie: slova jména od hlavy (posledního slova), pak složky, pak téma balíku. */
const categoryOf = ([name, folder = [], pack = []]) => {
  for (const tokens of [...[...name].reverse().map((token) => [token]), folder, pack.filter((token) => PACK_THEMES.has(token))]) {
    for (const [category, words] of CATEGORIES) if (tokens.some((token) => words.has(token))) return category;
  }
  return null;
};

/** Lexikografické `a < b` nad poli čísel. */
const before = (a, b) => {
  const at = a.findIndex((value, i) => value !== b[i]);
  return at >= 0 && a[at] < b[at];
};

/** Pořadí autorů u stejného tvaru: Quaternius je oblejší a podrobnější než hranatý Kenney. */
const AUTHOR_RANK = (pack) => (pack.startsWith('quaternius') ? 0 : pack.startsWith('kaykit') ? 1 : 2);

/**
 * Široký výběr (P26A T10): každý model v cache dostane štítky ze jména,
 * složky a balíku a kategorii; dílky scén, rozhraní a varianty téhož tvaru
 * vypadnou. Jeden model na jméno tvaru; jméno, které katalog už nese
 * (`known`), zůstane vlastnímu nebo dříve zařazenému modelu.
 *
 * @param {{ models: {pack: string, file: string}[], known: Set<string>, max?: number }} input
 */
export function selectBroad({ models, known, max = MAX_BROAD }) {
  const shapes = new Map(); // jméno tvaru → nejlepší kandidát
  const dropped = { scene: 0, uncategorized: 0, variant: 0, known: 0 };
  for (const [order, model] of models.entries()) {
    // Pořadové číslo („bottle2“, „sofa3“) je varianta téhož tvaru.
    const name = modelTokensOf(model.file).map((token) => token.replace(/\d+$/, '')).filter((token) => token.length > 1).map((token) => SPELLING[token] ?? token);
    const folder = folderTokensOf(model.file);
    const pack = packTokensOf(model.pack);
    if (name.length === 0 || [...name, ...folder].some((token) => SCENE_PIECE.has(token) || PART.has(token) || ACCESSORY.has(token))) { dropped.scene += 1; continue; }
    const category = categoryOf([name, folder, pack]);
    if (category === null) { dropped.uncategorized += 1; continue; }
    const shape = name.filter((token) => !VARIANT.has(token) && !SHAPE_NOISE.has(token));
    if (shape.length === 0 || shape.length > 3) { dropped.uncategorized += 1; continue; }
    const noun = shape.join(' ');
    if ([noun, shape.join('-'), ...(shape.length === 1 ? [singular(noun)] : [])].some((form) => known.has(form))) { dropped.known += 1; continue; }
    const candidate = { model, order, noun, shape, category, rank: [AUTHOR_RANK(model.pack), name.length, order] };
    const current = shapes.get(noun);
    if (current !== undefined) dropped.variant += 1;
    if (current === undefined || before(candidate.rank, current.rank)) shapes.set(noun, candidate);
  }

  // Nad stropem střídat kategorie, ať jedna velká (příroda) nevytlačí ostatní.
  const byCategory = new Map(CATEGORIES.map(([name]) => [name, []]));
  for (const candidate of [...shapes.values()].sort((a, b) => a.shape.length - b.shape.length || a.rank[0] - b.rank[0] || a.noun.localeCompare(b.noun))) byCategory.get(candidate.category).push(candidate);
  const picked = [];
  for (let round = 0; picked.length < max && [...byCategory.values()].some((list) => list.length > round); round++) {
    for (const list of byCategory.values()) if (list[round] && picked.length < max) picked.push(list[round]);
  }

  const selected = picked.map(({ model, noun, shape, category }) => ({
    noun, pack: model.pack, file: model.file, via: 'broad', category,
    tags: [...new Set([noun, ...(shape.length > 1 ? [shape.join('-'), shape.at(-1), shape[0]] : []), ...(SYNONYMS[noun] ?? [])])],
    synonyms: SYNONYMS[noun] ?? [], sentences: [],
  })).sort((a, b) => a.category.localeCompare(b.category) || a.noun.localeCompare(b.noun));
  return { selected, overflow: shapes.size - selected.length, dropped };
}

/**
 * Model pro popisek tak, jak ho hledá arkáda (`modelOf` v `src/play/arcade/models.ts`):
 * slova popisku odzadu, první slovo, které je štítkem, vyhrává.
 */
export function findByLabel(selected, label) {
  const words = label.toLowerCase().match(/[a-z][a-z-]*/g) ?? [];
  for (const word of [...words].reverse()) {
    const hit = selected.find((entry) => [word, singular(word)].some((form) => entry.tags.includes(form)));
    if (hit) return hit;
  }
  return undefined;
}

/** Modely v cache: GLB a glTF z balíků, které `fetch.mjs` stáhl. */
export function cacheModels(fetched) {
  const cache = fetched.cache;
  const models = [];
  for (const record of fetched.packs.filter((entry) => !entry.skipped)) {
    const dir = path.join(cache, record.pack);
    const walk = (at) => {
      for (const entry of readdirSync(at, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const full = path.join(at, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(glb|gltf)$/i.test(entry.name)) models.push({ pack: record.pack, file: path.relative(dir, full).replaceAll('\\', '/') });
      }
    };
    walk(dir);
  }
  return models;
}

if (isMain) {
  const read = (file) => JSON.parse(readFileSync(path.join(ROOT, file), 'utf8'));
  const demand = read('evals/play/demand/corpus.json');
  const fidelity = read('evals/play/fidelity/corpus.json');
  const catalog = read('src/assets/catalog.json');
  const sentences = [
    ...demand.map((entry) => ({ id: entry.id, text: entry.text })),
    ...fidelity.sentences.map((entry) => ({
      id: `fidelity:${entry.id}`,
      text: entry.text,
      nouns: entry.checklist.filter((item) => !['verb', 'setting'].includes(item.slot)).map((item) => item.item),
    })),
  ];
  // Vlastní modely katalogu; CC0 záznamy z dřívějšího běhu výběr nahrazuje.
  const known = new Set(catalog.assets.filter((asset) => !asset.assetId.startsWith('cc0-')).flatMap((asset) => [asset.assetId, ...asset.tags]));
  const models = cacheModels(JSON.parse(readFileSync(path.join(HERE, 'fetched.json'), 'utf8')));
  const result = selectModels({ sentences, known, models });
  // Ruční opravy výběru T2 (asteroid: texturovaný kámen místo béžové koule, QA 24. 9.) přežijí nový běh.
  const previous = JSON.parse(readFileSync(path.join(HERE, 'selection.json'), 'utf8'));
  const manual = new Map(previous.selected.filter((entry) => entry.via === 'manual').map((entry) => [`${entry.noun}#${entry.sense ?? ''}`, entry]));
  result.selected = result.selected.map((entry) => {
    const fixed = manual.get(`${entry.noun}#${entry.sense ?? ''}`);
    return fixed ? { ...entry, pack: fixed.pack, file: fixed.file, via: 'manual' } : entry;
  });
  let broad = null;
  if (process.argv.includes('--broad')) {
    const categoryOfEntry = (entry) => categoryOf([[entry.noun, ...modelTokensOf(entry.file)], folderTokensOf(entry.file), packTokensOf(entry.pack)]) ?? 'collectible';
    result.selected = result.selected.map((entry) => ({ ...entry, category: categoryOfEntry(entry), tags: [entry.noun, ...entry.synonyms] }));
    const taken = new Set([...known, ...result.selected.flatMap((entry) => entry.tags)]);
    broad = selectBroad({ models, known: taken, max: MAX_BROAD - result.selected.length });
    result.selected = [...result.selected, ...broad.selected];
  }
  const out = {
    about: broad
      ? 'P26A T10: the T2 picks (nouns the sentences ask for) first, then a broad selection from the whole CC0 cache by category, one model per shape name; scene pieces, interface parts and colour or size variants are dropped. unmatched feeds P26C; ambiguous nouns had no deciding word in the sentence.'
      : 'P26A T2: nouns from evals/play/demand and evals/play/fidelity that src/assets/catalog.json has no exact tag for, paired with a CC0 model from the local cache. unmatched feeds P26C; ambiguous nouns had no deciding word in the sentence.',
    models: models.length,
    ...(broad ? { broad: { selected: broad.selected.length, overflow: broad.overflow, dropped: broad.dropped } } : {}),
    ...result,
  };
  writeFileSync(path.join(HERE, 'selection.json'), `${JSON.stringify(out, null, 2)}\n`);
  console.log(`${result.selected.length} selected, ${result.unmatched.length} unmatched, ${result.ambiguous.length} ambiguous (from ${models.length} models)`);
  if (broad) console.log(`broad: ${broad.selected.length} added, ${broad.overflow} over the cap, dropped ${JSON.stringify(broad.dropped)}`);
}
