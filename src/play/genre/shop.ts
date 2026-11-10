/**
 * Žánr Obchod se součtem (P83E T3): věci z věty s cenovkou na polici, pult s pokladnou a součet. Hráč klepne na věc,
 * hrdina ji donese na pult a součet přičte cenovku (ovládání `shop`, generátor `shop_counter`, pravidlo `shop_total`
 * v `arcade/pieces/shop.ts`, simulace v `shop-level.ts`).
 *
 * **Dva cíle:** „polož N“ (`items` věcí, všechny na pult, než doběhnou hodiny) a trefa do součtu (`target` > 0:
 * věc, se kterou by součet přetekl, se vrátí na polici a stojí život).
 *
 * **Parametry jsou celá čísla** (`spec.params` je `Record<string, int>`): `items` 2–8, `unit` 0 cena / 1 váha / 2 prosté
 * číslo, `target` 2–50 v jednotkách věty (dolary, kila, body). Žánr má jeden mód – jednotka je parametr, ne mód.
 *
 * Věty sem vede znak žánru v `classify.ts` (P83E T4). E2e hraje z ručního specu (`e2e/fixtures/p83e-shop-spec.json`).
 */

import { kitFor, modelHeight } from '../arcade/look';
import { SHOP, SHOP_NAME_MAX, SHOP_SPOTS, SHOP_UNITS, type ShopSpot, type ShopUnit } from '../arcade/pieces/shop-level';
import { counted, readCountedNouns, singular } from '../draft/lexicon';

import { type GenreModule, castFor, draftRoles, legacySpec, livesMechanic, titleCase } from './contract';

/** Výchozí věc obchodu (model je v knihovně). */
export const SHOP_DEFAULTS = { item: 'teddy bear' } as const;

/** Jednotka z parametru `unit` (0 cena, 1 váha, 2 prosté číslo). */
export const shopUnitOf = (unit: number | undefined): ShopUnit => SHOP_UNITS[unit ?? 0] ?? 'price';

/** Součet `amount` jednotek věty, jak ho ukáže text hry („$12“, „12 kg“, „12 points“). */
export function amountText(amount: number, unit: ShopUnit): string {
  if (unit === 'price') return `$${String(amount)}`;
  return unit === 'weight' ? `${String(amount)} kg` : counted(amount, 'point');
}

/** Součet v penězích, jak ho věta jmenuje: cena, hodnota, platba (přebije váhu i „scale“ – „treasure scale … total value“). */
const MONEY_SUM = /\$|\b(?:prices?|priced|cost(?:s|ing)?|values?|worth|pay|paid|bill|receipt|money|dollars?|euros?|cents?|coins?)\b/;
/** Váha věty: kila, vážení. */
const WEIGHT = /\b(?:weights?|weigh(?:s|ing|ed)?|heav(?:y|ier|iest)|kilos?|kilograms?|kgs?|pounds|lbs?|grams?)\b/;
/** Místo, kde se platí: pokladna, obchod – peníze, když věta součet nejmenuje. */
const MONEY_PLACE = /\b(?:till|register|checkout|cashier|shop|store|supermarket|grocery|market|bakery)\b/;
/** Cíl součtu: „exactly 12 dollars“, „adds up to 20“, „until it shows 30 kilos“, „must reach 15“. */
const TARGET = /\b(?:exactly|precisely|adds? up to|reach(?:es)?|shows?|reads?|total of) \$?(\d+)\b/;

const NUMBER = '(?:\\d+|two|three|four|five|six|seven|eight)';
/** Nepočitatelné věci, které se nosí jako jedna hromádka („food on a tray“): věc toho druhu, ne výchozí medvídek. */
const MASS = '(?:food|fruit|bread|candy|fish|meat|cheese|laundry|luggage|mail|treasure|gold|jewell?ery|cargo|(?:fire)?wood|produce|junk|seafood|rice|pasta|popcorn)';
/**
 * Věc po slovesu nesení: „put cakes on“, „pick up four toys“, „drops potion ingredients“, „puts food on“ – množné číslo
 * nebo nepočitatelná věc, až dvě slova; číslovka před ní je počet věcí.
 */
