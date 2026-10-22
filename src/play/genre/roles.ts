/**
 * Smlouva rolí (P32B T3): kdo smí hrát hrdinu žánru a výchozí role, když je
 * věta neříká. Výchozí dává prostředí hry („haunted castle“ → duch), nikdy
 * vzorová věta fixtury – „giant Roomba“ ani „race car“ nová hra nezdědí.
 */

import { type LookId, lookFor } from '../arcade/look';

import type { GenreModules } from './classify';
import { type CastItem, FOE_DOES, type GenreId, type ModelClass } from './contract';
import { GENRE_MODULES } from './index';

/**
 * Slova tříd modelů – zrcadlo `CLASS_WORDS` z `assets/manifest.ts`, který je
 * neexportuje a není soubor P32B. Liší se jen doplněným koštětem.
 */
const CLASS_WORDS: Readonly<Record<ModelClass, readonly string[]>> = {
  bird: ['bird', 'penguin', 'eagle', 'parrot', 'duck', 'owl', 'chicken', 'hen', 'crow', 'pigeon', 'seagull', 'hawk', 'flamingo', 'swan', 'goose'],
  animal: ['animal', 'cat', 'kitten', 'dog', 'puppy', 'fox', 'bear', 'rabbit', 'bunny', 'pig', 'cow', 'horse', 'mouse', 'monkey', 'lion', 'tiger', 'wolf', 'deer', 'frog', 'fish', 'turtle', 'snake', 'hamster'],
  robot: ['robot', 'android', 'droid', 'mech', 'cyborg', 'bot'],
  vehicle: ['car', 'truck', 'bus', 'bike', 'bicycle', 'motorcycle', 'kart', 'tank', 'train', 'tractor', 'taxi', 'van'],
  boat: ['boat', 'ship', 'sailboat', 'yacht', 'submarine', 'canoe', 'raft', 'ferry'],
  aircraft: ['plane', 'airplane', 'jet', 'helicopter', 'rocket', 'spaceship', 'ufo', 'drone', 'balloon', 'broom', 'broomstick'],
  humanoid: ['man', 'woman', 'boy', 'girl', 'kid', 'child', 'person', 'hero', 'chef', 'firefighter', 'pirate', 'knight', 'wizard', 'princess', 'prince', 'ninja', 'astronaut'],
  monster: ['monster', 'ghost', 'zombie', 'dragon', 'alien', 'skeleton', 'goblin', 'troll', 'ogre', 'vampire'],
  prop: [],
};

const CLASS_OF_WORD: ReadonlyMap<string, ModelClass> = new Map(Object.entries(CLASS_WORDS).flatMap(([kind, words]) => words.map((word) => [word, kind as ModelClass] as const)));

const forms = (word: string): string[] => [word, word.replace(/ies$/, 'y'), word.replace(/es$/, ''), word.replace(/s$/, '')];

/** Třída hrdiny podle posledního slova, které nějakou jmenuje („pirate ship“ → loď); `null` = slova třídu neznají. */
export function heroClass(label: string): ModelClass | null {
  const words = label.toLowerCase().match(/[a-z][a-z-]*/g) ?? [];
  for (const word of words.reverse()) {
    const kind = forms(word)
      .map((form) => CLASS_OF_WORD.get(form))
      .find((found) => found !== undefined);
    if (kind !== undefined) return kind;
  }
  return null;
}

/** Smí hrdina hrát tenhle žánr? Popisek bez známé třídy nic nedokazuje – scéna nakreslí náhradu. */
export function heroFits(genre: GenreId, heroLabel: string, modules: GenreModules = GENRE_MODULES): boolean {
  const kind = heroClass(heroLabel);
  return kind === null || modules[genre].heroClasses.includes(kind);
}

const CRAFT = '(?:sail)?boats?|ships?|yachts?|submarines?|canoes?|rafts?|ferry|ferries|broom(?:stick)?s?|(?:air)?planes?|jets?|helicopters?|rockets?|spaceships?|ufos?|balloons?';
/** „a pirate ship“, „a paper plane“: plavidlo s jedním přívlastkem; bez členu jen samotné slovo. */
const CRAFT_PHRASE = new RegExp(`\\b(?:a|an|the|his|her|my|their|its|your)\\s+((?:[a-z]+\\s+)?(?:${CRAFT}))\\b`);
const CRAFT_WORD = new RegExp(`\\b(${CRAFT})\\b`);

