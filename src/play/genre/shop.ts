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

export const shopGenre: GenreModule<'shop'> = {
  id: 'shop',
  modes: ['default'],
  // P83E T4 doplní narážky a znak žánru; do té doby sem vede jen ruční spec.
  cues: [],
  heroClasses: ['humanoid', 'animal', 'robot', 'monster'],
  paramBounds: {
    items: { min: SHOP.items.min, max: SHOP.items.max },
    unit: { min: 0, max: SHOP_UNITS.length - 1 },
    target: { min: SHOP.target.min, max: SHOP.target.max },
  },
  // T3: kostra – hraje jen ruční spec (e2e), klasifikátor ani režisér ji nevidí; T4 ji zapne (`ready`, buňka `shop.default`
  // z `STAGED_PRESETS` do `PRESETS`, vzorek kontraktu, řádek oblékání a obtížnosti P41).
  availability: () => 'staged',
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
    const roles = (cast ?? []).filter((entry) => entry.does === 'collect' || entry.does === 'scenery');
    return {
      genre: 'shop',
      mode: 'default',
      ...(hero === undefined ? {} : { hero }),
      ...(setting === undefined ? {} : { setting }),
      ...(roles.length === 0 ? {} : { cast: roles }),
    };
  },
};
