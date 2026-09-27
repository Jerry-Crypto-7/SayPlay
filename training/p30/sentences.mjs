/**
 * Trénovací věty P30C T3: deterministicky ze šablon a slovníků, žádný model.
 *
 * Každá věta nese kontrolní seznam ve tvaru `evals/play/fidelity/corpus.json`
 * (2–4 podstatná jména a právě jedno sloveso), aby řetěz věrnosti mohl
 * kandidáty seřadit. Rozložení rodin sloves kopíruje sadu poptávek
 * (`evals/play/demand/corpus.json`: hodně mřížky, závodů, běhu, načasování)
 * a zhruba desetina vět je porotcovsky mimo žánr jako `judge-10`.
 *
 * Výběr slov je hash (FNV-1a) z rodiny, pořadí a slotu – ne PRNG, takže
 * stejný kód dá vždy stejný soubor. Věta, která se normalizovaně potká
 * s korpusem věrnosti, `judge-10`, sadou poptávek nebo testovací sadou P30A,
 * se přeskočí.
 *
 *   node training/p30/sentences.mjs   → evals/play/train/sentences.jsonl
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const SENTENCES_PATH = join(ROOT, 'evals', 'play', 'train', 'sentences.jsonl');

/** Sady, se kterými se trénovací věta nesmí potkat; `test-200.json` jen když na větvi už je. */
export const HELD_OUT = [
  'evals/play/fidelity/corpus.json',
  'evals/play/fidelity/judge-10.json',
  'evals/play/demand/corpus.json',
  'evals/play/p30/test-200.json',
];

export const normalize = (text) =>
  text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/** Texty vět ze sady: pole vět, nebo objekt s polem `sentences`. */
export function heldOutTexts(root = ROOT) {
  const texts = [];
  for (const file of HELD_OUT) {
    const path = join(root, file);
    if (!existsSync(path)) continue;
    const data = JSON.parse(readFileSync(path, 'utf8'));
    for (const entry of Array.isArray(data) ? data : data.sentences) texts.push(entry.text);
  }
  return texts;
}

