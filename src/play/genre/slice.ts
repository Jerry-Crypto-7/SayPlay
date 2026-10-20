/**
 * Žánr Krájení (P54C T8): věci vylétají po obloucích v pěti pruzích a hrdina je švihem rozsekne
 * (ovládání `lanes`, generátor `slice_arcs` v `arcade/pieces/slice.ts`). Co létá a krájí se, je věc
 * obsazení, kterou věta sbírá nebo krájí (`collect`, výchozí meloun); čemu se hrdina vyhýbá (`avoid`
 * a ostatní nepřátelé), létá jako bomba – švih do ní stojí život.
 *
 * Hloubka: cíl `items` kusů (`COUNT_PARAMS.slice.default.collectible`), tři třetiny hustších, nižších
 * a větších hrstí, 3 životy – bomba ve švihu a každé propadlé ovoce nad tři volná ubere život.
 * Robot vyhraje za 30–60 s, nečinný hráč prohraje, než něco rozsekne.
 *
 * Věty sem vede klasifikátor (T13, sloveso `slice` v `classify.ts`: krájí se, co letí, „fruit ninja“),
 * hraje ho buňka `slice.default`; režisér ho nabídne od T14.
 */

import { SLICE } from '../arcade/pieces/slice';
import { nounPhrase, plural, singular } from '../draft/lexicon';

import { type CastItem, type GenreModule, castFor, draftRoles, legacySpec, livesMechanic, titleCase } from './contract';

/** Výchozí věci, když je věta nejmenuje: meloun ke krájení a bomba. */
export const SLICE_DEFAULTS = { fruit: 'watermelon', bomb: 'bomb' } as const;

/** Role obsazení, kterou krájení hraje jako bombu: všechno, co hrdinovi škodí. */
const BOMB_DOES = ['avoid', 'chase_me', 'shoot_at', 'fight', 'throw_at'] as const;

/** Předmět slovesa krájení („slices flying fruit“, „slash the melons“, „chop all the vegetables“). */
const SLICE_OBJECT = /\b(?:slice|slash|chop|cut|split|dice)(?:s|es|ed|ing)?\s+(?:up\s+)?(?:all\s+|the\s+|some\s+|every\s+|flying\s+|those\s+)*([a-z][a-z -]*)/;
/** Bomba z věty („but not the bombs“, „avoid the rocks“, „don't slice the cats“). */
const AVOID_OBJECT = /\b(?:but not|not the|never (?:slice|slash|cut|chop)|don'?t (?:slice|slash|cut|chop|hit|touch)|avoid|dodge|spare)\s+(?:the\s+|any\s+)?([a-z][a-z -]*)/;
/** „slice it“, „cut through“ nejsou věc ve vzduchu. */
const PRONOUN = /^(?:it|him|her|them|me|you|us|up|out|down|through|across)\b/;
/** „fruit tossed in the air“, „lanterns thrown into the sky“: příčestí za jménem k věci nepatří (P54C T13). */
const FLIGHT = / (?:tossed|thrown|flung|hurled|launched|flying|falling|rising)$/;

/** První text, který se vejde do meze schématu (dlouhé popisky z věty). */
const fit = (max: number, ...lines: readonly string[]): string => lines.find((line) => line.length <= max) ?? (lines.at(-1) as string);

/** Podstatné jméno z předmětu slovesa, nebo `null`. */
function objectOf(pattern: RegExp, sentence: string): string | null {
  const found = pattern.exec(sentence);
  const phrase = found === null ? null : (nounPhrase(found[1] as string)?.replace(FLIGHT, '') ?? null);
  return phrase === null || PRONOUN.test(phrase) ? null : singular(phrase);
}

export const sliceGenre: GenreModule<'slice'> = {
  id: 'slice',
  modes: ['default'],
  // Narážky žádné: věty vede sloveso `slice` klasifikátoru (T13) – narážka by přidala bod i cestě džunglí („slice through“).
  cues: [],
  heroClasses: ['humanoid', 'robot', 'animal', 'monster'],
  paramBounds: {
    items: { min: SLICE.items.min, max: SLICE.items.max },
  },
  availability: () => 'ready',
  compile: (spec) => {
    const items = spec.params?.items ?? SLICE.items.default;
    const fruit = castFor(spec, 'collect', 'reach')?.label ?? SLICE_DEFAULTS.fruit;
    const bomb = castFor(spec, ...BOMB_DOES)?.label ?? SLICE_DEFAULTS.bomb;
    const fruits = plural(singular(fruit), items);
    const bombs = plural(singular(bomb), 2);
    return legacySpec(spec, {
      control: 'lanes',
      controlParams: { generator: 'slice_arcs', tuning: { items } },
      archetype: 'collect_exit',
      title: `${titleCase(spec.hero)} Slice`,
      objective: {
        kind: 'collect',
        description: fit(120, `Slice ${String(items)} flying ${fruits}, but not the ${bombs}.`, `Slice ${String(items)} flying ${fruits}.`, `Slice ${String(items)} flying things.`),
        count: items,
        role: 'coin',
      },
      mechanics: [livesMechanic()],
      roles: [
        { id: 'coin', kind: 'collectible', label: fruit, count: items },
        { id: 'hazard', kind: 'hazard', label: bomb },
      ],
      tutorial: { goalLine: fit(50, `Slice ${String(items)} ${fruits}. Not the ${bombs}!`, `Slice ${String(items)} ${fruits}!`, `Slice ${String(items)} flying things!`), controlsHint: 'Tap a lane to slash above the line. Arrows and Space work too.' },
      mood: 'playful',
      targetDurationSec: 45,
    });
  },
  draftFill: (sentence, reading) => {
    const { hero, setting, cast } = draftRoles(sentence, reading);
    // Krájení zná jen dvě role: co se krájí, a co létá jako bomba.
    let roles = (cast ?? []).map((item): CastItem => (item.does === 'collect' ? item : { ...item, does: 'avoid' }));
    const text = sentence.toLowerCase();
    const cut = objectOf(SLICE_OBJECT, text);
    if (cut !== null) roles = [{ label: cut, does: 'collect' }, ...roles.filter((item) => item.label !== cut && item.does !== 'collect')];
    const avoided = objectOf(AVOID_OBJECT, text);
    if (avoided !== null && avoided !== cut) roles = [...roles.filter((item) => item.label !== avoided && item.does !== 'avoid'), { label: avoided, does: 'avoid' }];
    return {
      genre: 'slice',
      mode: 'default',
      ...(hero === undefined ? {} : { hero }),
      ...(setting === undefined ? {} : { setting }),
      ...(roles.length === 0 ? {} : { cast: roles }),
    };
  },
};
