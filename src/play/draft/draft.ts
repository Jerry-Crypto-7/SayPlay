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

import { ARCHETYPE_IDS, type ArchetypeId } from '../registry';
import { readGameSpec, type GameSpecV1 } from '../spec';
import chaseEscape from '../__fixtures__/chase_escape.json';
import checkpointRace from '../__fixtures__/checkpoint_race.json';
import collectExit from '../__fixtures__/collect_exit.json';
import combatLite from '../__fixtures__/combat_lite.json';
import delivery from '../__fixtures__/delivery.json';
import deliveryOrders from '../__fixtures__/delivery_orders.json';
import hazardCrossing from '../__fixtures__/hazard_crossing.json';
import survivalTimer from '../__fixtures__/survival_timer.json';
import switchPuzzle from '../__fixtures__/switch_puzzle.json';

import flapTemplate from '../arcade/__fixtures__/flap.json';
import platformTemplate from '../arcade/__fixtures__/platform.json';
import runnerTemplate from '../arcade/__fixtures__/runner.json';
import steerTemplate from '../arcade/__fixtures__/steer.json';
import arenaTemplate from '../arcade/__fixtures__/arena.json';

import { type ControlChoice, pickControl } from './controls';
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
  plural,
  readNumbers,
  readRoles,
  scoreArchetypes,
  singular,
  type SentenceRoles,
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
  readonly spec: GameSpecV1;
  readonly archetype: ArchetypeId;
  readonly scores: Readonly<Record<ArchetypeId, number>>;
  /** Návrh neprošel `readGameSpec` a vrátila se fixtura archetypu. Korpus drží nulu. */
  readonly fellBack: boolean;
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
  const title = words.length === 0 ? fallback : titleCase(words);
  return title.slice(0, 80);
}

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

function cap(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
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
    const chaser = role(spec, 'roomba');
    chaser.label = label(read.roles.chaser, chaser.label);
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

const ARCADE_TEMPLATES = { runner: runnerTemplate, platform: platformTemplate, flap: flapTemplate, steer: steerTemplate, move_free: arenaTemplate } as const;

/**
 * Arkádová hra (P25A běžec, P25C plošinovka a poletování): šablona fixtury
 * ovládání, přepíše se titul, popisky a parametry, které věta řekla.
 */
function draftArcade(sentence: string, seed: number, choice: ControlChoice): GameSpecV1 | null {
  const spec = JSON.parse(JSON.stringify(ARCADE_TEMPLATES[choice.control])) as GameSpecV1;
  const roles = readRoles(sentence);
  const rng = xoroshiro128plus(seed);
  spec.title = titleFrom(sentence, spec.title);
  // Ptáček poletování, závodní auto a rybka arény zůstanou, když věta hráče nejmenuje.
  const keeps = choice.control === 'flap' || choice.control === 'steer' || choice.control === 'move_free';
  const fallback = keeps ? role(spec, 'player').label : PLAYER_LABELS[uniformInt(rng, 0, PLAYER_LABELS.length - 1)];
  role(spec, 'player').label = cap(roles.player ?? fallback, 60);
  // Závod sbírá turbo, ne mince.
  if (roles.collectible !== null && choice.control !== 'steer') role(spec, 'coin').label = cap(roles.collectible, 60);
  if (roles.setting !== null) spec.theme.setting = cap(roles.setting, 80);
  if (choice.control === 'runner') {
    if (choice.density !== null) spec.controlParams = { ...spec.controlParams, density: choice.density };
  } else if (choice.control === 'platform') {
    spec.controlParams = {
      ...spec.controlParams,
      ...(choice.difficulty === null ? {} : { difficulty: choice.difficulty }),
      ...(choice.movingPlatforms ? { movingPlatforms: true } : {}),
      ...(choice.doubleJump ? { doubleJump: true } : {}),
    };
  } else if (choice.control === 'steer') {
    spec.controlParams = { ...spec.controlParams, ...(choice.difficulty === null ? {} : { difficulty: choice.difficulty }), ...(choice.drift ? { drift: true } : {}) };
  } else if (choice.control === 'move_free') {
    if (choice.density !== null) spec.controlParams = { ...spec.controlParams, density: choice.density };
  } else if (choice.difficulty !== null) spec.controlParams = { ...spec.controlParams, difficulty: choice.difficulty };
  const result = readGameSpec(spec);
  return result.ok ? result.value : null;
}

export function draftGameSpecWithMeta(sentence: string, seed = 1): DraftMeta {
  const scores = scoreArchetypes(sentence);
  const control = pickControl(sentence.toLowerCase());
  if (control !== null) {
    const arcade = draftArcade(sentence, seed, control);
    if (arcade !== null) return { spec: arcade, archetype: arcade.archetype, scores, fellBack: false };
  }
  const archetype = pickArchetype(scores);
  const spec = template(archetype);
  const roles = readRoles(sentence);
  const numbers = readNumbers(sentence);
  const rng = xoroshiro128plus(seed);
  const playerLabel = roles.player ?? PLAYER_LABELS[uniformInt(rng, 0, PLAYER_LABELS.length - 1)];

  spec.title = titleFrom(sentence, spec.title);
  role(spec, 'player').label = cap(playerLabel, 60);
  if (roles.setting !== null) spec.theme.setting = cap(roles.setting, 80);
  FILLERS[archetype](spec, { roles, seconds: numbers.seconds, counts: numbers.counts, playerLabel, text: sentence.toLowerCase() });

  const result = readGameSpec(spec);
  if (result.ok) return { spec: result.value, archetype, scores, fellBack: false };
  const fallback = template(archetype);
  fallback.title = titleFrom(sentence, fallback.title);
  const normalized = readGameSpec(fallback);
  return { spec: normalized.ok ? normalized.value : fallback, archetype, scores, fellBack: true };
}

/** Věta → validní `GameSpecV1`, nikdy `null`, nikdy výjimka. */
export function draftGameSpec(sentence: string, seed = 1): GameSpecV1 {
  return draftGameSpecWithMeta(sentence, seed).spec;
}
