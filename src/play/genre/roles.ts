/**
 * Smlouva rolí (P32B T3): kdo smí hrát hrdinu žánru a výchozí role, když je
 * věta neříká. Výchozí dává prostředí hry („haunted castle“ → duch), nikdy
 * vzorová věta fixtury – „giant Roomba“ ani „race car“ nová hra nezdědí.
 */

import { type LookId, lookFor } from '../arcade/look';

import type { GenreModules } from './classify';
import { type CastItem, FOE_DOES, type GenreId } from './contract';
import { GENRE_MODULES } from './index';
import { heroClass } from './hero-class';

export { heroClass };

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
  // P66 T2: jen slova, která `DEFAULT_LABELS` už má – nové výchozí slovo by změnilo, které popisky z věty dostanou
  // model (`_upgrade.ts`) a které se převlečou s místem (`compose.ts`), i u dnešních her („zombie“, „guard“).
  survivor: 'goblin',
  hole: 'car',
  steal: 'robot',
  sort: 'fruit',
  arrows: 'car',
  // P68 T1: ze stejného důvodu jen slova, která `DEFAULT_LABELS` už má.
  stunt: 'rock',
  minigolf: 'rock',
  railfps: 'robot',
  buildshift: 'robot',
  drawsave: 'bomb',
};

const placeRoles = (setting: string): PlaceRoles | null => {
  const look = lookFor(setting);
  return look === null ? null : PLACE_ROLES[look];
};

/**
 * Hrdina činnosti (P71D T3): hod, bouchání, chytání, slučování a obchod hraje člověk, k jehož práci věc patří –
 * jen postavy, které katalog má (`q-chef`, `q-chef-hat`, `gen3d-farmer`, `boy-a`). QA 5. 11.: basketbal a krtky
 * hrála liška z louky, koblihy, ovoce a pizzerii generický průzkumník.
 */
const WORK_HEROES: readonly (readonly [RegExp, string])[] = [
  [/\b(?:pizzas?|pizzerias?|burgers?|hamburgers?|restaurants?|diners?|kitchens?|sushi|tacos?|noodles?|soups?|pancakes?|sandwich(?:es)?|chefs?)\b/, 'chef'],
  [/\b(?:bak(?:e|es|ing|er|ers|ery|eries)|donuts?|doughnuts?|cookies?|cupcakes?|cakes?|muffins?|croissants?|breads?|pies?|pastr(?:y|ies))\b/, 'baker'],
  [/\b(?:moles?|gardens?|farms?|fruits?|apples?|pears?|oranges?|carrots?|vegetables?|veggies?|pumpkins?|tomato(?:es)?|berr(?:y|ies)|strawberr(?:y|ies)|watermelons?|melons?|corn)\b/, 'farmer'],
];

/** Hrdina žánru činnosti, když věta nemá ani věc práce: krtky bouchá farmář, jinak dítě. */
const WORK_GENRES: Partial<Record<GenreId, string>> = { throw: 'kid', whack: 'farmer', catch: 'kid', merge: 'kid', buildshift: 'kid' };

/** Výchozí postavy, které místo dává jen z nouze – u žánru činnosti je nahradí člověk činnosti. */
const FILLER_HEROES: ReadonlySet<string> = new Set(['fox', UNKNOWN_PLACE.hero]);

/**
 * Hrdina, když ho věta neříká: Plavba jede na plavidle z věty, žánr činnosti hraje člověk své práce (P71D T3), jinak
 * hraje to, co k místu patří. Liška je hrdina jen nouzově (P56A T6): věta, kterou přečetla čtečka (`read`) a hrdinu
 * nejmenuje, dostane na louce, v lese i na poušti průzkumníka – lišku jen ta, která ji jmenuje.
 */
export function defaultHero(setting: string, genre: GenreId, sentence: string, read = false): string {
  const place = placeRoles(setting) ?? UNKNOWN_PLACE;
  if (genre === 'voyage') return craftOf(sentence) ?? place.craft;
  const worker = WORK_GENRES[genre];
  if (worker !== undefined) {
    const text = sentence.toLowerCase();
    return WORK_HEROES.find(([words]) => words.test(text))?.[1] ?? (FILLER_HEROES.has(place.hero) ? worker : place.hero);
  }
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

/**
 * Hrdina míčové hry, kterou věta nikomu nedává (P42): člověk, ne zvíře z prostředí. P71D T3: dítě – popisek „player“
 * katalog kreslil jako rytíře.
 */
export const BALL_PLAYER = 'kid';

/** Každý popisek, který smlouva rolí dává místo věty – pin „žádná role mimo větu a výchozí“. */
export const DEFAULT_LABELS: ReadonlySet<string> = new Set([
  ...[...Object.values(PLACE_ROLES), UNKNOWN_PLACE].flatMap((roles) => [roles.hero, roles.craft, roles.enemy, roles.collectible, ...(roles.obstacle === undefined ? [] : [roles.obstacle])]),
  ...Object.values(GENRE_FOE),
  ...Object.values(TARGET_DEFAULT),
  'star',
  BALL_PLAYER,
  ...WORK_HEROES.map(([, hero]) => hero),
  ...Object.values(WORK_GENRES),
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