/** Loď, koště, letadlo nebo raketa, které věta jmenuje; Plavba s nimi nikdy nedá auto. */
export function craftOf(sentence: string): string | null {
  const text = sentence.toLowerCase();
  const phrase = CRAFT_PHRASE.exec(text)?.[1] ?? CRAFT_WORD.exec(text)?.[1];
  return phrase === undefined ? null : phrase.replace(/(?:ies)$/, 'y').replace(/(?<!s)s$/, '');
}

interface PlaceRoles {
  readonly hero: string;
  readonly craft: string;
  readonly enemy: string;
  readonly collectible: string;
  /** Překážka na trati a zeď okruhu (P46D T6), model z katalogu; bez ní výchozí žánru. */
  readonly obstacle?: string;
}

/** Role podle sady prostředí (`arcade/look`); hrdinové jsou zvíře, pták, člověk nebo robot, ať sedí každému žánru kromě Plavby. */
const PLACE_ROLES: Readonly<Record<LookId, PlaceRoles>> = {
  meadow: { hero: 'fox', craft: 'car', enemy: 'bee', collectible: 'flower' },
  city: { hero: 'kid', craft: 'car', enemy: 'car', collectible: 'coin', obstacle: 'traffic barrier' },
  mall: { hero: 'kid', craft: 'car', enemy: 'shopping cart', collectible: 'shopping bag' },
  supermarket: { hero: 'mouse', craft: 'car', enemy: 'cat', collectible: 'cheese', obstacle: 'shopping cart' },
  living_room: { hero: 'kid', craft: 'car', enemy: 'spider', collectible: 'toy block' },
  factory: { hero: 'robot', craft: 'car', enemy: 'saw blade', collectible: 'gear' },
  forest: { hero: 'fox', craft: 'car', enemy: 'wolf', collectible: 'acorn', obstacle: 'log' },
  jungle: { hero: 'monkey', craft: 'car', enemy: 'snake', collectible: 'banana' },
  desert: { hero: 'fox', craft: 'car', enemy: 'scorpion', collectible: 'gem', obstacle: 'cactus' },
  beach: { hero: 'turtle', craft: 'boat', enemy: 'crab', collectible: 'shell' },
  ocean: { hero: 'pirate', craft: 'boat', enemy: 'shark', collectible: 'pearl' },
  underwater: { hero: 'fish', craft: 'submarine', enemy: 'shark', collectible: 'pearl' },
  snow: { hero: 'penguin', craft: 'sled', enemy: 'polar bear', collectible: 'snowflake' },
  volcano: { hero: 'robot', craft: 'car', enemy: 'fireball', collectible: 'gem' },
  cave: { hero: 'kid', craft: 'car', enemy: 'bat', collectible: 'crystal' },
  space: { hero: 'astronaut', craft: 'rocket', enemy: 'asteroid', collectible: 'star' },
  castle: { hero: 'knight', craft: 'broom', enemy: 'ghost', collectible: 'gem' },
  graveyard: { hero: 'kid', craft: 'broom', enemy: 'ghost', collectible: 'candle' },
};

/**
 * Místo, které sady neznají („village“): nástraha podle žánru, mince a průzkumník – riggovaný (`q-cowboy-hair`) a sedí
 * každému žánru. Dřív liška, a ta pak hrála skoro každou větu bez hrdiny (P56A T6).
 */
const UNKNOWN_PLACE: PlaceRoles = { hero: 'explorer', craft: 'car', enemy: 'rock', collectible: 'coin' };
const GENRE_FOE: Readonly<Record<GenreId, string>> = {
  runner: 'rock',
  platformer: 'spike',
  arena: 'wolf',
  voyage: 'rock',
  quest: 'shadow',
  shooter: 'robot',
  throw: 'can',
  timing: 'wind',
  rhythm: 'wrong note',
  duel: 'rival',
  flap: 'pipe',
  catch: 'bomb',
  whack: 'mole',
  defense: 'goblin',
  slice: 'bomb',
  hop: 'car',
  crowd: 'wall',
  merge: 'fruit',
  push: 'rival',
};

const placeRoles = (setting: string): PlaceRoles | null => {
  const look = lookFor(setting);
  return look === null ? null : PLACE_ROLES[look];
};

/**
 * Hrdina, když ho věta neříká: Plavba jede na plavidle z věty, jinak na tom, co k místu patří. Liška je hrdina jen
 * nouzově (P56A T6): věta, kterou přečetla čtečka (`read`) a hrdinu nejmenuje, dostane na louce, v lese i na poušti
 * průzkumníka – lišku jen ta, která ji jmenuje.
 */