const CARRIED = new RegExp(
  String.raw`\b(?:put(?:s|ting)?|plac(?:e|es|ing)|carr(?:y|ies|ying)|bring(?:s|ing)?|tak(?:e|es|ing)|pick(?:s|ing)?(?: up)?|scan(?:s|ning)?|drop(?:s|ping)?|load(?:s|ing)?|stack(?:s|ing)?|fill(?:s|ing)? (?:up )?(?:the |a |my )?[a-z]+ with) (?:the |some |all |my |(${NUMBER}) )?((?:[a-z]+ )?(?:[a-z]+s|${MASS}))\b`,
);
/** Slova, která věc nejmenují – obchod pak dá svou výchozí, počet ale platí („four items“). */
const VAGUE = /\b(?:items?|things?|stuff|objects?|goods)$/;
const NUMBERS: Readonly<Record<string, number>> = { two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8 };

/** Věc a počet z věty (P83E T4/T7): bez čtení modelu sloveso „put“ předmět do obsazení nepředá. */
export function shopCarriedOf(sentence: string): { readonly item?: string; readonly count?: number } {
  const text = sentence.toLowerCase();
  const said = CARRIED.exec(text);
  const item = said?.[2] === undefined || VAGUE.test(said[2]) ? undefined : said[2];
  // Počet u slovesa, jinak číslovka před obecným slovem nebo před věcí kdekoli ve větě („four items … to the till“).
  const head = item?.split(' ').at(-1);
  const counted = readCountedNouns(text).find((entry) => VAGUE.test(entry.noun) || (head !== undefined && singular(entry.noun) === singular(head)));
  const word = said?.[1];
  const count = word !== undefined ? (NUMBERS[word] ?? Number(word)) : counted?.count;
  return { ...(item === undefined ? {} : { item }), ...(count === undefined ? {} : { count }) };
}

/** Věc z věty (P83E T4): `undefined` = obecné slovo nebo žádné, obchod dá výchozí. */
export const shopItemOf = (sentence: string): string | undefined => shopCarriedOf(sentence).item;

/**
 * Jednotka a cíl z věty (P83E T4/T7): součet v penězích, jak ho věta jmenuje (cena, hodnota), jinak váha (kila,
 * „weight“), jinak peníze podle místa (pokladna, obchod), jinak váha podle „scale“, jinak prosté číslo („the recipe adds
 * up to 20“, „total pages“). Cíl jen s číslicí po „exactly“ a spol.
 */
export function readShop(sentence: string): { readonly unit: number; readonly target?: number } {
  const text = sentence.toLowerCase();
  const unit = MONEY_SUM.test(text) ? 0 : WEIGHT.test(text) ? 1 : MONEY_PLACE.test(text) ? 0 : /\bscales?\b/.test(text) ? 1 : 2;
  const said = TARGET.exec(text)?.[1];
  if (said === undefined) return { unit };
  return { unit, target: Math.min(SHOP.target.max, Math.max(SHOP.target.min, Number(said))) };
}

/** Nádoba z věty (P83E T7): kam věci jdou – „into the bowl“, „on a tray“, „in the basket“, „on the scale“, „in my cart“. */
const SPOT_WORDS: readonly (readonly [ShopSpot, RegExp])[] = [
  ['bowl', /\b(?:bowls?|pots?|cauldrons?|dish(?:es)?|pans?)\b/],
  ['tray', /\b(?:trays?|plates?|platters?)\b/],
  ['basket', /\b(?:baskets?|bags?|boxe?s?|crates?|sacks?|hampers?)\b/],
  ['scale', /\b(?:scales?)\b/],
  ['cart', /\b(?:carts?|trolle(?:y|ys)|wagons?|wheelbarrows?|barrows?)\b/],
];
/** Předložka, za kterou věta říká, kam věc jde. */
const ONTO = /\b(?:on|onto|into|in|to|inside) (?:the |a |an |my |our |his |her |their |its )?((?:[a-z]+ ){0,2}[a-z]+)/g;

/** Kam věci padají: první místo za předložkou, které je nádobou; jinak pult. */
export function shopSpotOf(sentence: string): ShopSpot {
  for (const match of sentence.toLowerCase().matchAll(ONTO)) {
    const found = SPOT_WORDS.find(([, pattern]) => pattern.test(match[1]!));
    if (found !== undefined) return found[0];
  }
  return 'counter';
}

