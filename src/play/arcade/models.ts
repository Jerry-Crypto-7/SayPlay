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
import type { AssetEntry } from '../assets/manifest';
import { controlOf, readsLabel } from '../capabilities';
import type { GenreId, ModelClass } from '../genre/contract';
import { GENRE_MODULES } from '../genre/index';
import type { GameSpecV1 } from '../spec';
import type { ClipState } from './motion';
import { OBSTACLE_KINDS } from './pieces/runner';

const GAME_BASE = '/assets/worldstream/game/';

/** Id modelu → cesta k jeho LOD1 v katalogu. */
const PATHS: ReadonlyMap<string, string> = new Map(
  catalog.assets.map((asset) => [asset.assetId, asset.path]),
);

/** Tag → model. Tag, který nese víc modelů (`robot`), patří tomu, který se tak jmenuje. */
const BY_TAG: ReadonlyMap<string, string> = (() => {
  const index = new Map<string, string>();
  for (const asset of catalog.assets) {
    for (const tag of [asset.assetId, ...asset.tags]) {
      if (!index.has(tag) || tag === asset.assetId) index.set(tag, asset.assetId);
    }
  }
  return index;
})();

/** Slova, která tag katalogu nese jinak, než je myslí věta: pták je postava (primitiv `bird`), ne hnízdo. */
const WORD_SENSE: Readonly<Record<string, string>> = { bird: 'bird', birds: 'bird' };

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
  rabbit: 'hamster',
  bunny: 'hamster',
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

/** Model katalogu (nebo primitiv `bird`), který popisek jmenuje; kategorie jen u postav. */
export function modelOf(label: string, character: boolean): string | undefined {
  return tagModel(label, true) ?? (character ? categoryModel(label) : undefined);
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

/** Nepřátelé střelnice: model z popisku role `enemy` (`heroChoice`), jinak robot. */
export function enemyModel(spec: GameSpecV1): string {
  return heroChoice(spec.roles.find((role) => role.id === 'enemy')?.label ?? '', undefined, spec.control, 'enemy').model;
}

/** Pronásledovatel doplňku `+chaser` (P26D): model z popisku role druhu `chaser` („bear“), jinak jako nepřítel. */
export function chaserModel(spec: GameSpecV1): string {
  return choose(spec.roles.find((role) => role.kind === 'chaser')?.label ?? '', ANY, { withClass: true })?.model ?? enemyModel(spec);
}

/**
 * Role arkády, jejichž těla smí nést model z popisku: sbíraná mince, překážka běžce, terč hodu, soupeř souboje
 * a závodu (P27A T4); od P30B T4 i mantinel závodu, nota rytmu a díl věže načasování.
 */
export const PROP_ROLES = ['coin', 'obstacle', 'target', 'rival', 'barrier', 'note', 'block'] as const;
export type PropRole = (typeof PROP_ROLES)[number];

/** Co jádro pro roli kreslí samo; popisek, který jmenuje právě tohle („obstacles“), nic nemění. */
const OWN_KINDS: Readonly<Record<PropRole, readonly string[]>> = {
  coin: ['coin'],
  obstacle: OBSTACLE_KINDS,
  target: ['target', 'wood-block'],
  // „rival car“ je auto soupeře; hráčovo závodní auto by soupeře od hráče nerozlišilo.
  rival: ['rival-car', 'race-car'],
  // „barriers“ je v katalogu překážka běžce; obecný popisek mantinelu nechá pneumatiky.
  barrier: ['tire-barrier', 'hurdle'],
  // Nota a díl věže jsou v jádře barevné kvádry; „tiles“ a „blocks“ jmenují právě je.
  note: ['hazard-tile'],
  block: ['wood-block'],
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
    const role = spec.roles.find((candidate) => candidate.id === id);
    if (role === undefined || !readsLabel(control, role)) continue;
    const found = id === 'rival' ? rivalModel(role.label, control) : modelOf(role.label, false);
    if (found !== undefined && found !== 'bird') out[id] = found;
  }
  return out;
}

/** Modely rekvizit, které scéna kreslí místo těla jádra – jen přímá shoda s katalogem, bez kategorií. */
export function propModels(spec: GameSpecV1): Partial<Record<PropRole, string>> {
  const named = namedProps(spec);
  return Object.fromEntries(PROP_ROLES.flatMap((id) => (named[id] === undefined || OWN_KINDS[id].includes(named[id]) ? [] : [[id, named[id]]])));
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

/** Manifest hrdinů (P32C): riggované postavy a tučňák napřed, pak modely katalogu. */
const MANIFEST: readonly AssetEntry[] = [...BASE_ENTRIES, ...CATALOG_ENTRIES];

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
function choose(label: string, bounds: Bounds, options: { readonly withClass: boolean; readonly ride?: boolean; readonly fallback?: string }): ModelChoice | undefined {
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
    (ride === undefined ? undefined : { model: sceneId(ride), level: 'near', entry: ride }) ??
    (options.withClass ? pick(categoryModel(label), 'class', bounds.rest) : undefined) ??
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
  if (role === 'enemy') return choose(label, ANY, { withClass: true, fallback: 'robot' }) as ModelChoice;
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

/** Tag → riggované postavy, které ho nesou (v pořadí manifestu). */
const RIGGED_BY_TAG: ReadonlyMap<string, readonly (typeof rigged.characters)[number][]> = (() => {
  const index = new Map<string, (typeof rigged.characters)[number][]>();
  for (const character of rigged.characters) for (const tag of character.tags) index.set(tag, [...(index.get(tag) ?? []), character]);
  return index;
})();

/**
 * Riggovaná postava, kterou popisek jmenuje (P26B T6). Čte se od hlavy fráze
 * jako `modelOf`: první slovo odzadu, které zná postava, vyhrává; slovo, které
 * zná jen katalog („cat runner“ → kočka), výběr ukončí – postava s klipy
 * nesmí přebít zvíře nebo věc z věty. Když hlavu nese víc postav („warriors“),
 * rozhodnou ostatní slova („skeleton warriors“ → kostlivec).
 */
export function riggedModelOf(label: string): string | undefined {
  const words = label.toLowerCase().match(/[a-z][a-z-]*/g) ?? [];
  const forms = new Set(words.flatMap((word) => [word, ...singulars(word)]));
  for (const word of [...words].reverse()) {
    const candidates = lookup(word, (form) => RIGGED_BY_TAG.get(form));
    if (candidates !== undefined) {
      const score = (character: (typeof candidates)[number]): number => character.tags.filter((tag) => forms.has(tag)).length;
      const best = candidates.reduce((top, character) => (score(character) > score(top) ? character : top));
      return `${RIGGED_PREFIX}${best.id}`;
    }
    if (lookup(word, (form) => WORD_MODEL[form] ?? BY_TAG.get(form)) !== undefined) return undefined;
  }
  return undefined;
}

/** Riggovaná postava za id modelu, nebo `undefined` pro model katalogu. */
export function riggedCharacter(modelId: string): RiggedCharacter | undefined {
  return modelId.startsWith(RIGGED_PREFIX) ? RIGGED.get(modelId.slice(RIGGED_PREFIX.length)) : undefined;
}

/** Cesta ke GLB: katalog zná 86 modelů, jiné id (tělo jádra) leží ve složce her. */
export function modelPath(id: string): string {
  return PATHS.get(id) || `${GAME_BASE}${id}-lod1.glb`;
}
