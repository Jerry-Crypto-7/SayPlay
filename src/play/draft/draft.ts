/**
 * Okamžitý návrh ze slov (P23-B T2): věta → `GameSpecV1`, vždy, za milisekundy.
 *
 * Model (`src/play/director`) potom návrh **opravuje**, ne píše od nuly –
 * proto musí být návrh vždy validní. Postup: lexikon dá archetyp, čísla a
 * role; šablonou je fixtura téhož archetypu (`src/play/__fixtures__`), ve
 * které se přepíší popisky rolí, počty a sekundy. ID rolí se z fixtury
 * nemění, takže odkazy v `mechanics` i `verification` zůstávají platné a
 * jen se posunou počty v keypointech (`collected: 4 → N − 1`).
 *
 * Kdyby výsledek přesto neprošel `readGameSpec`, funkce spadne na fixturu
 * archetypu s přepsaným `title` a `fellBack: true` – test nad zlatým korpusem
 * drží, že se to nestane ani jednou. Jediný losovač je `pure-rand`: vybírá
 * výchozí popisek hráče, když ho věta nedává; stejný seed = stejné bajty.
 */

import { uniformInt } from 'pure-rand/distribution/uniformInt';
import { xoroshiro128plus } from 'pure-rand/generator/xoroshiro128plus';

import { CAPABILITIES } from '../capabilities';
import { ARCHETYPE_IDS, type ArchetypeId } from '../registry';
import { readGameSpec, type ControlId, type GameSpecV1 } from '../spec';
import chaseEscape from '../__fixtures__/chase_escape.json';
import checkpointRace from '../__fixtures__/checkpoint_race.json';
import collectExit from '../__fixtures__/collect_exit.json';
import combatLite from '../__fixtures__/combat_lite.json';
import delivery from '../__fixtures__/delivery.json';
import deliveryOrders from '../__fixtures__/delivery_orders.json';
import hazardCrossing from '../__fixtures__/hazard_crossing.json';
import survivalTimer from '../__fixtures__/survival_timer.json';
import switchPuzzle from '../__fixtures__/switch_puzzle.json';

import duelTemplate from '../arcade/__fixtures__/duel.json';
import flapTemplate from '../arcade/__fixtures__/flap.json';
import platformTemplate from '../arcade/__fixtures__/platform.json';
import rhythmTemplate from '../arcade/__fixtures__/rhythm.json';
import runnerTemplate from '../arcade/__fixtures__/runner.json';
import arenaTemplate from '../arcade/__fixtures__/arena.json';
import shooterTemplate from '../arcade/__fixtures__/shooter.json';
import steerTemplate from '../arcade/__fixtures__/steer.json';
import throwTemplate from '../arcade/__fixtures__/throw.json';
import timingTemplate from '../arcade/__fixtures__/timing.json';
import type { Reading } from '../read/schema';
import { type GenreChoice, type GenreModules, type GenreRanking, classifyGenre } from '../genre/classify';
import {
  CAST_MAX,
  COUNT_PARAMS,
  COUNT_ROLES as GENRE_COUNT_ROLES,
  FOE_DOES,
  type CastItem,
  type CastRole,
  type CountRole,
  type GenreId,
  type GenreModule,
  type GenreSpec,
} from '../genre/contract';
import { familyOf, heroActionOf } from '../genre/families';
import { GENRE_MODULES, compileWith, readGenreSpec } from '../genre/index';
import { wholeGame } from '../compose/assemble';
import { compose, type Composition } from '../compose/compose';
import { compileRecipe } from '../compose/compile';
import { PRESETS } from '../compose/presets';
import { extractIntent } from '../intent/extract';
import type { Intent } from '../intent/contract';
import { defaultCollectible, defaultFoe, defaultHero, defaultTarget, heroFits } from '../genre/roles';
import { AMMO_VERB } from '../genre/throw';
import { lookFor, lookWords, sentenceSky } from '../arcade/look';
import { modelOf } from '../arcade/models';
import { steerStyleFor } from '../arcade/pieces/steer';
import { THROW_GOAL_LABELS } from '../arcade/pieces/throw';

import { abilityHint, type ControlChoice, type ControlPick, nearestControl, pickControl, saidAbilities } from './controls';
import { type Twist, isPerson, isScenery, twistGoal, twistOf } from './twist';
import {
  CARE,
  FOOD,
  FOODS,
  GENTLE,
  KID_FRIENDLY,
  LILY_PADS,
  ORDER_PUZZLE,
  ORDERS,
  PUSH_CRATES,
  MOVING_WALLS,
  RED_LIGHT,
  ROAD,
  SEARCH,
  SMASH,
  UNDERWATER,
  WATCHER,
  NUMBER_WORDS,
  nounPhrase,
  plural,
  readCountedNouns,
  readLives,
  readNumbers,
  readRoles,
  readTargetScore,
  scoreArchetypes,
  singular,
  type SentenceRoles,
  toolsOf,
  withoutPossessor,
} from './lexicon';

const TEMPLATES: Readonly<Record<ArchetypeId, unknown>> = {
  collect_exit: collectExit,
  chase_escape: chaseEscape,
  survival_timer: survivalTimer,
  checkpoint_race: checkpointRace,
  delivery,
  switch_puzzle: switchPuzzle,
  hazard_crossing: hazardCrossing,
  combat_lite: combatLite,
};

const PLAYER_LABELS = ['explorer', 'robot', 'fox', 'kid', 'raccoon', 'astronaut', 'knight', 'penguin'] as const;

export interface DraftMeta {
  readonly intent?: Intent;
  readonly composition?: Composition;
  readonly spec: GameSpecV1;
  readonly archetype: ArchetypeId;
  readonly scores: Readonly<Record<ArchetypeId, number>>;
  /** Návrh neprošel `readGameSpec` a vrátila se fixtura archetypu. Korpus drží nulu. */
  readonly fellBack: boolean;
  /** Kdo větu přečetl: lokální model (`src/play/read`), nebo klíčová slova lexikonu. */
  readonly readBy: 'model' | 'keywords';
  /** `GenreSpec`, ze kterého hra vznikla (P32B T2); `null` na staré cestě mřížky. Oprava režiséra ho bere jako poslední zálohu. */
  readonly genre: GenreSpec | null;
  /** Proč klasifikátor vybral žánr („main verb "light", cue "light"“) – pro panel čtení. */
  readonly genreWhy: string | null;
}

export interface DraftOptions {
  /** Čtení věty lokálním modelem (P29B T4); `null` nebo chybí = jen klíčová slova. */
  readonly reading?: Reading | null;
  /** Moduly žánrů; testy sem dávají dvojníky (`genre/__tests__/doubles.ts`). */
  readonly modules?: GenreModules;
}

/** Slovo čtení bez členu: „a haunted castle“ → „haunted castle“; prázdné → `null`. */
function bare(phrase: string | null): string | null {
  const text = phrase?.toLowerCase().replace(/^(?:(?:a|an|the|some|my|your)\s+)+/, '').trim() ?? '';
  return text === '' ? null : text;
}

/** Hrdina, kterého čtečka píše, když věta žádného nemá; klíčová slova pak mají přednost. */
const GENERIC_HERO = /^(?:player|you|me|i|character|hero|protagonist|user|person)$/;

/**
 * Role věty ze čtení, doplněné klíčovými slovy (P29B T4): co čtení jmenuje,
 * přebije lexikon, zbytek (spínače, brány, plížení…) zůstane z `readRoles`.
 */
function rolesFrom(sentence: string, reading: Reading | null): SentenceRoles {
  const roles = readRoles(sentence);
  if (reading === null) return roles;
  const noun = (kind: Reading['roles'][number]['kind']) => {
    const found = reading.roles.find((entry) => entry.kind === kind);
    return found === undefined ? null : bare(found.noun);
  };
  const hero = bare(reading.hero);
  const collectible = noun('collectible');
  const chaser = noun('chaser');
  const threat = noun('threat');
  return {
    ...roles,
    player: hero !== null && !GENERIC_HERO.test(hero) ? hero : roles.player,
    chaser: chaser ?? roles.chaser,
    collectible: collectible === null ? roles.collectible : singular(collectible),
    collectibleMany: collectible === null ? roles.collectibleMany : singular(collectible) !== collectible,
    item: noun('item') ?? roles.item,
    destination: noun('destination') ?? roles.destination,
    target: noun('target') === null ? roles.target : singular(noun('target')!),
    hazard: noun('hazard') ?? roles.hazard,
    threat:
      chaser !== null
        ? { label: singular(chaser), mover: 'chaser', plural: singular(chaser) !== chaser }
        : threat !== null
          ? { label: singular(threat), mover: 'patrol', plural: singular(threat) !== threat }
          : roles.threat,
    setting: bare(reading.setting) ?? roles.setting,
  };
}