/** Slova, která místem nejsou: kam věc jde a co se počítá („the till adds up the total“ → prostředí ne „total“). */
const NOT_A_PLACE = /\b(?:totals?|sums?|prices?|costs?|values?|weights?|counters?|checkouts?|tills?|registers?|belts?|trays?|plates?|bowls?|pots?|baskets?|bags?|boxe?s?|scales?|carts?|trolle(?:y|ys)|shelf|shelves|games?|levels?|puzzles?|challenges?|rounds?|end|time|order|row|line)\b/;
/** Fráze, která místo nejmenuje (zájmeno, sloveso). */
const STOP_WORDS = /^(?:i|you|we|he|she|it|they|which|who|this|that|order|front|time|total)\b|\b(?:put|puts|pick|picks|carry|carries|bring|brings|take|takes|add|adds)\b/;
const isPlace = (phrase: string): boolean => !NOT_A_PLACE.test(phrase.split(' ').at(-1)!) && !STOP_WORDS.test(phrase);
/** Slova, kterými fráze místa končí: spojka, předložka, zájmeno („a bakery where I …“, „in a market and …“). */
const PHRASE_END: ReadonlySet<string> = new Set(['where', 'with', 'and', 'or', 'but', 'that', 'which', 'while', 'who', 'to', 'until', 'then', 'so', 'for', 'of', 'on', 'in', 'at', 'into', 'onto', 'as', 'i', 'you', 'we', 'he', 'she', 'they']);
/** Pult na konci místa („toy store checkout“, „bakery counter“) patří k místu, které jmenuje před sebou. */
const DESK = /^(?:counters?|checkouts?|tills?|registers?)$/;
/** Prostředí na začátku věty („a corner shop where …“, „at the toy store checkout, …“). */
const OPENING_PLACE = /^(?:(?:in|at|inside) (?:a |an |the |my |our )?([a-z- ]+?),|(?:a |an |the |my |our )?([a-z- ]+?) (?:where|in which)\b)/;
/** Prostředí za předložkou místa („… in a busy bakery“, „on a farm“) – jen se členem, ať to není „on them“. */
const PLACE_AFTER = /\b(?:in|at|inside|on) (?:a |an |the |my |our )([a-z- ]+)/g;

/** Místo z fráze: do první spojky, nejvýš tři slova, pult na konci odpadne; `undefined` = fráze místo nejmenuje. */
function placePhrase(phrase: string): string | undefined {
  const words = phrase.trim().split(' ');
  const end = words.findIndex((word) => PHRASE_END.has(word));
  const kept = (end < 0 ? words : words.slice(0, end)).slice(0, 3);
  if (kept.length > 1 && DESK.test(kept.at(-1)!)) kept.pop();
  const place = kept.join(' ');
  return place !== '' && isPlace(place) ? place : undefined;
}

/**
 * Prostředí z věty (P83E T7): místo, kterým věta začíná nebo které jmenuje za „in/at/on“, ne kam věc jde ani co se
 * sčítá. `undefined` = věta místo neříká.
 */
