/**
 * Který model katalogu kreslí role arkády – z popisku role (P26 T12).
 *
 * Arkáda a mřížka mají jeden katalog `src/assets/catalog.json` (102 modelů);
 * arkáda z něj čte štíhlý index `catalog-index.json`, který píše `promote.mjs`.
 * Popisek se čte od posledního slova (hlava fráze: „cardboard robot“ je robot,
 * ne karton): přímé slovo → tag katalogu → jednotné číslo. Postava, kterou
 * katalog nemá, dostane nejbližší kategorii (zvíře, člověk, stroj, příšera),
 * a teprve slovo bez kategorie výchozí model role. Věc bez modelu (ponožka,
 * banán) kategorii nemá – kvádr ani kovboj by ji nepředstavovaly poctivě; tu
 * dodá až generování (T13/T15).
 *
 * Hráče, nepřítele a soupeře vybírá od P32C `heroChoice` z manifestu hrdinů
 * (`src/play/assets/entries/*`): identita, blízká identita, třída, výchozí
 * model role – a hlásí, na které úrovni vybral.
 *
 * Čisté funkce mimo React (P26 T5): tabulka schopností `src/play/capabilities.ts`
 * tvrdí, které popisky vykreslení čte, a test to ověřuje právě tady.
 */

import catalog from '@/assets/catalog-index.json';

import rigged from '@/assets/rigged.json';

import { BASE_ENTRIES } from '../assets/entries/base';
import { CATALOG_ENTRIES } from '../assets/entries/catalog';
import { RIGGED_P32_ENTRIES } from '../assets/entries/rigged-p32';
import type { AssetEntry } from '../assets/manifest';
import { controlOf, readsLabel } from '../capabilities';
import type { GenreId, ModelClass } from '../genre/contract';
import { GENRE_MODULES } from '../genre/index';
import { CROSSING } from '../genre/voyage';
import type { ControlId, GameSpecV1 } from '../spec';
import type { ClipState } from './motion';
import nearest from './nearest.json';
import { OBSTACLE_KINDS } from './pieces/runner';

const GAME_BASE = '/assets/worldstream/game/';

/** Id modelu → cesta k jeho LOD1 v katalogu. */
const PATHS: ReadonlyMap<string, string> = new Map(
  catalog.assets.map((asset) => [asset.assetId, asset.path]),
);

/** Štítek slepého soudu P43: model, který porotce nepozná, jméno z věty nedostane. */
export const UNRECOGNISABLE = 'qa:unrecognisable';

/** Jméno, které slepý soud P43 modelu dal místo jeho vlastního (`scripts/p43/apply-verdicts.mjs`). */
const SEEN = 'seen:';

/**
 * Tag → model. Tag, který nese víc modelů (`robot`), patří tomu, který se tak jmenuje.
 * Jméno ze slepého soudu (`seen:cake` u pizzy, která vypadá jako dort) dostane slovo
 * jen tehdy, když ho žádný model nenese vlastním tagem – ani jeho hlavní (poslední) slovo:
 * `seen:security guard` u zloděje by jako dvojslovný tag přebil strážného s tagem `guard`.
 */
export function tagIndex(assets: ReadonlyArray<{ readonly assetId: string; readonly tags: readonly string[] }>): ReadonlyMap<string, string> {
  const index = new Map<string, string>();
  const known = assets.filter((asset) => !asset.tags.includes(UNRECOGNISABLE));
  for (const asset of known) {
    for (const tag of [asset.assetId, ...asset.tags]) {
      if (tag.startsWith(SEEN)) continue;
      if (!index.has(tag) || tag === asset.assetId) index.set(tag, asset.assetId);
    }
  }
  const own = new Set(index.keys());
  const ownHead = (word: string): boolean => {
    const head = word.split(' ').at(-1)!;
    return head !== word && [head, ...singulars(head)].some((form) => own.has(form));
  };
  for (const asset of known) {
    for (const tag of asset.tags) {
      const word = tag.startsWith(SEEN) ? tag.slice(SEEN.length) : undefined;
      if (word !== undefined && !index.has(word) && !ownHead(word)) index.set(word, asset.assetId);
    }
  }
  return index;
}

const BY_TAG = tagIndex(catalog.assets);

