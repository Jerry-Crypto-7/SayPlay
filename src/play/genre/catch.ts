/**
 * Žánr Chytání (P54C T5): věci padají v pěti pruzích a hrdina je chytá (ovládání `lanes`,
 * generátor `catch_fall` v `arcade/pieces/catch-fall.ts`). Co padá, je věc obsazení, kterou
 * věta sbírá (`collect`); čemu se hrdina vyhýbá (`avoid` a ostatní nepřátelé), padá jako bomba.
 *
 * Hloubka: cíl `items` věcí (`COUNT_PARAMS.catch.default.collectible`), tři třetiny rychlejšího
 * a hustšího pádu, 3 životy – bomba v koši a každé propadlé ovoce nad čtyři volná ubere život.
 * Robot vyhraje za 30–60 s, nečinný hráč prohraje dřív, než něco chytí.
 *
 * Věty sem vede klasifikátor (T13, sloveso `catch` v `classify.ts`: chytá se, co padá), hraje ho buňka
 * `catch.default`; režisér ho nabídne od T14.
 */

import { CATCH } from '../arcade/pieces/catch-fall';
import { nounPhrase, plural, singular } from '../draft/lexicon';

import { type CastItem, type GenreModule, castFor, draftRoles, legacySpec, livesMechanic, titleCase } from './contract';

/** Výchozí věci, když je věta nejmenuje: jablka a bomby (oba modely knihovna má). */
export const CATCH_DEFAULTS = { fruit: 'apple', bomb: 'bomb' } as const;

/** Role obsazení, kterou chytání hraje jako padající bombu: všechno, co hrdinovi škodí. */
const BOMB_DOES = ['avoid', 'chase_me', 'shoot_at', 'fight', 'throw_at'] as const;

/** Předmět slovesa chytání („catches falling apples“, „catch the eggs“). */
const CATCH_OBJECT = /\bcatch(?:es|ing)?\s+(?:all\s+|the\s+|some\s+|falling\s+)*([a-z][a-z -]*)/;
/** „catch him“ je honička, ne věc do koše. */
const PRONOUN = /^(?:it|him|her|them|me|you|us|up)\b/;

/** První text, který se vejde do meze schématu (dlouhé popisky z věty). */
const fit = (max: number, ...lines: readonly string[]): string => lines.find((line) => line.length <= max) ?? (lines.at(-1) as string);

export const catchGenre: GenreModule<'catch'> = {
  id: 'catch',
  modes: ['default'],
  // Narážky žádné: věty vede sloveso `catch` klasifikátoru (T13) – narážka by přidala bod i honičce („catch the thief“).
  cues: [],
  heroClasses: ['animal', 'humanoid', 'robot', 'monster', 'vehicle'],
  paramBounds: {
    items: { min: CATCH.items.min, max: CATCH.items.max },
  },
  availability: () => 'ready',
  compile: (spec) => {
    const items = spec.params?.items ?? CATCH.items.default;
    const fruit = castFor(spec, 'collect', 'reach')?.label ?? CATCH_DEFAULTS.fruit;
    const bomb = castFor(spec, ...BOMB_DOES)?.label ?? CATCH_DEFAULTS.bomb;
    const fruits = plural(singular(fruit), items);
    const bombs = plural(singular(bomb), 2);
    return legacySpec(spec, {
      control: 'lanes',
      controlParams: { generator: 'catch_fall', tuning: { items } },
      archetype: 'collect_exit',
      title: `${titleCase(spec.hero)} Catch`,
      objective: { kind: 'collect', description: fit(120, `Catch ${String(items)} falling ${fruits} and dodge the ${bombs}.`, `Catch ${String(items)} falling ${fruits}.`, `Catch ${String(items)} falling things.`), count: items, role: 'coin' },
      mechanics: [livesMechanic()],
      roles: [
        { id: 'coin', kind: 'collectible', label: fruit, count: items },
        { id: 'hazard', kind: 'hazard', label: bomb },
      ],
      tutorial: { goalLine: fit(50, `Catch ${String(items)} ${fruits}. Dodge the ${bombs}!`, `Catch ${String(items)} ${fruits}!`, `Catch ${String(items)} falling things!`), controlsHint: 'Tap a lane, drag, or use the arrows to move.' },
      mood: 'playful',
      targetDurationSec: 45,
    });
  },
  draftFill: (sentence, reading) => {
    const { hero, setting, cast } = draftRoles(sentence, reading);
    // Chytání zná jen dvě role: co se chytá, a co padá jako bomba.
    const roles = (cast ?? []).map((item): CastItem => (item.does === 'collect' ? item : { ...item, does: 'avoid' }));
    // „catches falling apples“: předmět slovesa chytání je to, co padá do koše (slovník sběru ho nečte).
    const caught = CATCH_OBJECT.exec(sentence.toLowerCase());
    const phrase = caught === null ? null : nounPhrase(caught[1] as string);
    if (phrase !== null && !PRONOUN.test(phrase) && !roles.some((item) => item.does === 'collect')) {
      const label = singular(phrase);
      roles.splice(0, roles.length, ...roles.filter((item) => item.label !== label), { label, does: 'collect' });
    }
    return {
      genre: 'catch',
      mode: 'default',
      ...(hero === undefined ? {} : { hero }),
      ...(setting === undefined ? {} : { setting }),
      ...(roles.length === 0 ? {} : { cast: roles }),
    };
  },
};