export function shopPlaceOf(sentence: string): string | undefined {
  const text = sentence.toLowerCase().replace(/[^a-z0-9$,' -]+/g, ' ').replace(/\s+/g, ' ').trim();
  const head = OPENING_PLACE.exec(text);
  const opening = head?.[1] ?? head?.[2];
  const candidates = [opening, ...[...text.matchAll(PLACE_AFTER)].map((match) => match[1])];
  for (const phrase of candidates) {
    const place = phrase === undefined ? undefined : placePhrase(phrase);
    if (place !== undefined) return place;
  }
  return undefined;
}

/** Prostředí, když věta místo neřekne a čtení slov našlo jen nádobu nebo součet („tray“, „total“). */
const SHOP_SETTING = 'shop';

/** Nejnižší kulisa místa (m), která po stranách police vypadá jako nábytek, ne jako zvětšená drobnost. */
const DECOR_MIN_M = 1;

/** Cíl hry slovy nádoby. */
const SPOT_PHRASE: Readonly<Record<ShopSpot, string>> = {
  counter: 'on the counter',
  bowl: 'in the bowl',
  tray: 'on the tray',
  basket: 'in the basket',
  scale: 'on the scale',
  cart: 'in the cart',
};

export const shopGenre: GenreModule<'shop'> = {
  id: 'shop',
  modes: ['default'],
  // Znak žánru (věci na pult a součet) je v `classify.ts`; narážky jen slova, která jinde nehrají („till“ je i „do“).
  cues: ['checkout', 'cashier', 'receipt'],
  heroClasses: ['humanoid', 'animal', 'robot', 'monster'],
  paramBounds: {
    items: { min: SHOP.items.min, max: SHOP.items.max },
    unit: { min: 0, max: SHOP_UNITS.length - 1 },
    target: { min: SHOP.target.min, max: SHOP.target.max },
    spot: { min: 0, max: SHOP_SPOTS.length - 1 },
  },
  availability: () => 'ready',
  compile: (spec) => {
    const items = spec.params?.items ?? SHOP.items.default;
    const unit = shopUnitOf(spec.params?.unit);
    const target = spec.params?.target;
    const spot = SHOP_SPOTS[spec.params?.spot ?? 0] ?? 'counter';
    const item = singular(castFor(spec, 'collect', 'scenery')?.label ?? SHOP_DEFAULTS.item);
    const aiming = target !== undefined;
    // Nepočitatelná věc se počítá kusy: „3 food items“, ne „3 foods“.
    const things = new RegExp(String.raw`(?:^| )${MASS}$`).test(item) ? `${String(items)} ${item} items` : counted(items, item);
    const goal = aiming ? `Make the total exactly ${amountText(target, unit)}` : `Put ${things} ${SPOT_PHRASE[spot]}`;
    const name = item.slice(0, SHOP_NAME_MAX).trim();
    // Kulisa místa věty po stranách police: nábytek z kitu prostředí (skříň lékárny, schránka pošty), ne drobnost.
    const decor = kitFor(spec.setting).find((id) => modelHeight(id) >= DECOR_MIN_M);
    return legacySpec(spec, {
      control: 'shop',
      controlParams: {
        generator: 'shop_counter',
        tuning: { items, unit, ...(aiming ? { target } : {}), ...(spot === 'counter' ? {} : { spot }), ...(name === '' ? {} : { name }), ...(decor === undefined ? {} : { decor }) },
      },
      archetype: 'collect_exit',
      title: `${titleCase(spec.hero)} Shop`,
      objective: {
        kind: 'collect',
        description: aiming
          ? `${goal}: tap items on the shelf, an item that would overshoot comes back and costs a life.`
          : `${goal} and watch the total add up before the clock runs out.`,
        count: items,
        role: 'item',
      },
      mechanics: aiming ? [livesMechanic()] : [],
      roles: [{ id: 'item', kind: 'collectible' as const, label: item }],
      tutorial: {
        goalLine: `${goal}!`.length <= 50 ? `${goal}!` : 'Fill the counter!',
        controlsHint: `Tap an item to carry it to the ${spot}. Arrows and Space work too.`,
      },
      mood: 'playful',
      targetDurationSec: 60,
    });
  },
  draftFill: (sentence, reading) => {
    const { hero, setting, cast } = draftRoles(sentence, reading);
    // Obchod nepřítele nemá: věci police jsou sbírané věci a kulisy věty. Nádoba (mísa, tác) věcí police není.
    // Obecné slovo („three items“) věc nejmenuje – police dostane výchozí věc, počet platí dál.
    const kept = (cast ?? []).filter((entry) => (entry.does === 'collect' || entry.does === 'scenery') && !SPOT_WORDS.some(([, pattern]) => pattern.test(entry.label)) && !VAGUE.test(entry.label));
    const { item, count } = shopCarriedOf(sentence);
    const roles = item === undefined || kept.some((entry) => entry.does === 'collect') ? kept : [{ label: item, does: 'collect' as const }, ...kept];
    const { unit, target } = readShop(sentence);
    const spot = SHOP_SPOTS.indexOf(shopSpotOf(sentence));
    // Počet věty jde přímo do parametru: „four items“ obecné slovo s věcí nespáruje (`countsOf` páruje podle jména).
    const params = { ...(unit === 0 ? {} : { unit }), ...(target === undefined ? {} : { target }), ...(count === undefined ? {} : { items: count }), ...(spot <= 0 ? {} : { spot }) };
    // Prostředí: místo věty; čtení slov bere první frázi za předložkou, a to bývá nádoba nebo součet („tray“, „total“).
    const place = shopPlaceOf(sentence) ?? (setting !== undefined && isPlace(setting) ? setting : SHOP_SETTING);
    return {
      genre: 'shop',
      mode: 'default',
      ...(Object.keys(params).length === 0 ? {} : { params }),
      ...(hero === undefined ? {} : { hero }),
      setting: place,
      ...(roles.length === 0 ? {} : { cast: roles }),
    };
  },
};