/** Nejvyšší skóre; remíza jde pořadím `ARCHETYPE_IDS`, nic → `collect_exit`. */
export function pickArchetype(scores: Readonly<Record<ArchetypeId, number>>): ArchetypeId {
  let best: ArchetypeId = ARCHETYPE_IDS[0];
  for (const id of ARCHETYPE_IDS) if (scores[id] > scores[best]) best = id;
  return best;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

function template(archetype: ArchetypeId): GameSpecV1 {
  return JSON.parse(JSON.stringify(TEMPLATES[archetype])) as GameSpecV1;
}

function role(spec: GameSpecV1, id: string): GameSpecV1['roles'][number] {
  const found = spec.roles.find((entry) => entry.id === id);
  if (found === undefined) throw new Error(`template ${spec.archetype} has no role ${id}`);
  return found;
}

function mechanic(spec: GameSpecV1, id: string): Record<string, unknown> {
  const found = spec.mechanics.find((entry) => entry.id === id);
  if (found === undefined) throw new Error(`template ${spec.archetype} has no mechanic ${id}`);
  return found.params as Record<string, unknown>;
}

function titleCase(words: readonly string[]): string {
  return words.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
}

// Výplňová slova („game“, „a lot of“, „must“) dělala tituly jako „Jumping Arcade Game Lot“.
const TITLE_SKIP = new Set([
  'a', 'an', 'the', 'and', 'but', 'or', 'to', 'of', 'in', 'on', 'at', 'it', 'its', 'you', 'while', 'then', 'with', 'from',
  'through', 'across', 'before', 'make', 'something', 'game', 'games', 'lot', 'lots', 'many', 'some', 'very', 'really',
  'must', 'have', 'has', 'is', 'are', 'be', 'can', 'will', 'want', 'i', 'me', 'my', 'like', 'for', 'by', 'as', 'where',
  'that', 'who', 'please',
]);

/** Do čtyř nosných slov věty; bez nich titul fixtury. */
function titleFrom(sentence: string, fallback: string): string {
  const words = sentence
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter((word) => word !== '' && !TITLE_SKIP.has(word))
    .slice(0, 4);
  // P28D T3 (F-27): „Knight Rides Dragon Over“ – předložka na konci titul utne uprostřed myšlenky.
  while (words.length > 1 && TITLE_TAIL.has(words.at(-1)!)) words.pop();
  const title = words.length === 0 ? fallback : titleCase(words);
  return cap(title, 80);
}

const TITLE_TAIL = new Set([
  'over', 'under', 'into', 'onto', 'up', 'down', 'off', 'out', 'past', 'around', 'behind', 'between', 'toward', 'towards',
  'about', 'along', 'against', 'inside', 'beyond', 'near', 'without', 'after', 'until', 'so', 'if', 'because', 'just',
]);

/** Výchozí menu podle prostředí věty, když jídla nejmenuje (nebo jen jedno). */
const MENU_DEFAULTS: readonly (readonly [RegExp, readonly [string, string]])[] = [
  [/\bcoffee\b|\bbarista\b|\bcaf[eé]\b/, ['coffee', 'croissant']],
  [/\bsushi\b/, ['sushi', 'tea']],
  [/\bpizza\b/, ['pizza', 'soda']],
  [/\bsupermarket\b|\bshop\b|\bcheckout\b|\bcashier\b/, ['groceries', 'milk']],
  [/\bfarm\b|\bharvest\b|\bplant\b/, ['carrot', 'apple']],
];

/**
 * Objednávky (P25B T5): šablonou je fixtura `delivery_orders` – dva zákazníci,
 * dvě jídla, směna 90 s. Věta dá popisky jídel (co jmenuje, jinak výchozí
 * menu podle prostředí); ID rolí `burger`/`fries` zůstávají kvůli keypointům.
 */
function takeOrders(spec: GameSpecV1, read: Read): void {
  const orders = JSON.parse(JSON.stringify(deliveryOrders)) as GameSpecV1;
  const player = role(spec, 'player').label;
  spec.mechanics = orders.mechanics;
  spec.roles = orders.roles;
  spec.objective = orders.objective;
  spec.tutorial = orders.tutorial;
  spec.verification = orders.verification;
  role(spec, 'player').label = player;
  const named = FOODS.filter((food) => new RegExp(`\\b${food}s?\\b`).test(read.text));
  const fallback = MENU_DEFAULTS.find(([cue]) => cue.test(read.text))?.[1] ?? ['burger', 'fries'];
  const [first, second] = [...new Set([...named, ...fallback])];
  role(spec, 'burger').label = first;
  role(spec, 'fries').label = second;
  spec.objective.description = cap(`Serve every customer the ${first} or ${second} they ordered before the shift ends.`, 120);
}

/**
 * Vágní klidné věty (P25D T7): sběr zůstává (nic neútočí), jen téma je
 * klidné a barevné – bubliny, útulná zahrada, nebo duhová pro dítě.
 * Popisky, které věta jmenuje, mají přednost.
 */
function gentle(spec: GameSpecV1, read: Read): void {
  const [setting, item, exit, player, mood] = /\bbubbles?\b/.test(read.text)
    ? ['sunny meadow full of floating bubbles', 'bubble', 'rainbow arch', 'otter', 'relaxed']
    : KID_FRIENDLY.test(read.text)
      ? ['rainbow candy garden', 'rainbow star', 'rainbow arch', 'bunny', 'playful']
      : ['cozy cottage garden', 'warm cookie', 'cottage door', 'kitten', 'cozy'];
  if (read.roles.setting === null) spec.theme.setting = setting;
  spec.theme.mood = mood;
  if (read.roles.player === null) role(spec, 'player').label = player;
  if (read.roles.destination === null) role(spec, 'portal').label = exit;
  const collectible = role(spec, 'mushroom');
  if (read.roles.collectible === null) collectible.label = item;
  const count = collectible.count ?? 5;
  spec.objective.description = cap(`Gather ${spell(count)} ${plural(collectible.label, count)} at your own pace, then stroll to the ${role(spec, 'portal').label}.`, 120);
  spec.tutorial.goalLine = cap(`Gather ${count} ${plural(collectible.label, count)}, then reach the ${role(spec, 'portal').label}.`, 80);
  spec.tutorial.controlsHint = cap(`Tap ${withArticle(collectible.label)} to walk to it. Nothing here can hurt you.`, 80);
}

/** Keypoint přechodu: hráč postavený do nebezpečí prohraje (šablona dokazuje jen bezpečné „off“). */
function hazardLoses(spec: GameSpecV1, id: string): void {
  spec.verification.splice(1, 0, { id, kind: 'keypoint', mechanic: 'hazard_zone', setup: { placeAt: { player: 'lava' } }, ticks: 5, assert: { runState: 'lost' } });
}

/**
 * Lekníny (P25D T6, s034): voda nepulzuje – kdo šlápne mimo leknín, spadne.
 * Víc vody než lávy, aby se skákalo z leknínu na leknín.
 */
function hopPads(spec: GameSpecV1, read: Read): void {
  const water = role(spec, 'lava');
  water.label = 'deep water';
  water.count = 8;
  role(spec, 'stone').label = 'lily pad';
  role(spec, 'ledge').label = 'far bank';
  if (read.roles.player === null) role(spec, 'player').label = 'frog';
  delete mechanic(spec, 'hazard_zone').pulse;
  spec.theme = { setting: 'lily pond', mood: 'playful' };
  spec.objective.description = 'Hop across the pond from lily pad to lily pad without falling in.';
  spec.tutorial.goalLine = 'Reach the far bank. Step only on lily pads.';
  spec.tutorial.controlsHint = 'Tap a lily pad to hop onto it. Deep water sinks you.';
  // Stálá voda nemá stav `off`; bezpečné je stát na leknínu.
  spec.verification = spec.verification.filter((assertion) => assertion.id !== 'lava_off_is_safe');
  spec.verification.unshift({ id: 'lily_pad_is_safe', kind: 'keypoint', mechanic: 'hazard_zone', setup: { placeAt: { player: 'stone' } }, ticks: 20, assert: { runState: 'running' } });
  hazardLoses(spec, 'falling_in_loses');
}

/**
 * Silnice (P25D T6, s036): auta jako pohyblivé zdi z T3 – každé auto
 * přeskakuje mezi dvěma polohami (`pulse.alternate`), po sekundě.
 */
function crossRoad(spec: GameSpecV1, read: Read): void {
  const car = role(spec, 'lava');
  car.label = 'car';
  car.count = 6;
  role(spec, 'stone').label = 'safe strip';
  role(spec, 'ledge').label = 'other side';
  if (read.roles.player === null) role(spec, 'player').label = 'chicken';
  mechanic(spec, 'hazard_zone').pulse = { onSeconds: 1, offSeconds: 1, alternate: true };
  spec.theme = { setting: 'busy country road', mood: 'playful' };
  spec.objective.description = 'Cross the road to the other side without getting hit by a car.';
  spec.tutorial.goalLine = 'Reach the other side. Cars switch lanes every second.';
  spec.tutorial.controlsHint = 'Tap a safe strip to run to it. Never step where a car is.';
  hazardLoses(spec, 'hit_by_car_loses');
}

/**
 * Ošetřování (P25D T5): objednávky `carry.menu` stačí – nástroj (lék, obvaz)
 * je jídlo, pacient zákazník, správné ošetření přičte `orders_served`. Nové
 * pravidlo by jen zopakovalo „dones správnou věc správnému“.
 */
function treatPatients(spec: GameSpecV1, read: Read, patient: string | undefined): void {
  const noun = patient === undefined || /^pets?$/.test(patient) ? 'pet' : singular(patient.replace(/^puppies$/, 'puppy'));
  const sick = noun === 'patient' ? 'patient' : `sick ${noun}`;
  if (read.roles.player === null) role(spec, 'player').label = 'vet';
  role(spec, 'burger').label = 'medicine';
  role(spec, 'fries').label = 'bandage';
  role(spec, 'customer').label = sick;
  if (read.roles.setting === null) spec.theme.setting = 'cozy vet clinic';
  spec.theme.mood = 'cozy';
  spec.objective.description = cap(`Treat every ${sick}: bring each the medicine or bandage it needs before the clinic closes.`, 120);
  spec.tutorial.goalLine = cap(`Treat every ${sick} before the clinic closes.`, 80);
  spec.tutorial.controlsHint = cap(`Tap the medicine or bandage, then tap the ${sick} who needs it.`, 80);
}

/** Zkrátí na hranici slova (P28D T3, F-27): „Knight Rides Dragon Ov…“ ne. */
function cap(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > 0 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** „a key“, „an iron key“ – podle první hlásky, ne pravopisu (stačí na popisky rolí). */
function withArticle(noun: string): string {
  return `${/^[aeiou]/i.test(noun) ? 'an' : 'a'} ${noun}`;
}

function label(text: string | null, fallback: string): string {
  return cap(text ?? fallback, 60);
}

/** Číslo se čte slovem, pokud je do dvanácti – tak to píše i balíček. */
function spell(n: number): string {
  const words = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];
  return n < words.length ? words[n] : String(n);
}

function rewriteCounters(spec: GameSpecV1, counter: string, before: number, after: number): void {
  for (const assertion of spec.verification) {
    const setup = assertion.setup?.counters;
    if (setup !== undefined && setup[counter] !== undefined) setup[counter] = before;
    const expected = assertion.assert.counters;
    if (expected !== undefined && expected[counter] !== undefined) expected[counter] = after;
  }
}

/**
 * Nepřítel ve sběru (nález P24: „…while dodging ghosts“ duchy zahodil).
 * Vyhýbání dá hlídku (dva kusy pro množné číslo), lov pronásledovatele;
 * dotyk prohraje. Keypoint dokazuje právě dotyk: nepřítel postavený na hráče.
 */
function addThreat(spec: GameSpecV1, threat: NonNullable<SentenceRoles['threat']>, text: string): void {
  const count = threat.mover === 'patrol' && threat.plural ? 2 : 1;
  spec.roles.push({ id: 'enemy', kind: threat.mover, label: label(threat.label, 'ghost'), count });
  if (threat.mover === 'chaser') {
    const speed = /\b(fast|quick|speedy)\b/.test(text) ? 'fast' : /\b(slow|sluggish)\b/.test(text) ? 'slow' : 'normal';
    spec.mechanics.push({ id: 'chaser', params: { role: 'enemy', speed, catchEffect: 'lose' } });
    // Pravidlo pohybu na každou buňku mřížky – strop fixtury (120) by nestačil.
    spec.budgets.maxRules = 200;
  } else {
    spec.mechanics.push({ id: 'patrol', params: { role: 'enemy', disposition: 'bold', stops: 3, touchEffect: 'lose' } });
  }
  const enemies = plural(threat.label, count);
  spec.tutorial.goalLine = cap(`${spec.tutorial.goalLine} Avoid the ${enemies}.`, 80);
  spec.verification.splice(1, 0, {
    id: 'enemy_touch_loses',
    kind: 'keypoint',
    mechanic: threat.mover,
    setup: { placeAt: { enemy: 'player' } },
    ticks: 5,
    assert: { runState: 'lost' },
  });
}

/**
 * Plížení (P25B T3): stráže jsou hlídky s výhledem (`patrol.sight`) – kdo
 * stojí na úseku, který stráž právě jde, prohraje. Světla a kamery z věty
 * („avoid the flashlights“) nesou stráže, proto popisek `guard`.
 */
function addGuards(spec: GameSpecV1, threat: SentenceRoles['threat']): void {
  const named = threat !== null && !/light|camera|laser/.test(threat.label) ? threat.label : 'guard';
  const count = threat?.plural === true || named === 'guard' ? 2 : 1;
  spec.roles.push({ id: 'enemy', kind: 'patrol', label: label(named, 'guard'), count });
  spec.mechanics.push({ id: 'patrol', params: { role: 'enemy', disposition: 'bold', stops: 3, touchEffect: 'lose', sight: true } });
  const guards = plural(named, count);
  spec.tutorial.goalLine = cap(`${spec.tutorial.goalLine} Stay off the ${guards}${count > 1 ? "'" : "'s"} paths.`, 80);
  spec.verification.splice(1, 0, {
    id: 'spotted_loses',
    kind: 'keypoint',
    mechanic: 'patrol',
    setup: { placeAt: { player: 'enemy' } },
    ticks: 3,
    assert: { runState: 'lost' },
  });
}

/**
 * Červená–zelená (P25D T1): sběr a cíl zůstávají, přibude světlo (`timer.phases`)
 * a hlídač, který se v červené dívá. Squid Game dá kuličky a cílovou čáru,
 * horor baterky, dveře ven a strašidelného hlídače – pravidlo je totéž.
 */
function redLightLabels(spec: GameSpecV1, read: Read): void {
  const squid = /\bred light\b|\bgreen light\b|\bsquid games?\b/.test(read.text);
  const named = WATCHER.exec(read.text)?.[1];
  const watcher = named ?? (squid ? 'giant doll' : /\bfreddy|\bfnaf\b/.test(read.text) ? 'animatronic bear' : 'creepy doll');
  spec.roles.push({ id: 'watcher', kind: 'prop', label: label(watcher, 'giant doll'), count: 1 });
  if (read.roles.collectible === null) role(spec, 'mushroom').label = squid ? 'marble' : 'flashlight battery';
  role(spec, 'portal').label = squid ? 'finish line' : 'exit door';
  spec.theme.mood = 'tense';
}

function addRedLight(spec: GameSpecV1): void {
  const watcher = role(spec, 'watcher').label;
  spec.mechanics.push({ id: 'timer', params: { id: 'light', seconds: 120, onEnd: 'lose', phases: { goSeconds: 4, stopSeconds: 2, watcher: 'watcher' } } });
  spec.objective.description = cap(`${spec.objective.description} Freeze whenever the ${watcher} looks.`, 120);
  spec.tutorial.goalLine = cap(`${spec.tutorial.goalLine} Freeze when the ${watcher} looks.`, 80);
  spec.tutorial.controlsHint = cap(`Tap to walk. Stand still while the ${watcher} watches.`, 80);
  const red = { flags: { light_red: true } };
  spec.verification.splice(
    1,
    0,
    { id: 'moving_on_red_loses', kind: 'keypoint', mechanic: 'timer', setup: red, actions: [{ actionId: 'moveTo', target: 'portal' }], ticks: 6, assert: { runState: 'lost' } },
    { id: 'standing_on_red_is_safe', kind: 'keypoint', mechanic: 'timer', setup: red, ticks: 30, assert: { runState: 'running' } },
  );
}

/**
 * Hledání (P25D T2): předměty čekají ve skrýších (o dvě víc, dvě zůstanou
 * prázdné) a ukážou se, až do skrýše hráč vstoupí. Pod vodou relikvie
 * v troskách a cíl je vyplavat na hladinu.
 */
function searchLabels(spec: GameSpecV1, read: Read): boolean {
  const sea = UNDERWATER.test(read.text);
  if (read.roles.collectible === null) role(spec, 'mushroom').label = sea ? 'relic' : 'hidden toy';
  if (read.roles.destination === null) role(spec, 'portal').label = sea ? 'surface' : 'door';
  if (read.roles.player === null && /\bsubmarine\b/.test(read.text)) role(spec, 'player').label = 'little submarine';
  if (sea && read.roles.setting === null) spec.theme.setting = 'sunken ruins on the sea floor';
  spec.theme.mood = 'curious';
  return sea;
}

function addHidden(spec: GameSpecV1, count: number, sea: boolean): void {
  const spot = sea ? 'wreckage' : 'hiding spot';
  spec.roles.push({ id: 'spot', kind: 'prop', label: spot, count: clamp(count + 2, 1, 20) });
  mechanic(spec, 'collectible').hiddenIn = 'spot';
  const item = role(spec, 'mushroom').label;
  spec.objective.description = cap(`Search every ${spot} for ${spell(count)} ${plural(item, count)}, then reach the ${role(spec, 'portal').label}.`, 120);
  spec.tutorial.goalLine = cap(`Find ${count} hidden ${plural(item, count)}, then reach the exit.`, 80);
  spec.tutorial.controlsHint = cap(`Tap ${withArticle(spot)} to search it. Tap what you find to pick it up.`, 80);
  // Počítací keypoint šablony sbírá první předmět – ten leží v první skrýši.
  for (const assertion of spec.verification) {
    if (assertion.mechanic === 'collectible' && assertion.actions !== undefined) assertion.actions = [{ actionId: 'moveTo', target: 'spot' }, ...assertion.actions];
  }
  spec.verification.splice(1, 0, {
    id: 'hidden_item_does_not_count',
    kind: 'keypoint',
    mechanic: 'collectible',
    actions: [{ actionId: 'pickup', target: 'mushroom' }],
    ticks: 10,
    assert: { counters: { collected: 0 } },
  });
}

/**
 * Pohyblivé zdi (P25D T3): dvě zdi, každá přeskakuje mezi dvěma polohami
 * (`hazard_zone.pulse.alternate`). Vstup do polohy, kde zeď stojí, prohraje.
 */
function addMovingWalls(spec: GameSpecV1): void {
  spec.roles.push({ id: 'wall', kind: 'hazard', label: 'moving wall', count: 4 });
  spec.mechanics.push({ id: 'hazard_zone', params: { role: 'wall', effect: 'lose', pulse: { onSeconds: 2, offSeconds: 2, alternate: true } } });
  spec.theme.mood = 'tense';
  spec.tutorial.controlsHint = cap('Tap to walk. Never step where a wall stands; walls shift every 2 s.', 80);
  spec.verification.splice(
    1,
    0,
    { id: 'standing_wall_loses', kind: 'keypoint', mechanic: 'hazard_zone', setup: { placeAt: { player: 'wall' } }, ticks: 5, assert: { runState: 'lost' } },
    {
      id: 'moved_wall_is_safe',
      kind: 'keypoint',
      mechanic: 'hazard_zone',
      setup: { placeAt: { player: 'wall' }, entityStates: { wall: 'off' } },
      ticks: 20,
      assert: { runState: 'running' },
    },
  );
}

interface Read {
  readonly roles: SentenceRoles;
  readonly seconds: number | null;
  readonly counts: readonly number[];
  readonly playerLabel: string;
  readonly text: string;
}

const FILLERS: Record<ArchetypeId, (spec: GameSpecV1, read: Read) => void> = {
  collect_exit(spec, read) {
    // Kořist plížení bývá jedna („steal a diamond“), sbírání pět.
    const redLight = RED_LIGHT.test(read.text);
    if (redLight) redLightLabels(spec, read);
    // Plížení se skrýšemi svědek necertifikuje (s149 „hide and seek“ padal) – plížení má přednost.
    const search = !redLight && !read.roles.stealth && SEARCH.test(read.text);
    const sea = search && searchLabels(spec, read);
    const count = clamp(read.counts[0] ?? (read.roles.stealth ? (read.roles.collectibleMany ? 3 : 1) : redLight ? 3 : 5), 1, 20);
    const item = role(spec, 'mushroom');
    item.label = label(read.roles.collectible, item.label);
    item.count = count;
    mechanic(spec, 'collectible').count = count;
    spec.objective.count = count;
    spec.objective.description = cap(`Collect ${spell(count)} ${plural(item.label, count)}, then reach the ${role(spec, 'portal').label}.`, 120);
    rewriteCounters(spec, 'collected', count - 1, count);
    spec.tutorial.goalLine = cap(`Collect ${count} ${plural(item.label, count)}, then reach the exit.`, 80);
    spec.tutorial.controlsHint = cap(`Tap ${withArticle(item.label)} to walk to it. Tap again to pick it up.`, 80);
    if (search) addHidden(spec, count, sea);
    else if (!redLight && !read.roles.stealth && read.roles.threat === null && (GENTLE.test(read.text) || KID_FRIENDLY.test(read.text))) gentle(spec, read);
    if (MOVING_WALLS.test(read.text)) addMovingWalls(spec);
    if (redLight) addRedLight(spec);
    else if (read.roles.stealth) addGuards(spec, read.roles.threat);
    else if (read.roles.threat !== null) addThreat(spec, read.roles.threat, read.text);
  },
  chase_escape(spec, read) {
    // Id `roomba` drží fixtura (hashe); popisek „giant Roomba“ nová hra nedědí – bez pronásledovatele ve větě ho dá místo (P32B T3).
    // „escapes a haunted castle“: místo, odkud se utíká, pronásledovatel není.
    const chaser = role(spec, 'roomba');
    chaser.label = label(foeIn(read.roles.chaser), defaultFoe(spec.theme.setting, 'arena').label);
    const speed = /\b(fast|quick|speedy|twice as fast)\b/.test(read.text) ? 'fast' : /\b(slow|sluggish)\b/.test(read.text) ? 'slow' : 'normal';
    mechanic(spec, 'chaser').speed = speed;
    spec.objective.description = cap(`Reach the exit before the ${chaser.label} catches you.`, 120);
    spec.tutorial.goalLine = cap(`Escape through the exit. The ${chaser.label} hunts you.`, 80);
    spec.tutorial.controlsHint = cap(`Tap where to run. Use a cart to stun the ${chaser.label}.`, 80);
  },
  survival_timer(spec, read) {
    const seconds = clamp(read.seconds ?? 60, 5, 180);
    mechanic(spec, 'timer').seconds = seconds;
    spec.objective.seconds = seconds;
    spec.targetDurationSec = clamp(seconds, 30, 180);
    const hazard = role(spec, 'tile');
    hazard.label = label(read.roles.hazard === null ? null : singular(read.roles.hazard), hazard.label);
    spec.objective.description = cap(`Survive ${seconds} seconds while ${plural(hazard.label, 2)} pulse.`, 120);
    spec.tutorial.goalLine = cap(`Stay off the ${plural(hazard.label, 2)} for ${seconds} seconds.`, 80);
  },
  checkpoint_race(spec, read) {
    const count = clamp(read.counts[0] ?? 5, 2, 8);
    const gate = role(spec, 'gate');
    gate.label = label(read.roles.checkpoint, gate.label);
    gate.count = count;
    mechanic(spec, 'checkpoint').count = count;
    mechanic(spec, 'checkpoint').ordered = !/\bany order\b/.test(read.text);
    spec.objective.count = count;
    const seconds = clamp(read.seconds ?? 90, 1, 180);
    mechanic(spec, 'timer').seconds = seconds;
    spec.targetDurationSec = clamp(seconds, 30, 180);
    spec.objective.description = cap(`Pass ${spell(count)} ${plural(gate.label, count)} in order.`, 120);
    spec.tutorial.goalLine = cap(`Pass all ${count} ${plural(gate.label, count)} in order before time runs out.`, 80);
    spec.tutorial.controlsHint = cap(`Tap the next ${gate.label} to race to it.`, 80);
  },
  delivery(spec, read) {
    // „Carry/deliver X to Y“ je nesení do cíle, i v kuchyni nebo s pizzou.
    const care = CARE.exec(read.text);
    if (care !== null) {
      takeOrders(spec, read);
      treatPatients(spec, read, care[1]);
      return;
    }
    if (read.roles.destination === null && (ORDERS.test(read.text) || FOOD.test(read.text))) {
      takeOrders(spec, read);
      return;
    }
    const item = role(spec, 'cake');
    const destination = role(spec, 'table');
    item.label = label(read.roles.item, item.label);
    destination.label = label(read.roles.destination, destination.label);
    mechanic(spec, 'carry').fragile = /\b(fragile|egg|glass|cake|vase|without (?:breaking|dropping|cracking|spilling))\b/.test(read.text);
    spec.objective.description = cap(`Carry the ${item.label} to the ${destination.label}.`, 120);
    spec.tutorial.goalLine = cap(`Bring the ${item.label} to the ${destination.label}.`, 80);
    spec.tutorial.controlsHint = cap(`Tap the ${item.label}, pick it up, then tap the ${destination.label}.`, 80);
  },
  switch_puzzle(spec, read) {
    const switches = read.roles.switches;
    if (switches !== null) {
      const ids = switches.all.slice(0, 6);
      const keep = spec.roles.filter((entry) => entry.kind !== 'switch');
      spec.roles = [...keep, ...ids.map((colour) => ({ id: colour, kind: 'switch' as const, label: `${colour} button`, count: 1 }))];
      const params = mechanic(spec, 'switch');
      params.switchRoles = ids;
      params.required = switches.required.filter((colour) => ids.includes(colour)).slice(0, 6);
      const required = params.required as string[];
      const wrong = ids.find((colour) => !required.includes(colour));
      spec.verification = spec.verification.filter((assertion) => assertion.mechanic !== 'switch');
      spec.verification.unshift({
        id: 'right_combination_opens',
        kind: 'keypoint',
        mechanic: 'switch',
        setup: { entityStates: Object.fromEntries(required.slice(0, -1).map((colour) => [colour, 'on'])) },
        actions: [{ actionId: 'use', target: required[required.length - 1] }],
        assert: { locked: { door: false } },
      });
      if (wrong !== undefined) {
        spec.verification.splice(1, 0, {
          id: 'wrong_switch_blocks',
          kind: 'keypoint',
          mechanic: 'switch',
          setup: { entityStates: Object.fromEntries(required.map((colour) => [colour, 'on'])) },
          actions: [{ actionId: 'use', target: wrong }],
          assert: { locked: { door: true } },
        });
      }
      const not = ids.filter((colour) => !required.includes(colour));
      spec.objective.description = cap(`Press ${required.join(' and ')}${not.length > 0 ? `, but not ${not.join(' or ')},` : ''} to open the door.`, 120);
    }
    spec.tutorial.goalLine = cap('Open the door with the right switches.', 80);
    // P25B T4: „in the right order“ – žádané spínače jdou jen v pořadí `required`.
    if (ORDER_PUZZLE.test(read.text)) {
      const params = mechanic(spec, 'switch');
      params.ordered = true;
      const required = params.required as string[];
      if (required.length >= 2) {
        // Tři a víc: první svítí, stisk třetího ho zhasne. Dva: stisk druhého nic nerozsvítí.
        const skipped = required.length >= 3 ? required[0] : required[1];
        spec.verification.splice(1, 0, {
          id: 'wrong_order_resets',
          kind: 'keypoint',
          mechanic: 'switch',
          setup: { entityStates: required.length >= 3 ? { [required[0]]: 'on' } : {} },
          actions: [{ actionId: 'use', target: required[required.length - 1] }],
          assert: { entityStates: { [skipped]: 'off' }, locked: { door: true } },
        });
      }
      spec.objective.description = cap(`Press ${required.join(', then ')} in that order to open the door.`, 120);
      spec.tutorial.goalLine = cap('Open the door by pressing the switches in the right order.', 80);
    }
    // P25B T4: „push boxes onto switches“ – na každou žádanou desku jedna bedna.
    const crate = PUSH_CRATES.exec(read.text);
    if (crate !== null) {
      const params = mechanic(spec, 'switch');
      const required = params.required as string[];
      const noun = singular(crate[1]);
      spec.roles.push({ id: 'box', kind: 'prop', label: noun, count: required.length });
      params.crateRole = 'box';
      // Stisk desky s bednou nic nedělá – keypointy „stiskni poslední“ nahradí příjezd bedny.
      spec.verification = spec.verification.filter((assertion) => !['red_blue_opens', 'right_combination_opens'].includes(assertion.id));
      spec.verification.unshift({
        id: 'crate_opens',
        kind: 'keypoint',
        mechanic: 'switch',
        setup: { entityStates: Object.fromEntries(required.slice(1).map((plate) => [plate, 'on'])) },
        actions: Array.from({ length: 3 }, () => ({ actionId: 'use' as const, target: 'box' })),
        ticks: 40,
        assert: { locked: { door: false } },
      });
      spec.objective.description = cap(`Push ${withArticle(noun)} onto each plate to open the door.`, 120);
      spec.tutorial.goalLine = cap(`Push ${withArticle(noun)} onto every plate to open the door.`, 80);
      spec.tutorial.controlsHint = cap(`Tap ${withArticle(noun)} to push it one step toward its plate.`, 80);
    }
  },
  hazard_crossing(spec, read) {
    const hazard = role(spec, 'lava');
    hazard.label = label(read.roles.hazard === null ? null : singular(read.roles.hazard), hazard.label);
    const stone = role(spec, 'stone');
    if (read.roles.checkpoint !== null && read.roles.checkpoint !== hazard.label) stone.label = label(read.roles.checkpoint, stone.label);
    spec.objective.description = cap(`Cross the ${hazard.label} field to the far side.`, 120);
    spec.tutorial.goalLine = cap(`Reach the far side. The ${hazard.label} pulses.`, 80);
    spec.tutorial.controlsHint = cap(`Tap ${withArticle(stone.label)} when the ${hazard.label} is calm.`, 80);
    if (ROAD.test(read.text)) crossRoad(spec, read);
    else if (LILY_PADS.test(read.text)) hopPads(spec, read);
  },
  combat_lite(spec, read) {
    const count = clamp(read.counts[0] ?? 5, 1, 12);
    const target = role(spec, 'slime');
    target.label = label(read.roles.target, target.label);
    target.count = count;
    mechanic(spec, 'defeat').count = count;
    spec.objective.count = count;
    spec.objective.description = cap(`Knock out all ${spell(count)} ${plural(target.label, count)}.`, 120);
    rewriteCounters(spec, 'defeated', count - 1, count);
    spec.tutorial.goalLine = cap(`Knock out all ${count} ${plural(target.label, count)}.`, 80);
    spec.tutorial.controlsHint = cap(`Tap ${withArticle(target.label)} to approach, tap again to hit it.`, 80);
    const smash = SMASH.exec(read.text);
    if (smash !== null) smashing(spec, read, count, smash[1] !== undefined);
  },
};

/**
 * Ničení a pukání (P25D T4): tentýž `defeat`, ale nic neútočí – bez zdraví,
 * cíle jsou věci. „Everything / stuff“ není popisek, dostane téma.
 */
function smashing(spec: GameSpecV1, read: Read, count: number, pop: boolean): void {
  const target = role(spec, 'slime');
  if (read.roles.target === null || /^(?:everything|stuff|things|all)$/.test(read.roles.target)) target.label = pop ? 'bubble' : 'vase';
  spec.mechanics = spec.mechanics.filter((candidate) => candidate.id !== 'health');
  const verb = pop ? 'Pop' : 'Smash';
  spec.objective.description = cap(`${verb} all ${spell(count)} ${plural(target.label, count)}. The last one wins.`, 120);
  spec.tutorial.goalLine = cap(`${verb} all ${count} ${plural(target.label, count)}.`, 80);
  spec.tutorial.controlsHint = cap(`Tap ${withArticle(target.label)} to walk to it, tap again to ${verb.toLowerCase()} it.`, 80);
  spec.theme.mood = pop ? 'playful' : 'cartoon';
  if (pop && read.roles.setting === null) spec.theme.setting = 'sunny bubble meadow';
}

const ARCADE_TEMPLATES = {
  runner: runnerTemplate,
  platform: platformTemplate,
  flap: flapTemplate,
  steer: steerTemplate,
  move_free: arenaTemplate,
  shooter: shooterTemplate,
  throw: throwTemplate,
  timing: timingTemplate,
  rhythm: rhythmTemplate,
  duel: duelTemplate,
} as const;

// Sbíraná role šablony; závod sbírá turbo a souboj, střelnice ani hřiště hodu nic.
const COLLECTIBLE_ROLE: Readonly<Record<ControlChoice['control'], string | null>> = {
  runner: 'coin',
  platform: 'coin',
  flap: 'coin',
  steer: null,
  move_free: 'coin',
  shooter: null,
  throw: null,
  timing: 'block',
  rhythm: 'note',
  duel: null,
};

// Texty načasování podle režimu; šablona je `stack`.
const TIMING_TEXT = {
  precision: {
    description: 'Stop the moving marker inside the target zone. Hit it eight times to win.',
    goalLine: 'Stop the marker in the target zone 8 times.',
    controlsHint: 'Tap or Space to stop the marker.',
  },
  bridge: {
    description: 'Stop each plank over the gap. Lay eight to cross.',
    goalLine: 'Stop each plank over the gap. Lay 8 to cross.',
    controlsHint: 'Tap or Space to drop the plank.',
  },
} as const;

// Počty z věty (P26D T9): podstatné jméno za číslem → id role šablony. Co sem
// nepatří (životy, sekundy, pruhy), se nepočítá; ostatní množné číslo jsou mince.
const COUNT_ROLES: readonly (readonly [RegExp, string])[] = [
  [/^(?:lives|hearts|seconds|minutes|levels|lanes|players|times|jumps|waves|shots|bullets)$/, ''],
  [/^(?:obstacles|hurdles|walls|barriers|rocks|cones|traps|rows|blocks|logs|boxes)$/, 'obstacle'],
  [/^targets$/, 'target'],
  [/^(?:enemies|zombies|aliens|robots|monsters|ghosts|invaders|ninjas|soldiers|bandits|pirates)$/, 'enemy'],
  [/./, 'coin'],
];

/** „five coins“ → role `coin` s počtem 5, jen u rolí, které šablona má (a generátor čte, `capabilities.ts` `counts`). */
function applySentenceCounts(spec: GameSpecV1, sentence: string, reading: Reading | null): void {
  if (!CAPABILITIES[spec.control ?? 'tap_go'].counts) return;
  // Počty čtení jdou až po klíčových slovech, takže je přebijí (P29B T4).
  const read = (reading?.roles ?? []).flatMap(({ kind, count }) => (count === null || READ_COUNT_ROLES[kind] === undefined ? [] : [{ count, id: READ_COUNT_ROLES[kind] }]));
  const counted = [...readCountedNouns(sentence).map(({ count, noun }) => ({ count, id: COUNT_ROLES.find(([pattern]) => pattern.test(noun))?.[1] ?? '' })), ...read];
  for (const { count, id } of counted) {
    const target = spec.roles.find((r) => r.id === id);
    if (target !== undefined) target.count = clamp(count, 1, 50);
  }
}

/** Druh role čtení → role arkády, jejíž počet generátor čte. */
const READ_COUNT_ROLES: Partial<Record<Reading['roles'][number]['kind'], string>> = { collectible: 'coin', obstacle: 'obstacle', hazard: 'obstacle', target: 'target', threat: 'enemy', chaser: 'enemy' };

const DUEL_VERB = /\b(?:box(?:es|ing)?|fights?|fighting|punch(?:es|ing)?|kick(?:s|ing)?|wrestl(?:es?|ing)|duel(?:s|ing)?|battl(?:es?|ing)|spar(?:s|ring)?)\s+(?:against\s+|with\s+)?(.+)/;
const FOE_STOP = /^(?:in|on|at|with|while|and|to|for|from|by|near|inside|under|until|who|that|but|before|after)$/;

/**
 * Soupeř souboje z věty (P27A T4), když ho `readRoles` nenajde: předmět slovesa
 * boje – „boxing a kangaroo in the outback“ → „kangaroo“, „fights a gang of
 * pigeons“ → „pigeons“. Nejvýš tři slova před předložkou nebo spojkou.
 */
function duelFoe(sentence: string): string | null {
  const rest = DUEL_VERB.exec(withoutPossessor(sentence.toLowerCase()))?.[1];
  if (rest === undefined) return null;
  const words = rest.replace(/^(?:a|an|the|my|your|some)\s+/, '').replace(/^(?:gang|group|horde|pack|bunch|team|army|swarm|flock) of\s+/, '').split(/[^a-z-]+/);
  const foe: string[] = [];
  for (const word of words) {
    if (word === '' || FOE_STOP.test(word) || foe.length === 3) break;
    foe.push(word);
  }
  // „boxing game“, „fighting match“: podstatné jméno žánru, ne soupeř.
  return foe.length === 0 || NOT_FOE.test(foe.at(-1)!) ? null : foe.join(' ');
}

const NOT_FOE = /^(?:game|games|match|matches|round|rounds|fight|fights|ring|time|arena|tournament|club|gym|simulator|championship)$/;

/** Slova až po předložku nebo spojku, nejvýš dvě. */
const leadWords = (rest: string): string | null => {
  const words: string[] = [];
  for (const word of rest.split(/[^a-z-]+/)) {
    if (word === '' || FOE_STOP.test(word) || words.length === 2) break;
    words.push(word);
  }
  return words.length === 0 ? null : words.join(' ');
};

/** „defend a castle from dragons“, „from waves of goblins“: od koho se brání, je nepřítel. */
const DEFEND_FROM = /\bdefend(?:s|ing)? (?:[a-z]+ ){0,3}?from (?:(?:waves|hordes|an army|armies|swarms) of )?(?:the |a |an )?([a-z][a-z -]*)/;
/** „zombie shooter“: slovo před žánrem jmenuje nepřítele – ne místo („space shooter“) ani styl („top-down shooter“). */
const SHOOTER_FOE = /\b([a-z-]+) shooter\b/;
const SHOOTER_STYLE = /^(?:top-down|twin-stick|side-scrolling|arcade|retro|pixel|person|bullet|looter|hero|tactical|online|simple|fun|cool|easy|hard|first|third|wave|endless|a|an|the)$/;

/** Nepřítel, kterého věta jmenuje bez slovesa útoku (P27A T5); `readRoles` ho nenajde. */
function namedFoe(sentence: string): string | null {
  const text = withoutPossessor(sentence.toLowerCase());
  const defended = DEFEND_FROM.exec(text)?.[1];
  const foe = defended === undefined ? null : leadWords(defended);
  if (foe !== null) return singular(foe);
  const genre = SHOOTER_FOE.exec(text)?.[1];
  return genre === undefined || SHOOTER_STYLE.test(genre) || isPlace(genre) ? null : singular(genre);
}

/**
 * „boat race“, „shopping cart race“: vozidlo před závodem je hráč – ne místo
 * („space race“) ani druh závodu. „car racing game“ nechá závodní auto šablony.
 */
const RACE_HERO = /^(?:an? |the |my )?([a-z]+(?: [a-z]+)?) race\b/;
const RACE_KIND = /^(?:drag|drift|street|time|endless|fast|big|epic|crazy|final|a|an|the)$/;

function raceHero(sentence: string): string | null {
  const phrase = RACE_HERO.exec(sentence.toLowerCase())?.[1];
  return phrase === undefined || RACE_KIND.test(phrase.split(' ').at(-1)!) || isPlace(phrase) ? null : phrase;
}

/** Hlava fráze, která jmenuje tvora, věc nebo náladu, ne místo: „shoot the aliens“, „throwing snowballs“, „haunted“. */
const NOT_A_PLACE = /^(?:alien|zombie|ghost|pirate|toy|boat|submarine|star|comet|lava|magma|coral|snowball|snowman|snowflake|haunted|spooky|horror|neon|cosmic|frozen|icy|ice|winter|medieval|tropical|traffic)s?$/;

/** Jmenuje fráze místo? Rozhoduje hlava: „haunted hospital“ ano, „shopping cart“, „parking“ a „zombie“ ne. */
const isPlace = (phrase: string): boolean => {
  const head = phrase.split(' ').at(-1)!;
  return lookFor(head) !== null && !NOT_A_PLACE.test(head) && !head.endsWith('ing');
};

/**
 * Místo, které sada pozná, i bez předložky (P27A T5): „defend the castle“,
 * „behind a snow fort“, „flappy bird but underwater“. Předložková fráze, kterou
 * sada nezná („at kids“), ustoupí; hlava fráze musí sama jmenovat místo.
 */
function withPlace(roles: SentenceRoles, sentence: string): SentenceRoles {
  if (roles.setting !== null && lookFor(roles.setting) !== null) return roles;
  const text = sentence.toLowerCase();
  for (const at of lookWords(text)) {
    const rest = text.slice(text.lastIndexOf(' ', at) + 1);
    for (const phrase of [nounPhrase(rest, 2), nounPhrase(rest, 1)]) {
      if (phrase !== null && isPlace(phrase)) return { ...roles, setting: phrase };
    }
  }
  return roles;
}

/**
 * Míra a pořadí před předmětem (P37A T5) předmět nejsou: „a week of lunches“,
 * „a pile of crumpled receipts“, „the fridge full of moldy leftovers“, „the
 * last bus“, „more vegetables“. Nádoba, která je sama věcí („a pot of soup“), zůstává.
 */
const MEASURE =
  /^(?:(?:a|an|the|some|my|your|his|her|their|our)\s+)?(?:(?:[a-z]+\s+)?full|week|month|day|pile|mountain|stack|heap|bunch|load|bag|basket|pair|couple|ton|handful|classroom|crowd)s?\s+of\s+/;
const ORDINAL = /^(?:(?:a|an|the|some|my|your|his|her|their|our)\s+)?(?:last|first|next|more|less|few|several|extra|whole|entire)\s+/;
const dropMeasure = (text: string): string => text.replace(MEASURE, '').replace(ORDINAL, '');

/** Předmět hlavního slovesa ze zbytku věty za ním: nejvýš dvě slova, bez předložky, míry a pořadí. */
const objectOf = (after: string): string | null => nounPhrase(dropMeasure(after.replace(/^(?:on|at|up|down|out|to|into|through)\s+/, '')), 2);

/** Podstatné jméno na začátku zbytku věty: bez členu a číslovky, nejvýš dvě slova, jednotné číslo. */
const nounAfter = (rest: string | undefined): string | null => {
  if (rest === undefined) return null;
  const phrase = leadWords(dropMeasure(rest).replace(/^(?:(?:a|an|the|some|all|my|your|lots of|a lot of|\d+|two|three|four|five|six|seven|eight|nine|ten)\s+)+/, ''));
  // „swords cutting fruit“: sloveso na -ing frázi končí.
  const words = phrase?.split(' ') ?? [];
  const verb = words.findIndex((word) => ING_VERB.test(word));
  const noun = verb === -1 ? words : words.slice(0, verb);
  return noun.length === 0 ? null : singular(noun.join(' '));
};

const ING_VERB = /^(?!(?:king|ring|thing|wing|string|building|ceiling|swing|sling|spring|pudding|viking|painting|clearing)$)\w{2,}ing$/;

/** Věta má narážku, kterou mřížka umí zahrát, i když ji skóre archetypů nepočítá (klid, hledání, pohyblivé zdi). */
const gridCue = (text: string): boolean => GENTLE.test(text) || KID_FRIENDLY.test(text) || SEARCH.test(text) || MOVING_WALLS.test(text);

const PICKUP = /\b(?:grab(?:s|bing)?|collect(?:s|ing)?|gather(?:s|ing)?|catch(?:es|ing)?|eat(?:s|ing)?|pick(?:s|ing)? up)\s+(.+)/;
const AVOID = /\b(?:(?:jump|hop)(?:s|ing)? over|dodg(?:e|es|ing)|avoid(?:s|ing)?|(?:runs?|running)(?: away)? from|chased by)\s+(.+)/;
const RESKIN = /\bbut with\s+(.+)/;
// „purple elephants doing taxes“, „a squirrel hoarding nuts“: podmět bez slovesa, které `readRoles` zná. „Cross floating islands“ – „-ss“ množné číslo není.
const SUBJECT = /^(?:(?:a|an|the) ([a-z]+(?: [a-z]+)?)|([a-z]+ [a-z]*[a-rt-z]s|[a-z]*[a-rt-z]s)) [a-z]+ing\b/;

/**
 * Podstatná jména věty pro role arkády (P28D T2), když je `readRoles` nenašel:
 * co hráč sbírá („grabbing sausages“), čemu se vyhýbá („jumping over
 * sprinklers“, „running from a monkey“), převlek žánru („angry birds but with
 * cats and cardboard boxes“ → hrdina kočka, druhá role krabice) a podmět.
 */
function sentenceNouns(sentence: string): { hero: string | null; pickup: string | null; avoid: string | null; second: string | null } {
  const text = sentence.toLowerCase().replace(/[^a-z0-9' -]/g, ' ').replace(/\s+/g, ' ').trim();
  const reskin = RESKIN.exec(text)?.[1];
  const second = reskin === undefined ? null : nounAfter(/\band\s+(.+)/.exec(reskin)?.[1]);
  const subject = SUBJECT.exec(text);
  const said = subject === null ? null : (subject[1] ?? subject[2])!;
  const hero = nounAfter(reskin) ?? (said === null || /ing\b/.test(said) || TITLE_SKIP.has(said.split(' ')[0]!) ? null : singular(said));
  return { hero, pickup: nounAfter(PICKUP.exec(text)?.[1]), avoid: nounAfter(AVOID.exec(text)?.[1]), second };
}

/** Co střelnice trefuje (P28D T3): „pop ten balloons“, „shoot the cans“. */
const HIT = /\b(?:pop|pops|popping|burst|bursts|bursting|shoot|shoots|shooting|hit|hits|hitting|zap|zaps|zapping)\s+(.+)/;
/** Tvor věty, který není hrdina – střelnice bez jmenovaného nepřítele z něj udělá vlny. */
const CREATURE = /\b(dragon|monster|ghost|zombie|alien|skeleton|goblin|orc|troll|vampire|dinosaur|shark|bat|bee|wasp|spider|witch|demon|robot)s?\b/g;

function otherCreature(sentence: string, hero: string): string | null {
  for (const match of sentence.toLowerCase().matchAll(CREATURE)) if (!hero.toLowerCase().includes(match[1]!)) return match[1]!;
  return null;
}

/** Role, kterou druhé podstatné jméno převleku přejmenuje; řízení ne – jeho texty jmenují soupeřova auta. */
const SECOND_ROLE: Partial<Record<ControlChoice['control'], string>> = { runner: 'obstacle', shooter: 'enemy', throw: 'target', duel: 'rival' };

/**
 * Arkádová hra (P25A běžec, P25C plošinovka a poletování, P25F řízení a aréna,
 * P25G střelba a hod, P25H načasování, rytmus a souboj): šablona fixtury
 * ovládání, přepíše se titul, popisky a parametry, které věta řekla.
 */
function draftArcade(sentence: string, seed: number, choice: ControlPick, topic: string | null = null, reading: Reading | null = null): GameSpecV1 | null {
  const spec = JSON.parse(JSON.stringify(ARCADE_TEMPLATES[choice.control])) as GameSpecV1;
  const roles = withPlace(rolesFrom(sentence, reading), sentence);
  const readObstacle = bare(reading?.roles.find((entry) => entry.kind === 'obstacle')?.noun ?? null);
  const rng = xoroshiro128plus(seed);
  spec.title = titleFrom(sentence, spec.title);
  // Postava šablony (ptáček, závodní auto, rybka, jeřáb, bubeník, bojovník) zůstane,
  // když věta hráče nejmenuje; běžec, plošinovka, střelnice a hod losují.
  // Řízení závodní auto šablony nedědí (P32B T3): pojede na plavidle z věty, jinak na tom, co patří k místu.
  const keepsHero = choice.control !== 'runner' && choice.control !== 'platform' && choice.control !== 'shooter' && choice.control !== 'throw';
  const fallback =
    choice.control === 'steer'
      ? defaultHero(roles.setting ?? spec.theme.setting, 'voyage', sentence)
      : keepsHero
        ? role(spec, 'player').label
        : PLAYER_LABELS[uniformInt(rng, 0, PLAYER_LABELS.length - 1)];
  const nouns = sentenceNouns(sentence);
  const second = SECOND_ROLE[choice.control] === undefined ? null : nouns.second;
  // P28D T4: běžec bez herního slovesa je o tématu věty – hrdinou je, když ho scéna umí nakreslit („grandma“).
  const topicHero = topic !== null && modelOf(topic, true) !== undefined ? topic : null;
  role(spec, 'player').label = cap(roles.player ?? (choice.control === 'steer' ? raceHero(sentence) : null) ?? nouns.hero ?? topicHero ?? fallback, 60);
  const collectible = COLLECTIBLE_ROLE[choice.control];
  const pickup = roles.collectible ?? (collectible === 'coin' ? nouns.pickup : null);
  if (pickup !== null && collectible !== null) role(spec, collectible).label = cap(pickup, 60);
  if (roles.setting !== null) spec.theme.setting = cap(roles.setting, 80);
  // Místo bez předložky („flappy bird but underwater“, „a snow fort“) sada najde v celé větě (nález T11).
  const place = lookFor(spec.theme.setting) === null ? lookFor(sentence.toLowerCase()) : null;
  if (place !== null) spec.theme.look = place;
  const rival = choice.control === 'duel' ? (roles.target ?? duelFoe(sentence) ?? second) : null;
  if (rival !== null) role(spec, 'rival').label = cap(rival, 60);
  // P26 T12: scéna z těchhle popisků volí model – terč, nepřítel a překážka z věty, ne ze šablony.
  const foe = roles.target ?? roles.threat?.label ?? namedFoe(sentence) ?? second;
  // P28D T3: střelnice čte jen hráče a nepřítele – tvor věty („rides a dragon“), jinak to, co se střílí („pop ten balloons“).
  const wave = choice.control === 'shooter' ? (foe ?? otherCreature(sentence, role(spec, 'player').label) ?? nounAfter(HIT.exec(sentence.toLowerCase())?.[1])) : null;
  if (wave !== null) role(spec, 'enemy').label = cap(wave, 60);
  const target = roles.target ?? namedFoe(sentence) ?? second;
  if (choice.control === 'throw' && choice.goal === null && target !== null) role(spec, 'target').label = cap(target, 60);
  const obstacle = (readObstacle === null ? null : singular(readObstacle)) ?? roles.threat?.label ?? nouns.avoid ?? second;
  if (choice.control === 'runner' && obstacle !== null) role(spec, 'obstacle').label = cap(obstacle, 60);
  if (choice.control === 'timing') {
    if (choice.mode !== 'stack') {
      const text = TIMING_TEXT[choice.mode];
      spec.objective.description = text.description;
      spec.tutorial.goalLine = text.goalLine;
      spec.tutorial.controlsHint = text.controlsHint;
    }
    spec.controlParams = { ...spec.controlParams, mode: choice.mode, ...(choice.speed === null ? {} : { speed: choice.speed }) };
  } else if (choice.control === 'rhythm') {
    if (choice.density !== null) spec.controlParams = { ...spec.controlParams, density: choice.density };
  } else if (choice.control === 'runner') {
    // P26D T9: šablona má `high`, takže „a lot of obstacles“ by nic nepřidalo – věta bez hustoty dostane `normal`.
    spec.controlParams = { ...spec.controlParams, density: choice.density ?? 'normal' };
  } else if (choice.control === 'platform') {
    spec.controlParams = {
      ...spec.controlParams,
      ...(choice.difficulty === null ? {} : { difficulty: choice.difficulty }),
      ...(choice.movingPlatforms ? { movingPlatforms: true } : {}),
      ...(choice.doubleJump ? { doubleJump: true } : {}),
    };
  } else if (choice.control === 'steer') {
    // Okruh ze vzorů: šikany, zúžení, rozcestí… (P46D T4) ve stylu podle prostředí (R2).
    const style = steerStyleFor(spec.theme.look ?? lookFor(spec.theme.setting));
    spec.controlParams = { ...spec.controlParams, ...(choice.difficulty === null ? {} : { difficulty: choice.difficulty }), ...(choice.drift ? { drift: true } : {}), patterns: 1, ...(style === undefined ? {} : { style }) };
  } else if (choice.control === 'move_free') {
    if (choice.density !== null) spec.controlParams = { ...spec.controlParams, density: choice.density };
  } else if (choice.control === 'throw') {
    // P27A T5: terč z věty („at kids“, „from dragons“) kreslí jen cíl `target` – věž z kostek nebo koš by ho nahradily.
    const goal = choice.goal ?? (target === null ? null : 'target');
    spec.controlParams = { ...spec.controlParams, ...(choice.difficulty === null ? {} : { difficulty: choice.difficulty }), ...(goal === null ? {} : { goal }) };
    // P28D T2: věž je z kostek – „cats and cardboard boxes“ ji postaví z krabic.
    if (choice.goal !== null) role(spec, 'target').label = choice.goal === 'tower' && second !== null ? cap(second, 60) : THROW_GOAL_LABELS[choice.goal];
  } else if (choice.difficulty !== null) spec.controlParams = { ...spec.controlParams, difficulty: choice.difficulty };
  // P26D T8: druhé sloveso věty („jump and shoot“) – `pickControl` vybral jen doplňky, které ovládání bere.
  if (choice.addons !== undefined) spec.addons = [...choice.addons];
  applySentenceCounts(spec, sentence, reading);
  const fireHint = `${spec.tutorial.controlsHint} F or Fire to shoot.`;
  if (choice.addons?.includes('shoot') === true && fireHint.length <= 80) spec.tutorial.controlsHint = fireHint;
  // P46A T8: akce hrdiny ze sloves věty, které ovládání bere; nápověda k tlačítkům, když se vejde.
  if (choice.abilities !== undefined) {
    spec.abilities = [...choice.abilities];
    const buttons = `${spec.tutorial.controlsHint} ${abilityHint(choice.abilities)}`;
    if (buttons.length <= 80) spec.tutorial.controlsHint = buttons;
  }
  const result = readGameSpec(spec);
  return result.ok ? result.value : null;
}

/** Nejdelší podstatné jméno věty (P28D T4); při shodě délky slovo, které scéna umí nakreslit. První slovo je sloveso nebo podmět. */
function topicNoun(text: string): string | null {
  const words = text.replace(/[^a-z ]/g, ' ').split(/\s+/).filter((word) => word !== '').slice(1);
  const nouns = words.filter((word) => word.length >= 3 && !TITLE_SKIP.has(word) && !TITLE_TAIL.has(word) && !/(?:ing|ed|ly|ful|ous|ive|tic)$/.test(word));
  const drawn = (word: string): number => (modelOf(word, true) === undefined ? 0 : 1);
  return [...nouns].sort((a, b) => b.length - a.length || drawn(b) - drawn(a))[0] ?? null;
}

/** Věta, která hru chce, i když sloveso nemá („mini golf with windmills“, „scary game in a hospital“) – hláška by jí nesedla. */
const GAME_WORDS =
  /\b(?:games?|simulator|sim|golf|soccer|football|tennis|billiards|pool|bowling|sports?|dungeon|zelda|quest|rpg|adventure|puzzle|levels?|boss|points?|score|scary|horror|shots?|vs)\b/;

/**
 * Věta bez herního slovesa (P28D T4, R-12): ovládání ani mřížka nic neslyší
 * a nejbližší arkáda nemá ani sloveso, ani podstatné jméno – hraje se běžec.
 * Vrací téma běžce (nejdelší podstatné jméno), jinak `null`.
 */
export function noVerbTopic(sentence: string): string | null {
  const text = sentence.toLowerCase();
  if (GAME_WORDS.test(text)) return null;
  if (pickControl(text) !== null || Object.values(scoreArchetypes(sentence)).some((score) => score > 0) || gridCue(text)) return null;
  if (nearestControl(text).why !== 'default') return null;
  return topicNoun(text) ?? 'your idea';
}

/** Prostředí, když ho věta neříká; kuchař vaří v kuchyni, ne na vesnici. */
const GENRE_SETTING: Readonly<Record<GenreId, string>> = {
  runner: 'forest trail',
  platformer: 'floating islands',
  arena: 'meadow',
  voyage: 'open country',
  quest: 'village',
  shooter: 'desert outpost',
  throw: 'park',
  timing: 'windy hilltop',
  rhythm: 'neon stage',
  duel: 'dusty town',
  flap: 'bright sky',
  catch: 'orchard',
  whack: 'garden',
  defense: 'castle walls',
  slice: 'dojo',
  hop: 'busy road',
  crowd: 'race track',
  merge: 'candy shop',
  push: 'sumo ring',
};
const VERB_SETTING: Readonly<Record<string, string>> = { cook: 'kitchen', repair: 'workshop' };

/** „before the ghosts catch him“: kdo hráče chytá, i když `readRoles` pronásledovatele nenašel. */
const CATCH_BEFORE = /\bbefore (?:the |a |an )?([a-z]+(?: [a-z]+)?) (?:catch|catches|get|gets|reach|reaches|grab|grabs) (?:him|her|you|me|them|us|it|the player)\b/;
/** „Two knights duel“: počítaný podmět je hrdina i soupeř. */
const COUNTED_SUBJECT = /^(?:two|three|four|five|\d+) ((?:[a-z]+ )?[a-z]+s)\b/;
/** „like flappy bird“: jméno hry jmenuje hrdinu, když ho věta jinak nemá. */
const FLAPPY = /\bflapp?y ([a-z]+)\b/;
/** „catch him“, „destroy everything“: zájmeno není věc, kterou by scéna nakreslila. */
const NOT_A_THING = /^(?:any|every|some|no)(?:thing|one|body)$|^(?:stuff|things?|all|it|them|him|her|us|me|you)$/;

/** Popisek čtení bez členu a bez obecného „player“; prázdné → `null`. */
function cleanLabel(phrase: string | null | undefined): string | null {
  const text = bare(phrase ?? null);
  return text === null || GENERIC_HERO.test(text) ? null : cap(text, 60);
}

/** Hod: na co se hází („at kids“, „into the trash can“) a co se hází, když věta začíná druhem hodu („knife throwing“). */
const THROWN_AT = /\b(?:at|into|onto) (?:the |a |an |some )?([a-z][a-z -]*)/;
const THROWN_BEFORE = /^([a-z]+) throwing\b/;

const thing = (label: string | null | undefined): string | null => (label === null || label === undefined || NOT_A_THING.test(label) ? null : label);
/** „escape from a haunted hospital“: místo, odkud se utíká, není pronásledovatel; „a goblin castle“ ale jmenuje goblina. */
const foeIn = (label: string | null | undefined): string | null => (label === null || label === undefined ? null : isPlace(label) ? otherCreature(label, '') : label);

/** Role, ve kterých věc hráče ohrožuje, nebo se do ní střílí či bije: protivník obsazení. */
const FOE_ROLES: ReadonlySet<CastRole> = new Set<CastRole>(['shoot_at', 'chase_me', 'avoid', 'fight']);
/** „three wolves“: číslovka říká počet, ne jméno věci. */
const COUNT_WORD = new RegExp(`^(?:\\d+|${Object.keys(NUMBER_WORDS).join('|')}) `);

/**
 * Obsazení bez dvojic (P39): číslovka jméno nedělá, roli drží první výskyt.
 * Role žánru (`core`) se liší jménem; věc jmenovaná větou (`spoken`), jejíž
 * jméno končí jménem věci už obsazené nebo naopak („drone“ po „security
 * drone“), tam už je. Nejvýš `CAST_MAX` položek.
 */
function castOf(core: readonly CastItem[], spoken: readonly CastItem[] = []): CastItem[] {
  const cast: CastItem[] = [];
  const add = (item: CastItem, loose: boolean): void => {
    const label = cap(item.label.replace(COUNT_WORD, ''), 60);
    const same = (other: string): boolean => other === label || (loose && (other.endsWith(` ${label}`) || label.endsWith(` ${other}`)));
    if (!cast.some((known) => same(known.label))) cast.push({ ...item, label });
  };
  for (const item of core) add(item, false);
  for (const item of spoken) add(item, true);
  return cast.slice(0, CAST_MAX);
}

/**
 * Věta → `GenreSpec` žánru a režimu `choice` (P32B T2): role dá `draftFill`
 * modulu, mezery doplní čtečky věty z tohohle souboru, co chybí úplně, dá
 * prostředí (`genre/roles`). `heroSaid` = hrdinu řekla věta, ne prostředí.
 * `null`, když výsledek neprojde mezemi modulu nebo `readGameSpec`.
 */
function draftGenre(
  sentence: string,
  reading: Reading | null,
  choice: GenreChoice,
  ranking: GenreRanking,
  modules: GenreModules,
  twist: Twist | null = null,
): { readonly genre: GenreSpec; readonly spec: GameSpecV1; readonly heroSaid: boolean } | null {
  const module = modules[choice.genre] as GenreModule;
  const fill = module.draftFill(sentence, reading) as Partial<GenreSpec>;
  // Doplněk modulu dává obsazení; draft z něj bere první věc každé role (modul řadí, co má přednost).
  const fillFoe = fill.cast?.find((item) => FOE_ROLES.has(item.does));
  const fillItem = fill.cast?.find((item) => item.does === 'collect');
  const fillGoal = fill.cast?.find((item) => item.does === 'reach');
  const text = sentence.toLowerCase().replace(/\s+/g, ' ').trim();
  const roles = withPlace(rolesFrom(sentence, reading), sentence);
  const nouns = sentenceNouns(sentence);
  const counted = COUNTED_SUBJECT.exec(text)?.[1];
  const pair = counted === undefined ? null : singular(counted);
  const topic = choice.score === 0 ? noVerbTopic(sentence) : null;
  const topicHero = topic !== null && modelOf(topic, true) !== undefined ? topic : null;
  // Souboj (P36A T11) bere soupeře z věty stejně jako rvačka v Aréně.
  const fight = (choice.genre === 'arena' && choice.mode === 'fight') || choice.genre === 'duel';
  // Absurdní přenos (P37A T5): věta bez herního slovesa má hrdinu ze seznamů přenosu, nebo podmět se slovesem na -ing
  // („purple elephants doing taxes“) – „long queue“ ani „hour“ hrdina není.
  const noVerb = twist !== null && choice.score === 0;
  const heroSaid = noVerb
    ? (twist.hero ?? nouns.hero)
    : (cleanLabel(fill.hero) ??
      pair ??
      cleanLabel(roles.player) ??
      (choice.genre === 'voyage' ? raceHero(sentence) : null) ??
      nouns.hero ??
      FLAPPY.exec(text)?.[1] ??
      topicHero ??
      // Ve sporu je blízký soupeř („argue with my wife“), ne hrdina.
      (fight ? null : (twist?.hero ?? null)));
  const catcher = CATCH_BEFORE.exec(text)?.[1];
  const verb = ranking.verb ?? 'use';
  const family = familyOf(ranking.verb);
  const heroAction = heroActionOf(ranking.verb);
  const said = ranking.after === null ? null : objectOf(ranking.after);
  const object = thing(said);
  // Úkol: u hodu a střelby je předmětem terč („throw balls at rubber ducks“, „shooter against asteroids“), jinak předmět slovesa.
  const aimed = verb === 'hit' || verb === 'shoot' || verb === 'throw' || ranking.verb === null ? thing(roles.target) : null;
  // Skákačka: cíl úrovně a jeho sloveso vyčte `draftFill` modulu („to find its battery“, P35 T3).
  const filledTarget = choice.genre === 'platformer' ? (fillGoal ?? null) : null;
  // Hod (P36A T10): terč je to, na co se hází („at kids“, „into a hoop“, převlek „angry birds but with cats and cardboard boxes“);
  // předmět slovesa je, co se hází, jen když nestojí za předložkou („throwing at a spinning log“) – „knife throwing“ hází nůž.
  // Bez terče z věty rozhodne druh cíle modulu.
  const thrown = choice.genre === 'throw';
  const thrownAt = thrown ? (aimed ?? thing(nounPhrase(THROWN_AT.exec(text)?.[1] ?? '', 2)) ?? (ranking.verb === null ? nouns.second : null)) : null;
  const target =
    choice.genre === 'quest'
      ? singular(aimed ?? object ?? namedFoe(sentence) ?? nouns.second ?? defaultTarget(verb))
      : thrown
        ? thrownAt === null
          ? null
          : singular(thrownAt)
        : filledTarget === null
          ? null
          : singular(filledTarget.label);
  const escape = choice.genre === 'arena' && choice.mode === 'escape';
  // Přenos: spor má soupeřem člověka věty, útěk to, co děsí – a bez toho věc, které se hrdina brání („refusing to take her medicine“).
  const twistFoe = twist === null ? null : fight ? (twist.person ?? twist.foe) : (twist.foe ?? (escape ? twist.thing : null));
  const foe = fight
    ? (twistFoe ?? roles.target ?? duelFoe(sentence) ?? namedFoe(sentence) ?? pair ?? cleanLabel(fillFoe?.label))
    : (twistFoe ??
      foeIn(cleanLabel(fillFoe?.label)) ??
      foeIn(roles.threat?.label) ??
      (catcher === undefined ? null : singular(catcher)) ??
      nouns.avoid ??
      namedFoe(sentence) ??
      // „races through traffic“: předložková fráze, která jmenuje tvora nebo nástrahu, ne místo.
      (roles.setting !== null && NOT_A_PLACE.test(roles.setting.split(' ').at(-1)!) ? roles.setting : null));
  // „zombie shooter“: co se střílí, je terč úkolu, ne ještě jednou nepřítel; co hráč hází, taky ne (T7). Popisek role je jeden kus („cones“ → „cone“).
  const enemy = foe === null || singular(foe) === target || toolsOf(sentence).includes(singular(foe)) ? null : singular(foe);
  const throwsAt = ranking.after !== null && /^(?:at|into|onto|on|to|toward|towards)\s/.test(ranking.after);
  // Rodina úklidu (P37A T3) sbírá, co věta uklízí („rakes autumn leaves“), dřív než věc z prostředí.
  const swept = family?.object === 'collectible' ? (thing(cleanLabel(fillItem?.label) ?? roles.collectible) ?? object) : null;
  const pickup = swept ?? thing(cleanLabel(fillItem?.label) ?? roles.collectible ?? nouns.pickup);
  // Přenos nesbírá ani neskládá kulisu („help my kid with homework at the kitchen table“).
  const heard = twist !== null && pickup !== null && isScenery(pickup) ? null : pickup;
  // Přenos: věc věty, kterou hrdina nezahnal jako soupeře; kus, který se skládá nebo hraje („pay the electricity bill“, „fold towels“), je předmět slovesa.
  const twistThing = twist === null || twist.thing === twistFoe ? null : twist.thing;
  const piece = twist !== null && (choice.genre === 'timing' || choice.genre === 'rhythm') && object !== null && !isPerson(object) && !isScenery(object) ? object : null;
  const found = thrown ? (thing(THROWN_BEFORE.exec(text)?.[1]) ?? (throwsAt ? null : object) ?? thing(roles.collectible)) : noVerb ? (twistThing ?? heard) : (heard ?? piece ?? twistThing);
  const collectible = found === null ? null : singular(found);
  // P39: každá věc, kterou věta jmenuje se slovesem, i předmět hlavního slovesa – kromě místa, hrdiny a nástroje
  // („shoots arrows at goblins“: šíp letí, terčem je goblin – T7).
  const heroLabel = heroSaid === null ? null : singular(heroSaid);
  const verbThing = object === null || ranking.does === null || toolsOf(sentence).includes(singular(object)) ? [] : [{ label: singular(object), does: ranking.does }];
  const spoken = [...roles.named, ...verbThing].filter(({ label }) => !isPlace(label) && label !== heroLabel);
  const saidFoe = spoken.find((item) => item.does === null || FOE_ROLES.has(item.does))?.label ?? null;
  // „at kids“, „at rubber ducks“: fráze, která jmenuje roli, není místo; přednost má místo, které sada zná.
  const named = new Set([target, enemy, collectible, ...spoken.map((item) => item.label)].flatMap((label) => (label === null ? [] : [singular(label)])));
  const placeOf = (phrase: string | null, known: boolean): string | null => (phrase === null || named.has(singular(phrase)) || (known && lookFor(phrase) === null) ? null : phrase);
  const filled = cleanLabel(fill.setting);
  const setting = placeOf(filled, true) ?? placeOf(roles.setting, true) ?? placeOf(filled, false) ?? placeOf(roles.setting, false) ?? VERB_SETTING[verb] ?? GENRE_SETTING[choice.genre];
  const place = lookFor(setting) === null ? lookFor(text) : null;
  const hero = heroSaid ?? defaultHero(setting, choice.genre, sentence);
  // Nepřítel a sbíraná věc, které věta neříká, jsou z prostředí (P32B T3) – jen když nezdvojí roli, kterou hra už má.
  const spare = (label: string, taken: readonly (string | null)[]): string | null => (named.has(label) || taken.includes(label) ? null : label);
  // Les dá vlka, jen když věta žádného protivníka nejmenuje. Skákačka a poletování mají vlastní překážku
  // (bodák, trubka), kterou protivník z prostředí nepřejmenuje – primitiv zůstává, kde věta nic neřekla.
  const ownHazard = choice.genre === 'platformer' || choice.genre === 'flap';
  // P38: střelba na skoku nebo běhu – protivník bez slovesa se sestřelí a `compileWith` z toho udělá doplněk `shoot`.
  const rideShot = ranking.ride === 'shoot' && (choice.genre === 'platformer' || choice.genre === 'runner');
  const ownFoe: CastRole = rideShot ? 'shoot_at' : fight ? 'fight' : FOE_DOES[choice.genre];
  // Chytání se střelou (P52 T7b-R1-R1): terč střely („spits water at the bees“) je nepřítel, kterého hrdina sestřelí –
  // včely na cestě ke kořisti; protivník z prostředí pak nepřibude.
  const caught = choice.genre === 'arena' && roles.target !== null ? extractIntent(sentence) : null;
  const shotAt = caught?.items.some((item) => item.verb === 'catch') === true && saidAbilities(sentence, caught).includes('shoot') ? singular(roles.target!) : null;
  // Protivník, kterého hra sestřelí, zůstává zvířetem prostředí; jen ten, kterému se uhýbá, je překážka trati (P46D T6).
  const foeLabel = enemy ?? saidFoe ?? (ownHazard || shotAt !== null ? null : spare(defaultFoe(setting, choice.genre, ownFoe).label, [singular(hero)]));
  // Útěk s věcí ke sběru je sběr (T5b, skutečná Aréna): věc, kterou věta neříká, by z „survive the storm“ udělala sbírání.
  // Plavba věc nesbírá – její věc je cíl cesty; bez věci ve větě jede k místu z prostředí (P35 T8), ne pro minci.
  // Střílečka nic nesbírá a hod hází, co řekne věta, jinak míč – věc z prostředí by z mince udělala náboj.
  // Načasování skládá, co řekne věta, jinak blok; rytmus hraje noty z věty, jinak dlaždice; souboj nesbírá nic (P36A T11).
  const noItem = escape || choice.genre === 'voyage' || choice.genre === 'shooter' || thrown || choice.genre === 'timing' || choice.genre === 'rhythm' || choice.genre === 'duel';
  const itemLabel = collectible ?? (noItem ? null : spare(defaultCollectible(setting), [singular(hero), foeLabel]));
  const seconds = reading?.numbers.seconds ?? readNumbers(sentence).seconds;
  const own = paramsOf(module, fill.params, seconds);
  const depth = depthOf(sentence);
  const params = Object.keys(depth).length === 0 ? own : { ...own, ...depth };
  // Co věc dělá: sloveso u ní ve větě, pak doplněk modulu (čtení modelem), pak role, kterou žánr hraje sám.
  const doesOf = (label: string, own: CastRole): CastRole => spoken.find((item) => item.label === label)?.does ?? (fillFoe?.label === label ? fillFoe.does : own);
  // Sbírací sloveso, které doplněk modulu dal věci („gather 3 apples“ ve skákačce), zůstane u ní.
  const itemVerb = fill.cast?.find((item) => item.does === 'collect' && item.verb !== undefined && singular(item.label) === itemLabel)?.verb;
  // „find its battery“: věc, která je i cílem a nemá sbírací sloveso, je cíl – jinak by ji `castOf` nechal jako bonus a cíl zahodil.
  const goalItem = !thrown && itemLabel !== null && itemLabel === target && itemVerb === undefined;
  // Co hod hází, je náboj (projektil = `scenery` se slovesem hodu, P39 T14), ne věc ke sběru – ta zůstane, jak ji věta říká.
  const item: CastItem | null =
    itemLabel === null || goalItem ? null : thrown ? { label: itemLabel, does: 'scenery', verb: AMMO_VERB } : { label: itemLabel, does: 'collect', ...(itemVerb === undefined ? {} : { verb: itemVerb }) };
  // P54C T13: žánr pruhů čte role sám (`draftFill`: co padá, vykukuje, jde k hradbě nebo letí, koho šetřit, co bránit);
  // obecné role výš znají jen jednoho protivníka a jednu věc ke sběru – hodný cíl a bráněný hrad by zahodily.
  // Předmět hlavního slovesa klasifikátoru („tap the ghosts…“) přibude, jen když ho modul nečetl. Od T13b totéž
  // žánry fáze 3 (přeskákání, dav, slučování, vytlačování): role jim dá jejich `draftFill`.
  const recipe = PRESETS[`${choice.genre}.${choice.mode}`];
  const lanes = recipe !== undefined && wholeGame(recipe);
  const cast = lanes ? castOf(fill.cast ?? [], verbThing) : castOf([
    ...(foeLabel === null ? [] : [{ label: foeLabel, does: doesOf(foeLabel, ownFoe) }]),
    ...(shotAt === null || shotAt === foeLabel ? [] : [{ label: shotAt, does: 'shoot_at' as const }]),
    ...(item === null ? [] : [item]),
    ...(target === null ? [] : [{ label: target, does: thrown ? ('throw_at' as const) : ('reach' as const), verb: (filledTarget?.verb ?? verb).slice(0, 24), states: choice.mode === 'station' ? (3 as const) : (2 as const) }]),
  ], spoken.map((item) => ({ label: item.label, does: item.does ?? ownFoe })));
  // Střelba bez terče ve větě střílí do protivníka z prostředí.
  const fallbackShot = rideShot && !cast.some((item) => item.does === 'shoot_at') ? spare(defaultFoe(setting, choice.genre, 'shoot_at').label, [singular(hero)]) : null;
  const candidate = {
    genre: choice.genre,
    mode: choice.mode,
    hero: cap(hero, 60),
    // Činnost hrdiny rodiny slovesa (P37A T3) je jen vzhled; bez rodiny pole chybí jako dřív.
    ...(heroAction === null ? {} : { heroAction }),
    cast: fallbackShot === null ? cast : castOf([...cast, { label: fallbackShot, does: 'shoot_at' }]),
    setting: cap(setting, 80),
    ...(place === null ? {} : { palette: place }),
    ...(params === null ? {} : { params }),
  };
  // „Two knights duel“: počítaný podmět je hrdina i soupeř – číslovka říká, kolik jich je v souboji, ne kolik soupeřů.
  // Žánr pruhů má role z `draftFill`: počet věty patří jim („catches 5 falling bananas“, „shoves 2 seals off“, P54C).
  const counts = countsOf(sentence, reading, lanes
    ? { enemy: cast.find((entry) => entry.does === FOE_DOES[choice.genre])?.label ?? null, collectible: cast.find((entry) => entry.does === 'collect')?.label ?? null, target: null }
    : { enemy: foeLabel === pair ? null : foeLabel, collectible: itemLabel, target });
  const bounded = boundedCounts(candidate as GenreSpec, counts, module);
  const read = readGenreSpec(bounded === null ? candidate : { ...candidate, counts: bounded });
  if (!read.ok) return null;
  const compiled = compileWith(module, read.value);
  // Přenos řekne cíl v HUD slovy věty („Dodge the long queues!“); uložené hry a hry s herním slovesem ho nemají.
  const goal = twist === null ? null : twistGoal(read.value, sentence);
  const game = readGameSpec(goal === null ? compiled : { ...compiled, tutorial: { ...compiled.tutorial, goalLine: goal } });
  return game.ok ? { genre: read.value, spec: game.value, heroSaid: heroSaid !== null } : null;
}

/**
 * Životy a cílové skóre z věty („with 5 lives“, „score 100 points“, P36A T2/T5)
 * jako parametry hloubky `GenreSpec` (T8): do hry je propíše `compileWith`
 * stejně jako z odpovědi režiséra a režisér je vidí ve výchozím bodě.
 */
function depthOf(sentence: string): Record<string, number> {
  const lives = readLives(sentence);
  const target = readTargetScore(sentence);
  return { ...(lives === null ? {} : { lives }), ...(target === null ? {} : { targetScore: target }) };
}

/**
 * Parametry návrhu: co spočítal `draftFill` modulu (počet cílů, pronásledovatelé
 * Úkolu – bez nich honí výchozí nepřítel z prostředí), a délka kola z věty. Meze drží modul; parametr, který
 * modul nezná, se zahodí. `null` = žádný.
 */
function paramsOf(module: GenreModule, filled: Readonly<Record<string, number>> | undefined, seconds: number | null): Record<string, number> | null {
  const said = { ...filled, ...(seconds === null ? {} : { seconds }) };
  const kept = Object.entries(said).flatMap(([key, value]) => {
    const range = module.paramBounds[key];
    return range === undefined ? [] : [[key, clamp(value, range.min, range.max)] as const];
  });
  return kept.length === 0 ? null : Object.fromEntries(kept);
}

/** Druhy rolí čtení modelem, které nesou počet role `GenreSpec`. */
const COUNT_KINDS: Readonly<Record<CountRole, readonly string[]>> = { enemy: ['chaser', 'threat'], collectible: ['collectible', 'item'], target: ['target'] };

/**
 * Počty rolí, které věta říká (B-R4): čtení modelem („keys“, 3), jinak číslovka
 * před jménem role („five glowing mushrooms“). Jen role, kterou návrh má.
 */
function countsOf(sentence: string, reading: Reading | null, labels: Readonly<Record<CountRole, string | null>>): Partial<Record<CountRole, number>> {
  const said = readCountedNouns(sentence);
  return Object.fromEntries(
    GENRE_COUNT_ROLES.flatMap((role) => {
      const label = labels[role];
      if (label === null) return [];
      const noun = singular(label.split(' ').at(-1)!);
      const read = reading?.roles.find((entry) => COUNT_KINDS[role].includes(entry.kind) && entry.count !== null && singular(entry.noun.split(' ').at(-1)!) === noun)?.count;
      const count = read ?? said.find((entry) => singular(entry.noun) === noun)?.count;
      return count === undefined ? [] : [[role, count] as const];
    }),
  );
}

/** Počty v mezích parametru, do kterého je režim převede (`COUNT_PARAMS`); ostatní se zahodí. `null` = žádný. */
function boundedCounts(spec: GenreSpec, counts: Partial<Record<CountRole, number>>, module: GenreModule): Partial<Record<CountRole, number>> | null {
  const table = (COUNT_PARAMS[spec.genre] as Readonly<Record<string, Readonly<Partial<Record<CountRole, string>>> | undefined>>)[spec.mode] ?? {};
  const kept = Object.entries(counts).flatMap(([role, value]) => {
    const key = table[role as CountRole];
    const range = key === undefined ? undefined : module.paramBounds[key];
    return range === undefined || value === undefined ? [] : [[role, clamp(value, range.min, range.max)] as const];
  });
  return kept.length === 0 ? null : Object.fromEntries(kept);
}

/** Návrh a to, co věta řekne o světle (P54B T11): počasí a denní doba do uloženého `theme`, nic jiného. */
export function draftGameSpecWithMeta(sentence: string, seed = 1, options: DraftOptions = {}): DraftMeta {
  const meta = draftMeta(sentence, seed, options);
  const sky = sentenceSky(sentence, meta.spec.theme);
  return Object.keys(sky).length === 0 ? meta : { ...meta, spec: { ...meta.spec, theme: { ...meta.spec.theme, ...sky } } };
}

function draftMeta(sentence: string, seed: number, options: DraftOptions): DraftMeta {
  const reading = options.reading ?? null;
  const modules = options.modules ?? GENRE_MODULES;
  const scores = scoreArchetypes(sentence);
  const readBy = reading === null ? 'keywords' : 'model';
  if (options.modules === undefined || options.modules === GENRE_MODULES) {
    const intent = extractIntent(sentence);
    const composition = compose(intent, seed, reading);
    const compiled = compileRecipe(composition.recipe);
    const goal = twistGoalFor(sentence, composition.recipe.content, reading);
    const read = readGameSpec(goal === null ? compiled : { ...compiled, tutorial: { ...compiled.tutorial, goalLine: goal } });
    if (!read.ok) throw new Error(`Composed draft is invalid: ${read.issues.join('; ')}`);
    return { spec: read.value, archetype: read.value.archetype, scores, fellBack: false, readBy, genre: composition.recipe.content, genreWhy: `Live recipe ${composition.cellId}`, intent, composition };
  }
  // P32B T2: nová hra jde přes žánr – první režim z pořadí klasifikátoru, který se přeloží.
  // T5b: hrdina, kterého věta říká a žánr neumí (koloběžka v Úkolu), žánr přeskočí; neumí-li ho žádný, platí první.
  const ranking = classifyGenre(sentence, reading, modules);
  const twist = reading === null ? twistFor(sentence, ranking) : null;
  let first: { readonly drafted: NonNullable<ReturnType<typeof draftGenre>>; readonly why: string } | null = null;
  for (const choice of twistFirst(ranking.ranked, twist)) {
    const drafted = draftGenre(sentence, reading, choice, ranking, modules, twist);
    if (drafted === null) continue;
    first ??= { drafted, why: choice.why };
    if (drafted.heroSaid && !heroFits(drafted.genre.genre, drafted.genre.hero, modules)) continue;
    return { spec: drafted.spec, archetype: drafted.spec.archetype, scores, fellBack: false, readBy, genre: drafted.genre, genreWhy: choice.why };
  }
  if (first !== null) return { spec: first.drafted.spec, archetype: first.drafted.spec.archetype, scores, fellBack: false, readBy, genre: first.drafted.genre, genreWhy: first.why };
  // Žádný režim se nepřeložil – mřížka archetypu jako před P32; korpus drží nulu.
  return { ...draftGrid(sentence, seed, scores, reading), fellBack: true };
}

function draftGrid(sentence: string, seed: number, scores: Readonly<Record<ArchetypeId, number>>, reading: Reading | null = null): DraftMeta {
  const archetype = pickArchetype(scores);
  const spec = template(archetype);
  const roles = withPlace(rolesFrom(sentence, reading), sentence);
  const said = readNumbers(sentence);
  const numbers = {
    seconds: reading?.numbers.seconds ?? said.seconds,
    counts: reading !== null && reading.numbers.counts.length > 0 ? reading.numbers.counts : said.counts,
  };
  const readBy = reading === null ? 'keywords' : 'model';
  const rng = xoroshiro128plus(seed);
  const playerLabel = roles.player ?? PLAYER_LABELS[uniformInt(rng, 0, PLAYER_LABELS.length - 1)];

  spec.title = titleFrom(sentence, spec.title);
  role(spec, 'player').label = cap(playerLabel, 60);
  if (roles.setting !== null) spec.theme.setting = cap(roles.setting, 80);
  FILLERS[archetype](spec, { roles, seconds: numbers.seconds, counts: numbers.counts, playerLabel, text: sentence.toLowerCase() });

  const result = readGameSpec(spec);
  if (result.ok) return { spec: result.value, archetype, scores, fellBack: false, readBy, genre: null, genreWhy: null };
  const fallback = template(archetype);
  fallback.title = titleFrom(sentence, fallback.title);
  const normalized = readGameSpec(fallback);
  // Fixtura archetypu ze čtení nic nevzala – štítek „read by a local AI model“ by lhal.
  return { spec: normalized.ok ? normalized.value : fallback, archetype, scores, fellBack: true, readBy: 'keywords', genre: null, genreWhy: null };
}

/** Výchozí volba ovládání, když ho vybral model a slova věty ukazují jinam. */
const DEFAULT_CHOICE: Readonly<Record<ControlChoice['control'], ControlChoice>> = {
  runner: { control: 'runner', density: null },
  platform: { control: 'platform', difficulty: null, movingPlatforms: false, doubleJump: false },
  flap: { control: 'flap', difficulty: null },
  steer: { control: 'steer', difficulty: null, drift: false },
  move_free: { control: 'move_free', density: null },
  shooter: { control: 'shooter', difficulty: null },
  throw: { control: 'throw', difficulty: null, goal: null },
  timing: { control: 'timing', mode: 'stack', speed: null },
  rhythm: { control: 'rhythm', density: null },
  duel: { control: 'duel', difficulty: null },
};

/**
 * `GenreSpec`, který věta dá v zadaném režimu (P32B T5): role ze slov, jinak
 * výchozí z prostředí. Kontrola věrnosti z něj čte hrdinu a nepřítele věty,
 * oprava režiséra jím nahradí role, které odpověď napsala mimo větu. `null` =
 * režim se nepřeloží.
 */
export function draftGenreFor(sentence: string, genre: GenreId, mode: string, options: DraftOptions = {}): GenreSpec | null {
  const reading = options.reading ?? null;
  const modules = options.modules ?? GENRE_MODULES;
  const ranking = classifyGenre(sentence, reading, modules);
  const choice = ranking.ranked.find((entry) => entry.genre === genre && entry.mode === mode);
  return choice === undefined ? null : (draftGenre(sentence, reading, choice, ranking, modules, reading === null ? twistFor(sentence, ranking) : null)?.genre ?? null);
}

/** Slovesa vět mimo hry (P37A T4): papíry, spor s protějškem, vyhnout se, čekat, domácí práce – role jim dá absurdní přenos. */
const OFF_TOPIC_VERBS = new Set(['argue', 'negotiate', 'convince', 'say no', 'break up', 'hide', 'ignore', 'refuse', 'wait', 'fall asleep', 'present', 'fold', 'iron']);
/** Věta, která o hru výslovně žádá („a cozy game“, „boss level“), přenos nedostane. */
const GAME_ASK = /\b(?:games?|simulator|sim|levels?|rpg|vs)\b/;

/**
 * Absurdní přenos (P37A T5) pro větu mimo hry: žádné sloveso ani narážka, nebo
 * sloveso vět mimo hry z T4 („pay the bill“, „argue with my wife“). `null` jinde a u věty,
 * kterou přečetl model – jeho role mají přednost.
 */
function twistFor(sentence: string, ranking: GenreRanking): Twist | null {
  if (GAME_ASK.test(sentence.toLowerCase())) return null;
  const unheard = (ranking.ranked[0]?.score ?? 0) === 0;
  const offTopic = ranking.verb !== null && (OFF_TOPIC_VERBS.has(ranking.verb) || familyOf(ranking.verb)?.id === 'paperwork');
  return unheard || offTopic ? twistOf(sentence) : null;
}

/**
 * Cíl přenosu (P37A T5) pro žánrový spec věty – i pro AI verzi (`readGenreAnswer`),
 * ať v HUD říká totéž co návrh. `null` u věty bez přenosu a u věty přečtené modelem.
 */
export function twistGoalFor(sentence: string, genre: GenreSpec, reading: Reading | null = null, modules: GenreModules = GENRE_MODULES): string | null {
  if (reading !== null || twistFor(sentence, classifyGenre(sentence, null, modules)) === null) return null;
  return twistGoal(genre, sentence);
}

/** Věta bez slovesa hraje Arénu podle nálady: co děsí, hrdinu honí (útěk), jinak se věc věty sbírá. */
function twistFirst(ranked: readonly GenreChoice[], twist: Twist | null): readonly GenreChoice[] {
  if (twist === null || (ranked[0]?.score ?? 0) > 0) return ranked;
  const mode = twist.foe === null ? 'collect' : 'escape';
  const first = ranked.find((choice) => choice.genre === 'arena' && choice.mode === mode);
  return first === undefined ? ranked : [{ ...first, why: `no game verb – ${mode === 'escape' ? 'dodge' : 'collect'} what the sentence names` }, ...ranked.filter((choice) => choice !== first)];
}

/** Shared fallback ordering for a sentence with no recognized gameplay action. */
export function draftChoiceOrder(sentence: string, ranking: GenreRanking, reading: Reading | null): readonly GenreChoice[] {
  return twistFirst(ranking.ranked, reading === null ? twistFor(sentence, ranking) : null);
}

/**
 * Návrh ze slov pro ovládání, které vybral někdo jiný (P27D T2, kompaktní
 * režie): parametry z věty, když slova ukazují na totéž ovládání, jinak
 * výchozí volba. `null` jen když šablona s popisky věty neprojde schématem.
 */
export function draftForControl(sentence: string, control: ControlId, seed = 1): GameSpecV1 | null {
  if (control === 'tap_go') return draftGrid(sentence, seed, scoreArchetypes(sentence)).spec;
  // Native recipe controls and the P54C genre controls do not have a legacy single-control template.
  if (!Object.hasOwn(DEFAULT_CHOICE, control)) return null;
  const pick = pickControl(sentence.toLowerCase());
  return draftArcade(sentence, seed, pick?.control === control ? pick : DEFAULT_CHOICE[control as ControlChoice['control']]);
}

/** Věta → validní `GameSpecV1`, nikdy `null`, nikdy výjimka. */
export function draftGameSpec(sentence: string, seed = 1): GameSpecV1 {
  return draftGameSpecWithMeta(sentence, seed).spec;
}