export function defaultHero(setting: string, genre: GenreId, sentence: string, read = false): string {
  const place = placeRoles(setting) ?? UNKNOWN_PLACE;
  if (genre === 'voyage') return craftOf(sentence) ?? place.craft;
  return read && place.hero === 'fox' ? UNKNOWN_PLACE.hero : place.hero;
}

/**
 * Nepřítel, když ho věta neříká (P39: položka obsazení). Jméno dává prostředí –
 * hrad → duch, moře → žralok, sníh → lední medvěd, les → vlk, město → auto,
 * vesmír → asteroid – a co dělá, žánr (`FOE_DOES`): střílečka vlka sestřelí,
 * načasování ho má jen jako kulisu. Čemu se žánr jen vyhýbá, je překážka na
 * trati, a tu dává prostředí, má-li vlastní (P46D T6): v lese kmen, ne vlk.
 * `does` je role, kterou věc ve hře dostane: terč střelby, pronásledovatel a
 * soupeř zblízka zůstávají nepřítelem, i když se mu žánr jinak jen vyhýbá.
 */
export function defaultFoe(setting: string, genre: GenreId, does: CastItem['does'] = FOE_DOES[genre]): CastItem {
  const place = placeRoles(setting);
  const avoided = FOE_DOES[genre] === 'avoid' && does === 'avoid' ? place?.obstacle : undefined;
  return { label: avoided ?? place?.enemy ?? GENRE_FOE[genre], does: FOE_DOES[genre] };
}

/** Nepřítel prostředí bez ohledu na žánr (les → vlk): výchozí věc místa i tam, kde žánr dává překážku. */
export function placeFoe(setting: string): string | undefined {
  return placeRoles(setting)?.enemy;
}

/**
 * Překážka trati, když ji obsazení nemá (P46D T6): v supermarketu vozík, v lese kmen, ve městě
 * zábrana, v poušti kaktus. Sada je `palette`, jinak se hádá z místa („Hamster escapes a supermarket
 * Roomba“ má místo `roomba` a sadu supermarket); místo bez vlastní překážky nedá nic a žánr
 * nechá svou (kámen běžce, bodák skákačky, pneumatiky okruhu).
 */
export function defaultObstacle(spec: { readonly setting: string; readonly palette?: LookId }): string | undefined {
  const look = spec.palette ?? lookFor(spec.setting);
  return look === null ? undefined : PLACE_ROLES[look].obstacle;
}

/** Sbíraná věc, když ji věta neříká. */
export function defaultCollectible(setting: string): string {
  return (placeRoles(setting) ?? UNKNOWN_PLACE).collectible;
}

/** Předmět úkolu, když ho věta za slovesem nejmenuje („light“ → svíčka). */
const TARGET_DEFAULT: Readonly<Record<string, string>> = { light: 'candle', extinguish: 'fire', free: 'cage', press: 'switch', deliver: 'parcel', hit: 'target', cook: 'pancake', repair: 'machine', make: 'block' };

export function defaultTarget(verb: string): string {
  return TARGET_DEFAULT[verb] ?? 'star';
}

/** Hrdina míčové hry, kterou věta nikomu nedává (P42): hráč, ne zvíře z prostředí. */
export const BALL_PLAYER = 'player';

/** Každý popisek, který smlouva rolí dává místo věty – pin „žádná role mimo větu a výchozí“. */
export const DEFAULT_LABELS: ReadonlySet<string> = new Set([
  ...[...Object.values(PLACE_ROLES), UNKNOWN_PLACE].flatMap((roles) => [roles.hero, roles.craft, roles.enemy, roles.collectible, ...(roles.obstacle === undefined ? [] : [roles.obstacle])]),
  ...Object.values(GENRE_FOE),
  ...Object.values(TARGET_DEFAULT),
  'star',
  BALL_PLAYER,
]);

/** Equipment implied by a named sport, not a global permission to invent cast. */
export function semanticRoleDefaults(sentence: string): readonly string[] {
  const text = sentence.toLowerCase();
  // This runtime has no table-tennis net/rally contract. Football equipment must
  // never become a permitted substitute merely because both games use a ball.
  if (/\b(?:table tennis|tennis|ping[ -]?pong)\b/.test(text)) return ['ball'];
  if (/\b(?:basketball|free throws?)\b/.test(text)) return ['basketball', 'hoop'];
  if (/\b(?:mini[ -]?)?golf\b/.test(text)) return ['golf ball', 'hole'];
  if (/\b(?:soccer|football|penalty kicks?)\b/.test(text)) return ['football', 'goal'];
  return [];
}