function fnv1a(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

// ------------------------------------------------------------------ slovník

/** Podstatné jméno: jednotné, množné a slova, podle kterých ho řetěz pozná. */
const N = (one, many = `${one}s`, ...extra) => ({ one, many, match: [...new Set([one, ...(many === `${one}s` || many === `${one}es` ? [] : [many]), ...extra])] });

const HEROES = [
  N('pirate'), N('astronaut'), N('knight'), N('ninja'), N('penguin'), N('fox', 'foxes'), N('raccoon'), N('hedgehog'),
  N('goat'), N('octopus', 'octopuses'), N('snail'), N('owl'), N('turtle'), N('bee'), N('firefighter', 'firefighters', 'fireman'),
  N('mail carrier', 'mail carriers', 'postman', 'mailman'), N('cowboy'), N('samurai', 'samurai'), N('viking'), N('witch', 'witches'),
  N('mermaid'), N('dinosaur', 'dinosaurs', 'dino'), N('kitten', 'kittens', 'cat'), N('puppy', 'puppies', 'dog'), N('sloth'),
  N('llama'), N('panda'), N('koala'), N('detective'), N('skater', 'skaters', 'skateboarder'), N('ballerina'), N('farmer'),
  N('lumberjack'), N('beekeeper'), N('yeti'), N('unicorn'), N('grandpa', 'grandpas', 'grandfather', 'old man'), N('jellyfish', 'jellyfish'),
  N('hamster'), N('robot vacuum', 'robot vacuums', 'vacuum'), N('frog'), N('squid'),
];

const ENEMIES = [
  N('zombie'), N('ghost'), N('bat'), N('spider'), N('shark'), N('wasp'), N('crab'), N('rat'), N('slime'), N('skeleton'),
  N('goblin'), N('alien'), N('vampire'), N('mummy', 'mummies'), N('wolf', 'wolves'), N('snowman', 'snowmen'),
  N('killer tomato', 'killer tomatoes', 'tomato', 'tomatoes'), N('clown'), N('drone'), N('mosquito', 'mosquitoes'), N('seagull'),
  N('crow'), N('cyborg'), N('pumpkin'), N('dust bunny', 'dust bunnies', 'bunny', 'bunnies'), N('space pirate'), N('troll'),
  N('scorpion'), N('lava monster'), N('evil robot', 'evil robots', 'robot'),
];

const PICKUPS = [
  N('gold coin', 'gold coins', 'coin', 'gold'), N('gem'), N('star'), N('mushroom'), N('cupcake'), N('key'), N('seashell', 'seashells', 'shell'),
  N('donut', 'donuts', 'doughnut'), N('firefly', 'fireflies'), N('crystal'), N('sock'), N('carrot'), N('feather'), N('pearl'),
  N('cookie'), N('letter'), N('ticket'), N('snowflake'), N('banana'), N('diamond'), N('treasure chest', 'treasure chests', 'chest', 'treasure'),
  N('battery', 'batteries'), N('lost kitten', 'lost kittens', 'kitten'), N('magic potion', 'magic potions', 'potion'),
];

/** Místo: text ve větě a slova, podle kterých ho řetěz najde v `theme.setting`. */
const S = (text, ...match) => ({ text, match });
const SETTINGS = [
  S('a haunted mansion', 'mansion', 'haunted'), S('a sunken ship', 'ship'), S('an active volcano', 'volcano'), S('candy land', 'candy'),
  S('a space station', 'space station', 'station'), S('a jungle temple', 'temple', 'jungle'), S('a frozen lake', 'lake', 'frozen'),
  S('a desert canyon', 'canyon', 'desert'), S('a neon city', 'city', 'neon'), S('a medieval village', 'village'), S('a coral reef', 'reef', 'coral'),
  S('a bakery', 'bakery'), S('an old library', 'library'), S('a train station', 'train station', 'station'), S('a kingdom in the clouds', 'cloud', 'sky'),
  S('a pirate island', 'island'), S('a toy store', 'toy store', 'toy'), S('the rooftops at night', 'rooftop', 'roof'),
  S('a school cafeteria', 'cafeteria', 'school'), S('a graveyard', 'graveyard', 'cemetery'), S('a mushroom forest', 'forest', 'mushroom'),
  S('a snowy mountain', 'mountain', 'snow'), S('a farm', 'farm'), S('an airport', 'airport'), S('a subway tunnel', 'subway', 'tunnel'),
  S('a castle dungeon', 'dungeon', 'castle'), S('a moon base', 'moon'), S('an underwater city', 'underwater', 'city'), S('a flower garden', 'garden'),
  S('a swamp', 'swamp'), S('a secret laboratory', 'laboratory', 'lab'), S('a circus tent', 'circus'), S('a museum', 'museum'),
  S('a bowling alley', 'bowling'), S('a backyard', 'backyard', 'yard'), S('an office', 'office'), S('a busy highway', 'highway', 'road'),
  S('an ice cave', 'cave', 'ice'), S('a rainforest', 'rainforest', 'jungle'), S('an ancient pyramid', 'pyramid'), S('a lighthouse', 'lighthouse'),
  S('a toxic factory', 'factory'), S('a crater on Mars', 'mars', 'crater'), S('a water park', 'water park', 'pool'), S('a ski resort', 'ski', 'snow'),
];

const OBSTACLES = [
  N('fire hydrant', 'fire hydrants', 'hydrant'), N('rolling barrel', 'rolling barrels', 'barrel'), N('puddle'), N('traffic cone', 'traffic cones', 'cone'),
  N('cactus', 'cacti', 'cactuses'), N('log'), N('spike'), N('lava pit', 'lava pits', 'lava'), N('saw blade', 'saw blades', 'saw', 'blade'),
  N('falling rock', 'falling rocks', 'rock'), N('fence'), N('tumbleweed'), N('icicle'), N('laser beam', 'laser beams', 'laser'), N('mud pit', 'mud pits', 'mud'),
];

const VEHICLES = [
  N('tractor'), N('hovercraft', 'hovercraft'), N('ice cream truck', 'ice cream trucks', 'truck'), N('bathtub', 'bathtubs', 'tub'),
  N('hot air balloon', 'hot air balloons', 'balloon'), N('snowmobile'), N('lawn mower', 'lawn mowers', 'mower'), N('go-kart', 'go-karts', 'kart'),
  N('submarine'), N('motorbike', 'motorbikes', 'motorcycle', 'bike'), N('canoe'), N('rocket'), N('taxi', 'taxis', 'cab'), N('sled'), N('helicopter'),
];

const ROAD_HAZARDS = [
  N('pothole'), N('cow'), N('iceberg'), N('asteroid'), N('tornado', 'tornadoes'), N('police car', 'police cars', 'police'),
  N('sheep', 'sheep'), N('boulder'), N('oil spill', 'oil spills', 'oil'), N('pigeon'),
];

const PROJECTILES = [
  N('water balloon', 'water balloons', 'balloon'), N('pie'), N('paper plane', 'paper planes', 'plane'), N('boomerang'), N('horseshoe'),
  N('dart'), N('basketball', 'basketballs', 'ball'), N('frisbee'), N('rubber duck', 'rubber ducks', 'duck'), N('pillow'), N('cabbage'),
  N('axe', 'axes'), N('bowling ball', 'bowling balls', 'ball'), N('coconut'),
];

const TARGETS = [
  N('tin can', 'tin cans', 'can'), N('scarecrow'), N('hoop'), N('bullseye', 'bullseyes', 'target'), N('window'), N('bucket'),
  N('piñata', 'piñatas', 'pinata'), N('garden gnome', 'garden gnomes', 'gnome'), N('balloon'), N('robot'), N('watermelon'),
];

const STACKABLES = [
  N('sushi roll', 'sushi rolls', 'sushi'), N('book'), N('sandwich', 'sandwiches'), N('box', 'boxes'), N('hay bale', 'hay bales', 'hay'),
  N('ice cream scoop', 'ice cream scoops', 'scoop', 'ice cream'), N('jelly cube', 'jelly cubes', 'jelly'), N('tire'), N('cake'),
  N('turtle'), N('present', 'presents', 'gift'), N('cheese wheel', 'cheese wheels', 'cheese'),
];

const RIVALS = [
  N('bear'), N('sumo wrestler', 'sumo wrestlers', 'sumo', 'wrestler'), N('giant crab', 'giant crabs', 'crab'), N('evil robot', 'evil robots', 'robot'),
  N('gorilla'), N('snowman', 'snowmen'), N('pirate captain', 'pirate captains', 'captain', 'pirate'), N('dragon'), N('boxing chicken', 'boxing chickens', 'chicken'),
  N('lobster'), N('grumpy troll', 'grumpy trolls', 'troll'), N('mummy', 'mummies'),
];

const GROWERS = [N('blob'), N('slime'), N('piranha'), N('snake'), N('hungry whale', 'hungry whales', 'whale'), N('tornado', 'tornadoes'), N('giant worm', 'giant worms', 'worm'), N('black cat', 'black cats', 'cat')];
const FOOD = [N('fish', 'fish'), N('crumb'), N('car'), N('bug'), N('candy', 'candies'), N('tree'), N('cloud'), N('plankton', 'plankton')];

const MUSICIANS = [N('drummer'), N('dancing bear', 'dancing bears', 'bear'), N('DJ', 'DJs', 'dj'), N('singing frog', 'singing frogs', 'frog'), N('rock band', 'rock bands', 'band'), N('robot dancer', 'robot dancers', 'robot'), N('ballerina'), N('rapper')];

const PUZZLE_ITEMS = [N('jewel'), N('fruit', 'fruits'), N('colored ball', 'colored balls', 'ball'), N('tile'), N('sock'), N('bottle'), N('crystal'), N('candy', 'candies')];
const CONTAINERS = [N('jar'), N('basket'), N('tube'), N('drawer'), N('box', 'boxes'), N('bucket')];

const BUILDINGS = [N('sandcastle'), N('treehouse'), N('snow fort', 'snow forts', 'fort'), N('bridge'), N('rocket'), N('robot'), N('pizza oven', 'pizza ovens', 'oven'), N('igloo')];
const MATERIALS = [N('LEGO brick', 'LEGO bricks', 'lego', 'brick'), N('pillow'), N('cardboard box', 'cardboard boxes', 'cardboard', 'box'), N('ice block', 'ice blocks', 'ice'), N('seashell', 'seashells', 'shell'), N('stick'), N('marshmallow')];

const CALM_THINGS = [N('birthday cake', 'birthday cakes', 'cake'), N('poem'), N('sweater'), N('lemonade', 'lemonade'), N('bonsai tree', 'bonsai trees', 'bonsai', 'tree'), N('painting'), N('love letter', 'love letters', 'letter'), N('sandcastle'), N('teapot'), N('houseplant')];

const LIKE = ['flappy bird', 'temple run', 'mario', 'subway surfers', 'angry birds', 'fruit ninja', 'crossy road', 'pac-man', 'geometry dash', 'agar.io', 'guitar hero', 'mario kart', 'tetris', 'doodle jump', 'punch-out'];

// ------------------------------------------------------------------ rodiny sloves

const an = (word) => (/^(?:[aeio]|u(?!ni|se|ro))/i.test(word) ? `an ${word}` : `a ${word}`);
const cap = (text) => text.charAt(0).toUpperCase() + text.slice(1);
const noun = (entry, slot) => ({ entry, slot });
const verb = (item, controls, mechanics) => ({ item, slot: 'verb', controls, ...(mechanics === undefined ? {} : { mechanics }) });
const COUNTS = ['three', 'five', 'ten', 'seven', '12', '20'];

/**
 * Rodina = sloveso s ovládáním, které ho splní (stejná pravidla jako korpus věrnosti),
 * počet vět a šablony. Šablona dostane `pick(list, slot)` a vrátí text a podstatná jména.
 */
const FAMILIES = [
  {
    id: 'collect', count: 30, verb: verb('collect', [], ['collectible']),
    templates: [
      (p) => { const h = p(HEROES, 'h'), c = p(PICKUPS, 'c'), e = p(ENEMIES, 'e'), s = p(SETTINGS, 's'), n = p(COUNTS, 'n');
        return [`${an(h.one)} collects ${n} ${c.many} in ${s.text} while avoiding ${e.many}`, [noun(h, 'hero'), noun(c, 'role'), noun(e, 'role')], s]; },
      (p) => { const h = p(HEROES, 'h'), c = p(PICKUPS, 'c'), s = p(SETTINGS, 's');
        return [`help ${an(h.one)} gather ${c.many} all over ${s.text}`, [noun(h, 'hero'), noun(c, 'role')], s]; },
      (p) => { const c = p(PICKUPS, 'c'), e = p(ENEMIES, 'e'), s = p(SETTINGS, 's');
        return [`pick up every ${c.one} in ${s.text} before the ${e.many} catch you`, [noun(c, 'role'), noun(e, 'role')], s]; },
      (p) => { const h = p(HEROES, 'h'), c = p(PICKUPS, 'c'), s = p(SETTINGS, 's'), l = p(LIKE, 'l');
        return [`${l} but you are ${an(h.one)} collecting ${c.many} in ${s.text}`, [noun(h, 'hero'), noun(c, 'role')], s]; },
    ],
  },
  {
    id: 'steal', count: 15, verb: verb('steal', [], ['collectible', 'carry']),
    templates: [
      (p) => { const h = p(HEROES, 'h'), c = p(PICKUPS, 'c'), e = p(ENEMIES, 'e'), s = p(SETTINGS, 's');
        return [`${an(h.one)} sneaks into ${s.text} to steal ${c.many} without waking the ${e.many}`, [noun(h, 'hero'), noun(c, 'role'), noun(e, 'role')], s]; },
      (p) => { const h = p(HEROES, 'h'), c = p(PICKUPS, 'c'), s = p(SETTINGS, 's');
        return [`heist game where ${an(h.one)} steals the ${c.one} from ${s.text}`, [noun(h, 'hero'), noun(c, 'role')], s]; },
    ],
  },
  {
    id: 'escape', count: 20, verb: verb('escape', ['runner'], ['chaser']),
    templates: [
      (p) => { const h = p(HEROES, 'h'), e = p(ENEMIES, 'e'), s = p(SETTINGS, 's');
        return [`${an(h.one)} escapes ${s.text} while ${an(e.one)} chases it`, [noun(h, 'hero'), noun(e, 'role')], s]; },
      (p) => { const h = p(HEROES, 'h'), e = p(ENEMIES, 'e'), s = p(SETTINGS, 's');
        return [`run away from a giant ${e.one} through ${s.text} as ${an(h.one)}`, [noun(h, 'hero'), noun(e, 'role')], s]; },
      (p) => { const h = p(HEROES, 'h'), e = p(ENEMIES, 'e'), s = p(SETTINGS, 's');
        return [`${cap(an(h.one))} has to get out of ${s.text} before the ${e.many} catch up.`, [noun(h, 'hero'), noun(e, 'role')], s]; },
    ],
  },
  {
    id: 'run', count: 20, verb: verb('run', ['runner']),
    templates: [
      (p) => { const h = p(HEROES, 'h'), o = p(OBSTACLES, 'o'), c = p(PICKUPS, 'c'), s = p(SETTINGS, 's');
        return [`${an(h.one)} runs through ${s.text} jumping over ${o.many} and grabbing ${c.many}`, [noun(h, 'hero'), noun(o, 'role'), noun(c, 'role')], s]; },
      (p) => { const h = p(HEROES, 'h'), o = p(OBSTACLES, 'o'), s = p(SETTINGS, 's');
        return [`endless runner with ${an(h.one)} in ${s.text} dodging ${o.many}`, [noun(h, 'hero'), noun(o, 'role')], s]; },
      (p) => { const h = p(HEROES, 'h'), o = p(OBSTACLES, 'o'), s = p(SETTINGS, 's');
        return [`subway surfers but ${an(h.one)} sprinting across ${s.text} past ${o.many}`, [noun(h, 'hero'), noun(o, 'role')], s]; },
    ],
  },
  {
    id: 'jump', count: 22, verb: verb('jump', ['platform']),
    templates: [
      (p) => { const h = p(HEROES, 'h'), o = p(OBSTACLES, 'o'), s = p(SETTINGS, 's');
        return [`${an(h.one)} jumps from platform to platform in ${s.text} avoiding ${o.many}`, [noun(h, 'hero'), noun(o, 'role')], s]; },
      (p) => { const h = p(HEROES, 'h'), c = p(PICKUPS, 'c'), s = p(SETTINGS, 's');
        return [`a platformer where ${an(h.one)} climbs ${s.text} to reach a golden ${c.one}`, [noun(h, 'hero'), noun(c, 'role')], s]; },
      (p) => { const o = p(OBSTACLES, 'o'), s = p(SETTINGS, 's');
        return [`obby in ${s.text} with ${o.many} everywhere`, [noun(o, 'role')], s]; },
      (p) => { const h = p(HEROES, 'h'), s = p(SETTINGS, 's');
        return [`doodle jump but with ${an(h.one)} bouncing up through ${s.text}`, [noun(h, 'hero')], s]; },
    ],
  },
  {
    id: 'flap', count: 10, verb: verb('flap', ['flap']),
    templates: [
      (p) => { const h = p(HEROES, 'h'), o = p(OBSTACLES, 'o'), s = p(SETTINGS, 's');
        return [`flappy bird but you are ${an(h.one)} flying between ${o.many} over ${s.text}`, [noun(h, 'hero'), noun(o, 'role')], s]; },
      (p) => { const h = p(HEROES, 'h'), s = p(SETTINGS, 's');
        return [`tap to keep ${an(h.one)} in the air above ${s.text}`, [noun(h, 'hero')], s]; },
    ],
  },
  {
    id: 'race', count: 25, verb: verb('race', ['steer']),
    templates: [
      (p) => { const v = p(VEHICLES, 'v'), r = p(ROAD_HAZARDS, 'r'), s = p(SETTINGS, 's');
        return [`${v.one} race through ${s.text} avoiding ${r.many}`, [noun(v, 'hero'), noun(r, 'role')], s]; },
      (p) => { const h = p(HEROES, 'h'), v = p(VEHICLES, 'v'), s = p(SETTINGS, 's');
        return [`${an(h.one)} drives ${an(v.one)} across ${s.text} to win the race`, [noun(h, 'any'), noun(v, 'hero')], s]; },
      (p) => { const v = p(VEHICLES, 'v'), r = p(ROAD_HAZARDS, 'r'), s = p(SETTINGS, 's');
        return [`mario kart with ${v.many} in ${s.text}, watch out for ${r.many}`, [noun(v, 'hero'), noun(r, 'role')], s]; },
      (p) => { const v = p(VEHICLES, 'v'), s = p(SETTINGS, 's');
        return [`Steer ${an(v.one)} through ${s.text} as fast as you can.`, [noun(v, 'hero')], s]; },
    ],
  },
  {
    id: 'shoot', count: 22, verb: verb('shoot', ['shooter']),
    templates: [
      (p) => { const h = p(HEROES, 'h'), e = p(ENEMIES, 'e'), s = p(SETTINGS, 's');
        return [`${an(h.one)} shoots ${e.many} in ${s.text}`, [noun(h, 'hero'), noun(e, 'role')], s]; },
      (p) => { const e = p(ENEMIES, 'e'), s = p(SETTINGS, 's');
        return [`${e.one} shooter in ${s.text}`, [noun(e, 'role')], s]; },
      (p) => { const h = p(HEROES, 'h'), e = p(ENEMIES, 'e'), s = p(SETTINGS, 's');
        return [`blast the ${e.many} out of ${s.text} with ${an(h.one)} and a water gun`, [noun(h, 'hero'), noun(e, 'role')], s]; },
    ],
  },
  {
    id: 'defend', count: 15, verb: verb('defend', ['shooter'], ['spawn_wave', 'defeat']),
    templates: [
      (p) => { const h = p(HEROES, 'h'), e = p(ENEMIES, 'e'), s = p(SETTINGS, 's');
        return [`${an(h.one)} defends ${s.text} from waves of ${e.many}`, [noun(h, 'hero'), noun(e, 'role')], s]; },
      (p) => { const e = p(ENEMIES, 'e'), s = p(SETTINGS, 's');
        return [`protect ${s.text} from an invasion of ${e.many}`, [noun(e, 'role')], s]; },
    ],
  },
  {
    id: 'throw', count: 20, verb: verb('throw', ['throw']),
    templates: [
      (p) => { const j = p(PROJECTILES, 'j'), t = p(TARGETS, 't'), s = p(SETTINGS, 's');
        return [`throw ${j.many} at ${t.many} in ${s.text}`, [noun(j, 'any'), noun(t, 'role')], s]; },
      (p) => { const h = p(HEROES, 'h'), j = p(PROJECTILES, 'j'), t = p(TARGETS, 't'), s = p(SETTINGS, 's');
        return [`${an(h.one)} tosses ${j.many} into ${t.many} at ${s.text}`, [noun(h, 'hero'), noun(j, 'any'), noun(t, 'role')], s]; },
      (p) => { const j = p(PROJECTILES, 'j'), t = p(TARGETS, 't');
        return [`angry birds but you launch ${j.many} at ${t.many}`, [noun(j, 'any'), noun(t, 'role')], null]; },
    ],
  },
  {
    id: 'stack', count: 20, verb: verb('stack', ['timing']),
    templates: [
      (p) => { const k = p(STACKABLES, 'k'), s = p(SETTINGS, 's');
        return [`stack ${k.many} as high as you can in ${s.text}`, [noun(k, 'any')], s]; },
      (p) => { const h = p(HEROES, 'h'), k = p(STACKABLES, 'k'), s = p(SETTINGS, 's');
        return [`${an(h.one)} builds a wobbly tower of ${k.many} at ${s.text}`, [noun(h, 'hero'), noun(k, 'any')], s]; },
      (p) => { const k = p(STACKABLES, 'k'), s = p(SETTINGS, 's');
        return [`drop ${k.many} at the right moment so the pile in ${s.text} does not fall`, [noun(k, 'any')], s]; },
    ],
  },
  {
    id: 'rhythm', count: 12, verb: verb('play to the beat', ['rhythm']),
    templates: [
      (p) => { const m = p(MUSICIANS, 'm'), s = p(SETTINGS, 's');
        return [`${an(m.one)} plays to the beat in ${s.text}`, [noun(m, 'hero')], s]; },
      (p) => { const m = p(MUSICIANS, 'm'), s = p(SETTINGS, 's');
        return [`guitar hero but with ${an(m.one)} performing at ${s.text}`, [noun(m, 'hero')], s]; },
    ],
  },
  {
    id: 'fight', count: 12, verb: verb('fight', ['duel']),
    templates: [
      (p) => { const h = p(HEROES, 'h'), r = p(RIVALS, 'r'), s = p(SETTINGS, 's');
        return [`${an(h.one)} boxes ${an(r.one)} in ${s.text}`, [noun(h, 'hero'), noun(r, 'role')], s]; },
      (p) => { const h = p(HEROES, 'h'), r = p(RIVALS, 'r'), s = p(SETTINGS, 's');
        return [`a fighting game where ${an(h.one)} battles ${an(r.one)} on top of ${s.text}`, [noun(h, 'hero'), noun(r, 'role')], s]; },
    ],
  },
  {
    id: 'grow', count: 12, verb: verb('eat', ['move_free']),
    templates: [
      (p) => { const g = p(GROWERS, 'g'), f = p(FOOD, 'f'), s = p(SETTINGS, 's');
        return [`${an(g.one)} eats ${f.many} in ${s.text} and gets bigger`, [noun(g, 'hero'), noun(f, 'any')], s]; },
      (p) => { const g = p(GROWERS, 'g'), f = p(FOOD, 'f');
        return [`agar.io but you are ${an(g.one)} swallowing ${f.many}`, [noun(g, 'hero'), noun(f, 'any')], null]; },
    ],
  },
  {
    id: 'dodge', count: 12, verb: verb('dodge', ['move_free', 'runner']),
    templates: [
      (p) => { const h = p(HEROES, 'h'), j = p(PROJECTILES, 'j'), s = p(SETTINGS, 's');
        return [`${an(h.one)} dodges flying ${j.many} in ${s.text}`, [noun(h, 'hero'), noun(j, 'any')], s]; },
      (p) => { const h = p(HEROES, 'h'), e = p(ENEMIES, 'e'), s = p(SETTINGS, 's');
        return [`survive as long as you can as ${an(h.one)} dodging ${e.many} in ${s.text}`, [noun(h, 'hero'), noun(e, 'role')], s]; },
    ],
  },
  {
    id: 'match', count: 10, verb: verb('match', []),
    templates: [
      (p) => { const i = p(PUZZLE_ITEMS, 'i'), s = p(SETTINGS, 's');
        return [`match three ${i.many} in ${s.text}`, [noun(i, 'any')], s]; },
      (p) => { const i = p(PUZZLE_ITEMS, 'i'), b = p(CONTAINERS, 'b');
        return [`sort the ${i.many} into the right ${b.many}`, [noun(i, 'any'), noun(b, 'any')], null]; },
    ],
  },
  {
    id: 'build', count: 10, verb: verb('build', []),
    templates: [
      (p) => { const b = p(BUILDINGS, 'b'), m = p(MATERIALS, 'm'), s = p(SETTINGS, 's');
        return [`build ${an(b.one)} out of ${m.many} in ${s.text}`, [noun(b, 'any'), noun(m, 'any')], s]; },
      (p) => { const h = p(HEROES, 'h'), b = p(BUILDINGS, 'b'), s = p(SETTINGS, 's');
        return [`${an(h.one)} builds ${an(b.one)} at ${s.text}`, [noun(h, 'hero'), noun(b, 'any')], s]; },
    ],
  },
  {
    id: 'calm', count: 33, verb: null,
    templates: [
      (p) => { const h = p(HEROES, 'h'), t = p(CALM_THINGS, 't'), s = p(SETTINGS, 's');
        return [`${an(h.one)} makes ${an(t.one)} in ${s.text}`, [noun(h, 'any'), noun(t, 'any')], s, verb('make', [])]; },
      (p) => { const h = p(HEROES, 'h'), s = p(SETTINGS, 's');
        return [`teach my ${h.one} how to meditate in ${s.text}`, [noun(h, 'any')], s, verb('meditate', [])]; },
      (p) => { const h = p(HEROES, 'h'), t = p(CALM_THINGS, 't');
        return [`a relaxing afternoon where ${an(h.one)} paints ${an(t.one)}`, [noun(h, 'any'), noun(t, 'any')], null, verb('paint', [])]; },
      (p) => { const h = p(HEROES, 'h'), s = p(SETTINGS, 's');
        return [`${an(h.one)} does homework in ${s.text}`, [noun(h, 'any')], s, verb('do homework', [])]; },
      (p) => { const h = p(HEROES, 'h'), t = p(CALM_THINGS, 't'), s = p(SETTINGS, 's');
        return [`I want a game where ${an(h.one)} sells ${t.many} in ${s.text}`, [noun(h, 'any'), noun(t, 'any')], s, verb('sell', [])]; },
      (p) => { const h = p(HEROES, 'h'), s = p(SETTINGS, 's');
        return [`my ${h.one} throws a surprise party in ${s.text}`, [noun(h, 'any')], s, verb('throw a party', [])]; },
    ],
  },
];

// ------------------------------------------------------------------ skládání

function sentenceOf(family, index, salt) {
  const pick = (list, slot) => list[fnv1a(`${family.id}:${index}:${slot}:${salt}`) % list.length];
  const template = family.templates[fnv1a(`${family.id}:${index}:template:${salt}`) % family.templates.length];
  const [text, nouns, setting, ownVerb] = template(pick);
  const checklist = nouns.map(({ entry, slot }) => ({ item: entry.one, slot, match: entry.match }));
  if (setting !== null) checklist.push({ item: setting.text.replace(/^(?:an?|the) /, ''), slot: 'setting', match: setting.match });
  const verbEntry = ownVerb ?? family.verb;
  checklist.push(verbEntry);
  return { text, family: family.id, verb: verbEntry.item, checklist };
}

/**
 * Všechny trénovací věty bez překryvu se sadami a bez duplikátů. Rodiny jsou
 * v souboru proložené podle poměrné pozice, takže i přerušený sběr má mix sloves.
 */
export function generateSentences(heldOut = heldOutTexts()) {
  const taken = new Set(heldOut.map(normalize));
  const out = [];
  for (const family of FAMILIES) {
    for (let index = 0; index < family.count; index += 1) {
      let sentence;
      for (let salt = 0; ; salt += 1) {
        sentence = sentenceOf(family, index, salt);
        if (!taken.has(normalize(sentence.text))) break;
      }
      taken.add(normalize(sentence.text));
      out.push({ at: (index + 0.5) / family.count, sentence });
    }
  }
  return out.sort((a, b) => a.at - b.at).map(({ sentence }, index) => ({ id: `t${String(index + 1).padStart(3, '0')}`, ...sentence }));
}

export const sentencesJsonl = (sentences) => `${sentences.map((sentence) => JSON.stringify(sentence)).join('\n')}\n`;

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const sentences = generateSentences();
  mkdirSync(dirname(SENTENCES_PATH), { recursive: true });
  writeFileSync(SENTENCES_PATH, sentencesJsonl(sentences));
  const byFamily = Object.fromEntries(FAMILIES.map((family) => [family.id, sentences.filter((s) => s.family === family.id).length]));
  console.log(`${String(sentences.length)} sentences -> ${SENTENCES_PATH}`, JSON.stringify(byFamily));
}