/** Slova, která tag katalogu nese jinak, než je myslí věta: pták je postava (primitiv `bird`), ne hnízdo. */
const WORD_SENSE: Readonly<Record<string, string>> = {
  bird: 'bird',
  birds: 'bird',
  // P35: tag `fish` nese i akvárium (sklo, voda, písek) – „glowing fish“ v O10 kreslil akvária.
  fish: 'cc0-goldfish',
  // P35: `gen3d-tortoise` má hlavu odtrženou od těla; vlastní želva z `game_models.py`.
  turtle: 'turtle',
  tortoise: 'turtle',
};

/** Nejbližší model pro slovo, které katalog jako tag nemá; přesný tag vyhrává (CC0 zombie, drak, včela). */
const WORD_MODEL: Readonly<Record<string, string>> = {
  jet: 'plane',
  helicopter: 'drone',
  ufo: 'rocket',
  submarine: 'rowing-boat',
  canoe: 'rowing-boat',
  kayak: 'rowing-boat',
  zombie: 'goblin',
  alien: 'goblin',
  dragon: 'goblin',
  demon: 'goblin',
  vampire: 'goblin',
  skeleton: 'goblin',
  dinosaur: 'goblin',
  dino: 'goblin',
  mummy: 'goblin',
  werewolf: 'goblin',
  ogre: 'goblin',
  mouse: 'hamster',
  squirrel: 'hamster',
  puppy: 'dog',
  wolf: 'dog',
  chef: 'waiter',
  bee: 'wasp-nest',
  marine: 'astronaut',
};

/** Nejbližší kategorie postavy, kterou katalog nemá. */
const CATEGORY: ReadonlyArray<readonly [model: string, words: readonly string[]]> = [
  ['fox', ['animal', 'bear', 'lion', 'tiger', 'pig', 'cow', 'horse', 'sheep', 'goat', 'chicken', 'monkey', 'panda', 'koala', 'deer', 'hedgehog', 'turtle', 'frog', 'snake', 'lizard', 'owl', 'bat', 'sloth', 'llama', 'giraffe', 'elephant', 'zebra', 'otter', 'beaver', 'badger']],
  ['explorer', ['man', 'woman', 'person', 'guy', 'lady', 'hero', 'heroine', 'soldier', 'ninja', 'pirate', 'cowboy', 'wizard', 'witch', 'princess', 'prince', 'king', 'queen', 'cop', 'police', 'officer', 'guard', 'thief', 'farmer', 'doctor', 'nurse', 'teacher', 'student', 'runner', 'athlete', 'skater', 'surfer', 'viking', 'samurai', 'spy', 'agent', 'courier', 'player', 'grandma', 'grandpa', 'baby', 'shopper', 'tourist']],
  ['robot', ['machine', 'mech', 'tank', 'truck', 'train', 'bus', 'tractor', 'bulldozer', 'forklift', 'cyborg', 'toaster']],
];

const CATEGORY_OF: ReadonlyMap<string, string> = new Map(CATEGORY.flatMap(([model, words]) => words.map((word) => [word, model] as const)));

/** Jednotné číslo pro vyhledání – jen tvary, které korpus opravdu nese. */
function singulars(word: string): readonly string[] {
  const out: string[] = [];
  if (word.endsWith('ies')) out.push(`${word.slice(0, -3)}y`);
  if (word.endsWith('es')) out.push(word.slice(0, -2));
  if (word.endsWith('s')) out.push(word.slice(0, -1));
  if (word.endsWith('men')) out.push(`${word.slice(0, -3)}man`);
  // P39 T9: „wolves“ → „wolf“, „knives“ → „knife“.
  if (word.endsWith('ves')) out.push(`${word.slice(0, -3)}f`, `${word.slice(0, -3)}fe`);
  return out;
}

function lookup<T>(word: string, index: (form: string) => T | undefined): T | undefined {
  for (const form of [word, ...singulars(word)]) {
    const found = index(form);
    if (found !== undefined) return found;
  }
  return undefined;
}

const wordsOf = (label: string): string[] => label.toLowerCase().match(/[a-z][a-z-]*/g) ?? [];

/**
 * Model katalogu (nebo primitiv `bird`), který popisek jmenuje tagem; s `near` i náhrada
 * z `WORD_MODEL`. Dvojslovný tag vyhrává nad hlavou fráze (P30B T4): „lily pads“ je leknín,
 * ne květ lilie, „tire barrier“ mantinel z pneumatik, ne kamenná zeď.
 */
