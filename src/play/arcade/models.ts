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
 * Čisté funkce mimo React (P26 T5): tabulka schopností `src/play/capabilities.ts`
 * tvrdí, které popisky vykreslení čte, a test to ověřuje právě tady.
 */

import catalog from '@/assets/catalog-index.json';

import rigged from '@/assets/rigged.json';

import { controlOf, readsLabel } from '../capabilities';
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

/**
 * Zástupce pro věc, kterou katalog nemá (P28D T3): scéna nakreslí nejbližší
 * kus místo výchozího robota nebo překážky, ale model popisek nejmenuje –
 * řetěz věrnosti ho dál počítá jako `no-model`. Jen věci, ne postavy.
 */
const STAND_IN: Readonly<Record<string, string>> = {
  balloon: 'ball',
  sprinkler: 'cc0-fire-hydrant',
};

function standInOf(label: string): string | undefined {
  const head = label.toLowerCase().match(/[a-z][a-z-]*/g)?.at(-1);
  return head === undefined ? undefined : lookup(head, (form) => STAND_IN[form]);
}

/** Nejbližší kategorie postavy, kterou katalog nemá. */
const CATEGORY: ReadonlyArray<readonly [model: string, words: readonly string[]]> = [
  ['fox', ['animal', 'bear', 'lion', 'tiger', 'pig', 'cow', 'horse', 'sheep', 'goat', 'chicken', 'monkey', 'panda', 'koala', 'deer', 'hedgehog', 'turtle', 'frog', 'snake', 'lizard', 'owl', 'bat', 'sloth', 'llama', 'giraffe', 'elephant', 'zebra', 'kangaroo', 'otter', 'beaver', 'badger']],
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

/** Model katalogu (nebo primitiv `bird`), který popisek jmenuje; kategorie jen u postav. */
export function modelOf(label: string, character: boolean): string | undefined {
  const words = label.toLowerCase().match(/[a-z][a-z-]*/g) ?? [];
  for (const word of [...words].reverse()) {
    const found = lookup(word, (form) => WORD_SENSE[form] ?? BY_TAG.get(form) ?? WORD_MODEL[form]);
    if (found !== undefined) return found;
  }
  if (!character) return undefined;
  for (const word of [...words].reverse()) {
    const found = lookup(word, (form) => CATEGORY_OF.get(form));
    if (found !== undefined) return found;
  }
  return undefined;
}

/** Vozidla, která závod umí nést; jiný popisek řídí auto. */
const VEHICLES: ReadonlySet<string> = new Set(['race-car', 'rival-car', 'plane', 'rocket', 'rowing-boat', 'shopping-cart', 'drone']);

/** Hrdina z popisku hráče: riggovaná postava, pak katalog; bez shody ptáček u poletování, auto v závodě, jinak `explorer`. */
export function heroModel(spec: GameSpecV1): string {
  const label = spec.roles.find((role) => role.kind === 'player')?.label ?? '';
  const found = modelOf(label, spec.control !== 'steer');
  if (spec.control === 'steer') return found !== undefined && VEHICLES.has(found) ? found : 'race-car';
  return riggedModelOf(label) ?? found ?? (spec.control === 'flap' ? 'bird' : 'explorer');
}

/** Nepřátelé střelnice: riggovaná postava nebo model z popisku role `enemy`, pak zástupce věci, jinak robot. */
export function enemyModel(spec: GameSpecV1): string {
  const label = spec.roles.find((role) => role.id === 'enemy')?.label ?? '';
  return riggedModelOf(label) ?? modelOf(label, true) ?? standInOf(label) ?? 'robot';
}

/** Pronásledovatel doplňku `+chaser` (P26D): model z popisku role druhu `chaser` („bear“), jinak jako nepřítel. */
export function chaserModel(spec: GameSpecV1): string {
  const label = spec.roles.find((role) => role.kind === 'chaser')?.label ?? '';
  return riggedModelOf(label) ?? modelOf(label, true) ?? enemyModel(spec);
}

/** Role arkády, jejichž těla smí nést model z popisku: sbíraná mince, překážka běžce, terč hodu, soupeř souboje a závodu (P27A T4). */
export const PROP_ROLES = ['coin', 'obstacle', 'target', 'rival'] as const;
export type PropRole = (typeof PROP_ROLES)[number];

/** Co jádro pro roli kreslí samo; popisek, který jmenuje právě tohle („obstacles“), nic nemění. */
const OWN_KINDS: Readonly<Record<PropRole, readonly string[]>> = {
  coin: ['coin'],
  obstacle: OBSTACLE_KINDS,
  target: ['target', 'wood-block'],
  // „rival car“ je auto soupeře; hráčovo závodní auto by soupeře od hráče nerozlišilo.
  rival: ['rival-car', 'race-car'],
};

/** Model soupeře: riggovaná postava nebo přímá shoda s katalogem; v závodě jen vozidlo. */
function rivalModel(label: string, control: string): string | undefined {
  if (control === 'steer') {
    const found = modelOf(label, false);
    return found !== undefined && VEHICLES.has(found) ? found : undefined;
  }
  return riggedModelOf(label) ?? modelOf(label, false);
}

/**
 * Modely rekvizit z popisků rolí – jen přímá shoda s katalogem, bez kategorií.
 * `standIns` (scéna ano, řetěz věrnosti ne) přidá zástupce věci bez modelu.
 */
export function propModels(spec: GameSpecV1, standIns = true): Partial<Record<PropRole, string>> {
  const out: Partial<Record<PropRole, string>> = {};
  const control = controlOf(spec);
  for (const id of PROP_ROLES) {
    const role = spec.roles.find((candidate) => candidate.id === id);
    if (role === undefined || !readsLabel(control, role)) continue;
    const exact = id === 'rival' ? rivalModel(role.label, control) : modelOf(role.label, false);
    const found = exact ?? (standIns && id !== 'rival' ? standInOf(role.label) : undefined);
    if (found !== undefined && found !== 'bird' && !OWN_KINDS[id].includes(found)) out[id] = found;
  }
  return out;
}

/** Id modelu riggované postavy s klipy (`src/assets/rigged.json`, P26B) nese tuhle předponu, ať se nesrazí s katalogem. */
export const RIGGED_PREFIX = 'rigged:';

export interface RiggedCharacter {
  readonly id: string;
  readonly path: string;
  readonly tags: readonly string[];
  /** Stav hry → jméno klipu v GLB; `idle` a `run` jsou vždy. */
  readonly clips: Partial<Record<ClipState, string>>;
}

const RIGGED: ReadonlyMap<string, RiggedCharacter> = new Map(rigged.characters.map((character) => [character.id, character]));

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
