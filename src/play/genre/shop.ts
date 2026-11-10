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

import { SHOP, SHOP_UNITS, type ShopUnit } from '../arcade/pieces/shop-level';
import { counted, singular } from '../draft/lexicon';

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

/** Váha věty: kila, vážení. */
const WEIGHT = /\b(?:weights?|weigh(?:s|ing|ed)?|kilos?|kilograms?|kgs?|pounds|lbs?|grams?)\b/;
/** Peníze věty: cena, platba, pokladna, obchod. */
const MONEY = /\$|\b(?:prices?|cost(?:s|ing)?|pay|paid|bill|receipt|till|register|checkout|cashier|money|dollars?|euros?|cents?|shop|store|supermarket|grocery|market|bakery)\b/;
/** Cíl součtu: „exactly 12 dollars“, „adds up to 20“, „until it shows 30 kilos“, „must reach 15“. */
const TARGET = /\b(?:exactly|precisely|adds? up to|reach(?:es)?|shows?|reads?|total of) \$?(\d+)\b/;

/** Věc po slovesu nesení: „put cakes on“, „pick up four toys“, „drops potion ingredients“ (množné číslo, až dvě slova). */
const CARRIED = /\b(?:put(?:s|ting)?|plac(?:e|es|ing)|carr(?:y|ies|ying)|bring(?:s|ing)?|tak(?:e|es|ing)|pick(?:s|ing)?(?: up)?|scan(?:s|ning)?|drop(?:s|ping)?|load(?:s|ing)?) (?:the |some |all |my |(?:\d+|two|three|four|five|six|seven|eight) )?((?:[a-z]+ )?[a-z]+s)\b/;
/** Slova, která věc nejmenují – obchod pak dá svou výchozí. */
const VAGUE = /\b(?:items?|things?|stuff|objects?|goods)$/;

/** Věc z věty (P83E T4): bez čtení modelu sloveso „put“ předmět do obsazení nepředá, police by měla výchozí medvídky. */
export function shopItemOf(sentence: string): string | undefined {
  const said = CARRIED.exec(sentence.toLowerCase())?.[1];
  return said === undefined || VAGUE.test(said) ? undefined : said;
}

/**
 * Jednotka a cíl z věty (P83E T4): váha (kila, „weight“), jinak peníze (cena, pokladna, obchod), jinak váha podle
 * „scale“, jinak prosté číslo („the recipe adds up to 20“, „total pages“). Cíl jen s číslicí po „exactly“ a spol.
 */
export function readShop(sentence: string): { readonly unit: number; readonly target?: number } {
  const text = sentence.toLowerCase();
  const unit = WEIGHT.test(text) ? 1 : MONEY.test(text) ? 0 : /\bscales?\b/.test(text) ? 1 : 2;
  const said = TARGET.exec(text)?.[1];
  if (said === undefined) return { unit };
  return { unit, target: Math.min(SHOP.target.max, Math.max(SHOP.target.min, Number(said))) };
}

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
  },
  availability: () => 'ready',
  compile: (spec) => {
    const items = spec.params?.items ?? SHOP.items.default;
    const unit = shopUnitOf(spec.params?.unit);
    const target = spec.params?.target;
    const item = singular(castFor(spec, 'collect', 'scenery')?.label ?? SHOP_DEFAULTS.item);
    const aiming = target !== undefined;
    const goal = aiming ? `Make the total exactly ${amountText(target, unit)}` : `Put ${counted(items, item)} on the counter`;
    return legacySpec(spec, {
      control: 'shop',
      controlParams: { generator: 'shop_counter', tuning: { items, unit, ...(aiming ? { target } : {}) } },
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
        controlsHint: 'Tap an item to carry it to the counter. Arrows and Space work too.',
      },
      mood: 'playful',
      targetDurationSec: 60,
    });
  },
  draftFill: (sentence, reading) => {
    const { hero, setting, cast } = draftRoles(sentence, reading);
    // Obchod nepřítele nemá: věci police jsou sbírané věci a kulisy věty.
    const kept = (cast ?? []).filter((entry) => entry.does === 'collect' || entry.does === 'scenery');
    const item = shopItemOf(sentence);
    const roles = item === undefined || kept.some((entry) => entry.does === 'collect') ? kept : [{ label: item, does: 'collect' as const }, ...kept];
    const { unit, target } = readShop(sentence);
    return {
      genre: 'shop',
      mode: 'default',
      ...(unit === 0 && target === undefined ? {} : { params: { unit, ...(target === undefined ? {} : { target }) } }),
      ...(hero === undefined ? {} : { hero }),
      ...(setting === undefined ? {} : { setting }),
      ...(roles.length === 0 ? {} : { cast: roles }),
    };
  },
};