function tagModel(label: string, near: boolean): string | undefined {
  const words = wordsOf(label);
  for (let index = words.length - 1; index >= 0; index -= 1) {
    const word = words[index] as string;
    const before = words[index - 1];
    const pair = before === undefined ? undefined : lookup(word, (form) => BY_TAG.get(`${before} ${form}`) ?? BY_TAG.get(`${before}-${form}`));
    const found = pair ?? lookup(word, (form) => WORD_SENSE[form] ?? BY_TAG.get(form) ?? (near ? WORD_MODEL[form] : undefined));
    if (found !== undefined) return found;
  }
  return undefined;
}

/** Nejbližší model ze `WORD_MODEL` pro první slovo odzadu, které tam je. */
function nearModel(label: string): string | undefined {
  for (const word of wordsOf(label).reverse()) {
    const found = lookup(word, (form) => WORD_MODEL[form]);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** Zástupce kategorie postavy (zvíře, člověk, stroj) pro první slovo odzadu, které nějakou má. */
function categoryModel(label: string): string | undefined {
  for (const word of wordsOf(label).reverse()) {
    const found = lookup(word, (form) => CATEGORY_OF.get(form));
    if (found !== undefined) return found;
  }
  return undefined;
}

/**
 * Lidé z vět mimo hry (P37A T6), které katalog nemá a vektory popisků nenajdou: model postavy
 * jen pro scénu. Do `CATEGORY` nepatří – `modelOf` čte i návrh (`twist.ts`, `topicHero`).
 */
const PEOPLE: ReadonlyArray<readonly [model: string, words: readonly string[]]> = [
  ['gen3d-investor', ['boss', 'manager', 'supervisor', 'landlord', 'banker', 'accountant', 'lawyer', 'auditor', 'recruiter', 'salesman', 'client', 'interviewer', 'examiner', 'inspector', 'advisor', 'adviser', 'clerk', 'principal', 'professor', 'judge', 'critic', 'coworker', 'co-worker', 'colleague', 'receptionist', 'cashier', 'operator', 'telemarketer']],
  ['gen3d-mom', ['wife', 'girlfriend', 'sister', 'aunt', 'granny', 'grandmother', 'mum']],
  ['kid', ['toddler', 'son', 'daughter', 'teenager']],
  ['explorer', ['husband', 'boyfriend', 'dad', 'father', 'brother', 'uncle', 'cousin', 'friend', 'roommate', 'partner', 'neighbor', 'neighbour', 'stranger', 'coach', 'relative', 'bully', 'dentist', 'in-law', 'parent', 'ex']],
];

const PERSON_OF: ReadonlyMap<string, string> = new Map(PEOPLE.flatMap(([model, words]) => words.map((word) => [word, model] as const)));

/** Člověk z `PEOPLE` pro první slovo odzadu, které tam je. */
function personModel(label: string): string | undefined {
  for (const word of wordsOf(label).reverse()) {
    const found = lookup(word, (form) => PERSON_OF.get(form));
    if (found !== undefined) return found;
  }
  return undefined;
}

/**
 * Práh nejbližšího modelu: nad nejlepším skóre, které dá abstraktní slovo bez modelu
 * (`abstractCeiling` v `nearest.json`, „fashion → dress“ 0,62); test hlídá, že nad ním zůstane.
 */
export const NEAREST_MIN = 0.63;

/**
 * Práh nejbližšího modelu pro věc z věty, která jinak dostane robota nebo bodák (P39 T9):
 * od 0,5 páry souvisí (aligátor → krokodýl 0,55, úl → včela 0,51), pod ním je šum (keř → kočka 0,47).
 */
const LOOSE_MIN = 0.5;

const NEAREST: ReadonlyMap<string, readonly [id: string, score: number]> = new Map(Object.entries(nearest.words) as [string, [string, number]][]);

/**
 * Nejbližší model katalogu pro slovo, které katalog tagem nemá (P37A T6): tabulka
 * `nearest.json` z vektorů popisků (`scripts/p37a/nearest.mjs`). Rozhoduje hlava fráze,
 * dvojslovo napřed („fishing rod“); hlava pod prahem hledání ukončí, ať přívlastek
 * („quantum physics“) nedostane model za ni. `loose` = poslední možnost těla z věty (P39 T9):
 * nižší práh `LOOSE_MIN` a jen hlava fráze – přívlastek pod prahem čtení dává šum.
 */
function nearestModel(label: string, loose = false): string | undefined {
  const words = wordsOf(label);
  for (let index = words.length - 1; index >= 0; index -= 1) {
    const word = words[index] as string;
    const before = words[index - 1];
    const found = (before === undefined ? undefined : lookup(word, (form) => NEAREST.get(`${before} ${form}`))) ?? lookup(word, (form) => NEAREST.get(form));
    if (found === undefined && loose) return undefined;
    if (found === undefined) continue;
    const min = loose ? LOOSE_MIN : NEAREST_MIN;
    if (found[1] < min) return undefined;
    const entry = ENTRY_OF_ID.get(found[0]);
    return entry === undefined ? found[0] : sceneId(entry);
  }
  return undefined;
}

/**
 * Model, který scéna pro popisek kreslí, v pořadí `choose` bez hranic tříd: `modelOf`,
 * před kategorií nejbližší model katalogu a u postav i člověk z `PEOPLE`. Čtou ho rekvizity
 * a řetěz věrnosti; návrh dál čte `modelOf`, ať se žánr a role věty nemění.
 */
export function sceneModelOf(label: string, character: boolean): string | undefined {
  return tagModel(label, true) ?? nearestModel(label) ?? (character ? (categoryModel(label) ?? personModel(label) ?? riggedModelOf(label)) : undefined);
}

/**
 * Model katalogu (nebo primitiv `bird`), který popisek jmenuje; kategorie jen u postav.
 * Postava, kterou katalog nemá, ale manifest ano (králík, P35 T1), dá id scény
 * riggované postavy – mřížka ho v katalogu nenajde a nakreslí kus, draft ví, že ji scéna umí.
 */
export function modelOf(label: string, character: boolean): string | undefined {
  return tagModel(label, true) ?? (character ? (categoryModel(label) ?? riggedModelOf(label)) : undefined);
}

/** Kolikrát výšky těla smí postava sahat do šířky nebo hloubky, než se zmenší. */
const CHARACTER_REACH = 1.5;

/**
 * Měřítko modelu vepsaného do těla (P30B T3). Věc se vepíše celá, nejužší osou;
 * postava výškou těla, jen dlouhá nízká (had) se zastaví na `CHARACTER_REACH`
 * výšky – jinak by široký slon stál ve třetině výšky a na snímku by nebyl poznat.
 */
export function fitScale(model: { x: number; y: number; z: number }, body: { x: number; y: number; z: number }, character: boolean): number {
  const along = (size: number): number => Math.max(size, 1e-3);
  const scale = character
    ? Math.min(body.y / along(model.y), (CHARACTER_REACH * body.y) / along(Math.max(model.x, model.z)))
    : Math.min(body.x / along(model.x), body.y / along(model.y), body.z / along(model.z));
  return scale || 1;
}

/** Hrdina z popisku hráče (`heroChoice`); bez shody ptáček u poletování, auto v závodě, jinak `explorer`. */
export function heroModel(spec: GameSpecV1): string {
  return heroChoice(spec.roles.find((role) => role.kind === 'player')?.label ?? '', spec.genre?.id, spec.control).model;
}

/** Popisek nepřítele střelnice (role `enemy`, kořist, hlídka, soupeř souboje), nebo prázdný. */
function enemyLabel(spec: GameSpecV1): string {
  // B-R9: soupeř souboje žánru arény je role druhu `hazard` (`rival`), ne role `enemy`.
  const rival = spec.controlParams?.generator === 'fight' ? spec.roles.find((role) => role.kind === 'hazard') : undefined;
  const native = spec.control === 'walker' || spec.control === 'ball' ? spec.roles.find(role => role.kind === 'patrol') : undefined;
  const prey = spec.controlParams?.generator === 'arena_catch' ? spec.roles.find(role => role.id === 'prey') : undefined;
  return spec.roles.find((role) => role.id === 'enemy')?.label ?? prey?.label ?? native?.label ?? rival?.label ?? '';
}

/** Nepřátelé střelnice: model z popisku role `enemy` (`heroChoice`), jinak robot. */
export function enemyModel(spec: GameSpecV1): string {
  return heroChoice(enemyLabel(spec), undefined, spec.control, 'enemy').model;
}

/** Popisek a model pronásledovatele: role druhu `chaser`, když pro ni je model, jinak nepřítel. */
function chaserChoice(spec: GameSpecV1): { readonly label: string; readonly model: string } {
  const label = spec.roles.find((role) => role.kind === 'chaser')?.label ?? '';
  const own = choose(label, ANY, { withClass: true, loose: true })?.model;
  return own === undefined ? { label: enemyLabel(spec), model: enemyModel(spec) } : { label, model: own };
}

/** Pronásledovatel doplňku `+chaser` (P26D): model z popisku role druhu `chaser` („bear“), jinak jako nepřítel. */
export function chaserModel(spec: GameSpecV1): string {
  return chaserChoice(spec).model;
}

/**
 * Jméno z věty pro tělo, které scéna kreslí modelem pronásledovatele (nepřátelé průběhu a boss, P46B T7):
 * popisek role, ze které `chaserModel` model vzal; věta bez něj `undefined`.
 */
export function chaserName(spec: GameSpecV1): string | undefined {
  const { label } = chaserChoice(spec);
  return label === '' ? undefined : label;
}

/**
 * Role arkády, jejichž těla smí nést model z popisku: sbíraná mince, překážka běžce, terč hodu, soupeř souboje
 * a závodu (P27A T4); od P30B T4 i mantinel závodu, nota rytmu a díl věže načasování; od P35 T3 cíl skákačky;
 * od P39 T9 nástrahy `HAZARD_ROLES`.
 */
export const PROP_ROLES = ['coin', 'obstacle', 'target', 'rival', 'barrier', 'turbo', 'note', 'block', 'finish', 'spikes', 'pipe', 'hazard'] as const;
export type PropRole = (typeof PROP_ROLES)[number];

/**
 * Nástrahy, které jádro kreslí primitivem (P39 T9): bodák skákačky, trubka poletování, útes a koule plavby.
 * Věc z věty („wolves“) je kreslí svým jménem i jako postava; výchozí popisek žánru zůstane primitivem.
 */
const HAZARD_ROLES: ReadonlySet<PropRole> = new Set(['spikes', 'pipe', 'hazard']);

/**
 * Role, jejíž tělo kreslí věc z věty jménem i postavou a nejbližším modelem: nástrahy (P39 T9) a od P39 T14
 * terč střelnice – volné místo terče bere další věc z věty (mince, duch), kotouč zůstane jen holému terči.
 */
function namesThing(control: ControlId, id: PropRole): boolean {
  return HAZARD_ROLES.has(id) || (id === 'target' && control === 'shooter');
}

/**
 * Popisek, kterým žánr nástrahu vyplní, když věta nic nejmenuje (`genre/platformer.ts`, `flap.ts`, `voyage.ts`).
 * Holý terč střelnice („target“) sem nepatří: dá model `target`, a ten `OWN_KINDS` vrátí kotouči.
 */
const OWN_LABELS: Partial<Record<PropRole, readonly string[]>> = { spikes: ['spikes'], pipe: ['pipe'], hazard: Object.values(CROSSING) };

/** Co jádro pro roli kreslí samo; popisek, který jmenuje právě tohle („obstacles“), nic nemění. */
const OWN_KINDS: Readonly<Record<PropRole, readonly string[]>> = {
  coin: ['coin'],
  obstacle: OBSTACLE_KINDS,
  target: ['target', 'wood-block'],
  // „rival car“ je auto soupeře; hráčovo závodní auto by soupeře od hráče nerozlišilo.
  rival: ['rival-car', 'race-car'],
  // „barriers“ je v katalogu překážka běžce; obecný popisek mantinelu nechá pneumatiky.
  barrier: ['tire-barrier', 'hurdle'],
  turbo: ['turbo'],
  // Nota a díl věže jsou v jádře barevné kvádry; „tiles“ a „blocks“ jmenují právě je.
  note: ['hazard-tile'],
  block: ['wood-block'],
  finish: ['finish-flag'],
  spikes: ['cc0-spike'],
  pipe: ['cc0-pipe'],
  hazard: [],
};

/** Model soupeře: přesná nebo blízká identita, žádná třída; v závodě jen vozidlo, loď nebo letadlo. */
function rivalModel(label: string, control: string): string | undefined {
  return choose(label, control === 'steer' ? { identity: rides, rest: rides } : ANY, { withClass: false })?.model;
}

/**
 * Model, který popisek role jmenuje – i tělo, které jádro kreslí samo („rival car“
 * je auto soupeře). Řetěz věrnosti z toho soudí, jestli scéna kreslí, co věta chtěla.
 */
export function namedProps(spec: GameSpecV1): Partial<Record<PropRole, string>> {
  const out: Partial<Record<PropRole, string>> = {};
  const control = controlOf(spec);
  for (const id of PROP_ROLES) {
    const role = spec.roles.find((candidate) => candidate.id === id || (spec.control === 'glide' && id === 'rival' && candidate.id === 'glide_rival'));
    if (role === undefined || !readsLabel(control, role)) continue;
    // Nástraha i terč střelnice z věty bývá zvíře („animals“) – smí i třídu postav.
    const found = id === 'rival' ? rivalModel(role.label, control) : sceneModelOf(role.label, namesThing(control, id));
    if (found !== undefined && found !== 'bird') out[id] = found;
  }
  // B-R9: žánr arény (spec s generátorem) sbírá roli druhu `collectible` (`item`) – scéna ji kreslí jako `coin`.
  const item = typeof spec.controlParams?.generator === 'string' && out.coin === undefined ? spec.roles.find((role) => role.kind === 'collectible') : undefined;
  const itemModel = item === undefined ? undefined : sceneModelOf(item.label, false);
  if (itemModel !== undefined && itemModel !== 'bird') out.coin = itemModel;
  return out;
}

/**
 * Modely rekvizit, které scéna kreslí místo těla jádra – jen přímá shoda s katalogem, bez kategorií.
 * Nástraha a terč střelnice z věty (`namesThing`) berou i třídu a nejbližší model: primitiv jen tam, kde věta nic nejmenuje.
 */
export function propModels(spec: GameSpecV1): Partial<Record<PropRole, string>> {
  const named = namedProps(spec);
  const control = controlOf(spec);
  const out: Partial<Record<PropRole, string>> = {};
  for (const id of PROP_ROLES) {
    const model = namesThing(control, id) ? hazardModel(spec, id) : named[id];
    // Native glide draws a navigation ring, so even the standard coin needs
    // its named model at the pickup body rather than the legacy coin primitive.
    if (model !== undefined && (control === 'glide' && id === 'coin' || !OWN_KINDS[id].includes(model))) out[id] = model;
  }
  return out;
}

/** Model nástrahy (nebo terče střelnice) z popisku její role; výchozí popisek žánru (`OWN_LABELS`) žádný nedá. */
function hazardModel(spec: GameSpecV1, id: PropRole): string | undefined {
  const role = spec.roles.find((candidate) => candidate.id === id);
  if (role === undefined || OWN_LABELS[id]?.includes(role.label) === true) return undefined;
  return choose(role.label, ANY, { withClass: true, loose: true })?.model;
}

/** Id modelu riggované postavy s klipy (`src/assets/rigged.json`, P26B) nese tuhle předponu, ať se nesrazí s katalogem. */
export const RIGGED_PREFIX = 'rigged:';

/** Stav, na který model klip nemá (manifest, `src/play/assets/manifest.ts`): pohyb dopočítá kód. */
export const PROCEDURAL_CLIP = 'procedural';

/** Jak blízko má model k popisku (P32C T2) – pro panel čtení. */
export type ChoiceLevel = 'identity' | 'near' | 'class' | 'fallback';

export interface ModelChoice {
  /** Id modelu scény: `rigged:` + postava s klipy, jinak id katalogu nebo primitiv. */
  readonly model: string;
  readonly level: ChoiceLevel;
  /** Záznam manifestu; věc mimo manifest (ponožka) a primitiv `bird` ho nemají. */
  readonly entry: AssetEntry | undefined;
}

/** Manifest hrdinů (P32C): riggované postavy a tučňák napřed, animovaní hrdinové vět P32, pak modely katalogu. */
const MANIFEST: readonly AssetEntry[] = [...BASE_ENTRIES, ...RIGGED_P32_ENTRIES, ...CATALOG_ENTRIES];

const animated = (entry: AssetEntry): boolean => Object.values(entry.clips).some((clip) => clip !== PROCEDURAL_CLIP);

/** Model s klipy kreslí `RiggedModel` (předpona), statický `FittedModel` podle id katalogu. */
const sceneId = (entry: AssetEntry): string => (animated(entry) ? `${RIGGED_PREFIX}${entry.id}` : entry.id);

const bareId = (id: string): string => id.replace(/^(cc0|gen3d)-/, '');

/** Slovo identity nebo holé id („rival-car“) → záznamy v pořadí manifestu. */
const BY_IDENTITY: ReadonlyMap<string, readonly AssetEntry[]> = (() => {
  const index = new Map<string, AssetEntry[]>();
  for (const entry of MANIFEST) {
    for (const word of new Set([...entry.identity, bareId(entry.id)])) index.set(word, [...(index.get(word) ?? []), entry]);
  }
  return index;
})();

const ENTRY_OF_MODEL: ReadonlyMap<string, AssetEntry> = new Map(MANIFEST.map((entry) => [sceneId(entry), entry]));

/** Id katalogu z `nearest.json` → záznam manifestu (postava s klipy dostane id scény s předponou). */
const ENTRY_OF_ID: ReadonlyMap<string, AssetEntry> = new Map(MANIFEST.map((entry) => [entry.id, entry]));

/** Třída modelu scény; věc mimo manifest je rekvizita, primitiv `bird` pták. */
const classOfModel = (model: string): ModelClass => ENTRY_OF_MODEL.get(model)?.class ?? (model === 'bird' ? 'bird' : 'prop');

/** Co závod unese bez žánru: hráč jede, tělo jádra je vozidlo. */
const RIDE: ReadonlySet<ModelClass> = new Set(['vehicle', 'boat', 'aircraft']);
const rides = (kind: ModelClass): boolean => RIDE.has(kind);

interface Bounds {
  /** Třídy, které smí vybrat přesná identita. */
  readonly identity: (kind: ModelClass) => boolean;
  /** Třídy pro blízkou identitu, jízdu z přívlastku a třídu. */
  readonly rest: (kind: ModelClass) => boolean;
}

const ANY: Bounds = { identity: () => true, rest: () => true };

/**
 * Záznam manifestu, který popisek jmenuje. Čte se od hlavy fráze jako `modelOf`
 * a dvojslovo („polar bear“) vyhrává nad hlavou. Když slovo nese víc záznamů,
 * rozhodne, kolik dalších slov popisku znají („skeleton warriors“ → kostlivec),
 * pak klipy (postava, která se hýbe), pak holé id („robot“ je robot, ne vysavač).
 * Slovo, jehož záznamy hranice nepustí, hledání ukončí – přívlastek před ním
 * hlavu nepřebije.
 */
function identityEntry(label: string, fits: (kind: ModelClass) => boolean): AssetEntry | undefined {
  const words = wordsOf(label);
  const said = new Set(words.flatMap((word) => [word, ...singulars(word)]));
  for (let index = words.length - 1; index >= 0; index -= 1) {
    const word = words[index] as string;
    const before = words[index - 1];
    const found = (before === undefined ? undefined : lookup(word, (form) => BY_IDENTITY.get(`${before}-${form}`))) ?? lookup(word, (form) => BY_IDENTITY.get(form));
    if (found === undefined) continue;
    const own = new Set([word, ...singulars(word)]);
    const score = (entry: AssetEntry): number => 4 * entry.identity.filter((tag) => said.has(tag)).length + (animated(entry) ? 2 : 0) + (own.has(bareId(entry.id)) ? 1 : 0);
    const pool = found.filter((entry) => fits(entry.class));
    return pool.length === 0 ? undefined : pool.reduce((top, entry) => (score(entry) > score(top) ? entry : top));
  }
  return undefined;
}

/** Jízda, kterou popisek jmenuje přívlastkem jejího dvojslova: „pirate“ → „pirate ship“. */
function rideOf(label: string, fits: (kind: ModelClass) => boolean): AssetEntry | undefined {
  for (const word of wordsOf(label).reverse()) {
    const forms = new Set([word, ...singulars(word)]);
    const found = MANIFEST.find((entry) => fits(entry.class) && entry.identity.some((tag) => tag.includes('-') && tag.split('-').some((part) => forms.has(part))));
    if (found !== undefined) return found;
  }
  return undefined;
}

/**
 * Model z popisku v pořadí věrnosti: přesná identita z manifestu nebo věc
 * z katalogu, blízká identita (`WORD_MODEL`), v závodě jízda z přívlastku,
 * zástupce třídy a nakonec výchozí model role. Jízdu v závodě vybírá tag
 * katalogu před manifestem jako před P32C: „race car“ je vůz `gen3d-race-car`,
 * ne nižší tělo jádra `race-car`, které na telefonu nedá 4 % výšky obrazu (`play-frame`).
 */
function choose(label: string, bounds: Bounds, options: { readonly withClass: boolean; readonly ride?: boolean; readonly loose?: boolean; readonly fallback?: string }): ModelChoice | undefined {
  const pick = (model: string | undefined, level: ChoiceLevel, fits: (kind: ModelClass) => boolean): ModelChoice | undefined =>
    model !== undefined && fits(classOfModel(model)) ? { model, level, entry: ENTRY_OF_MODEL.get(model) } : undefined;
  const named = identityEntry(label, bounds.identity);
  const tagged = pick(tagModel(label, false), 'identity', bounds.identity);
  const ride = options.ride === true ? rideOf(label, bounds.rest) : undefined;
  return (
    (options.ride === true && tagged !== undefined && rides(classOfModel(tagged.model)) ? tagged : undefined) ??
    (named === undefined ? undefined : { model: sceneId(named), level: 'identity', entry: named }) ??
    tagged ??
    pick(nearModel(label), 'near', bounds.rest) ??
    pick(nearestModel(label), 'near', bounds.rest) ??
    (ride === undefined ? undefined : { model: sceneId(ride), level: 'near', entry: ride }) ??
    (options.withClass ? (pick(categoryModel(label), 'class', bounds.rest) ?? pick(personModel(label), 'class', bounds.rest)) : undefined) ??
    // P39 T9: věc z věty bez modelu dostane nejbližší model i pod prahem čtení – vlkodlak za vlka, ne robot.
    (options.loose === true ? pick(nearestModel(label, true), 'near', bounds.rest) : undefined) ??
    (options.fallback === undefined ? undefined : { model: options.fallback, level: 'fallback', entry: ENTRY_OF_MODEL.get(options.fallback) })
  );
}

/**
 * Model pro hráče nebo nepřítele z popisku role (P32C T2). Přesná identita
 * vyhrává i nad žánrem (ponožka z věty je hrdina i v běžci); žánr omezuje jen
 * blízkou identitu a třídu na `heroClasses`. Závod bere jen to, co žánr za
 * hrdinu pustí, a bez žánru jen vozidlo, loď nebo letadlo – pirát nejede autem.
 */
export function heroChoice(label: string, genre: GenreId | undefined, control: string | undefined, role: 'player' | 'enemy' = 'player'): ModelChoice {
  if (role === 'enemy') return choose(label, ANY, { withClass: true, loose: true, fallback: 'robot' }) as ModelChoice;
  const classes: ReadonlySet<ModelClass> | undefined = genre === undefined ? undefined : new Set(GENRE_MODULES[genre].heroClasses);
  const allowed = (kind: ModelClass): boolean => classes === undefined || classes.has(kind);
  const steer = control === 'steer';
  const bounds: Bounds = steer ? { identity: classes === undefined ? rides : allowed, rest: classes === undefined ? rides : allowed } : { identity: () => true, rest: allowed };
  const fallback = steer ? 'race-car' : control === 'flap' ? 'bird' : 'explorer';
  return choose(label, bounds, { withClass: true, ride: steer, fallback }) as ModelChoice;
}

export interface RiggedCharacter {
  readonly id: string;
  readonly path: string;
  readonly tags: readonly string[];
  /** Stav hry → jméno klipu v GLB z manifestu; `procedural` = klip chybí, pohyb dopočítá `RiggedModel`. */
  readonly clips: Partial<Record<ClipState, string>>;
}

/** Klip střelby manifest nezná (stavy `CLIP_STATES` v `assets/manifest.ts`); bere se z `rigged.json`. */
const SHOOT_CLIP: ReadonlyMap<string, string | undefined> = new Map(rigged.characters.map((character) => [character.id, (character.clips as Partial<Record<ClipState, string>>).shoot]));

/** Postavy s klipy: každý záznam manifestu, který aspoň jeden klip má. */
const RIGGED: ReadonlyMap<string, RiggedCharacter> = new Map(
  MANIFEST.filter(animated).map((entry) => {
    const shoot = SHOOT_CLIP.get(entry.id);
    return [entry.id, { id: entry.id, path: entry.file, tags: entry.identity, clips: { ...entry.clips, ...(shoot === undefined ? {} : { shoot }) } }];
  }),
);

/**
 * Postava s klipy, kterou popisek jmenuje (P26B T6; od P32C T4 z manifestu
 * stejně jako `heroChoice`, i s postavami `rigged-p32.json`). Čte se od hlavy
 * fráze: slovo, které jmenuje jen model bez klipů („cat runner“ před T4),
 * dá `undefined`; když hlavu nese víc postav („warriors“), rozhodnou ostatní
 * slova („skeleton warriors“ → kostlivec).
 */
export function riggedModelOf(label: string): string | undefined {
  const named = identityEntry(label, ANY.identity);
  return named !== undefined && animated(named) ? sceneId(named) : undefined;
}

/** Riggovaná postava za id modelu, nebo `undefined` pro model katalogu. */
export function riggedCharacter(modelId: string): RiggedCharacter | undefined {
  return modelId.startsWith(RIGGED_PREFIX) ? RIGGED.get(modelId.slice(RIGGED_PREFIX.length)) : undefined;
}

/** Cesta ke GLB: katalog zná 86 modelů, jiné id (tělo jádra) leží ve složce her. */
export function modelPath(id: string): string {
  return PATHS.get(id) || `${GAME_BASE}${id}-lod1.glb`;
}
