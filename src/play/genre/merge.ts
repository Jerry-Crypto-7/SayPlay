/**
 * Žánr Pouštění a slučování (P54C T11, Suika): hrdina nad nádobou pouští předměty a dva stejné, které se dotknou,
 * se sloučí ve větší (ovládání `merge`, generátor `merge_box` v `arcade/pieces/merge-drop.ts`, fyzika Rapier).
 * Co se pouští a slučuje, je věc obsazení (`collect`, jinak první věc věty; výchozí ovoce – scéna kreslí řadu
 * třešeň → meloun).
 *
 * Hloubka: 6 úrovní, cíl `MERGE.need` sloučení do `MERGE.seconds` s; kdo s pustem otálí, tomu předmět zkamení;
 * 3 životy – každý vezme nádoba, která přeteče (něco nad víkem déle než 1 s).
 *
 * Věty sem klasifikátor zatím nevede (T13b) a režisér ho nenabízí (`DIRECTOR_PENDING`); hraje ho buňka `merge.default`.
 */

import { MERGE, MERGE_ITEM } from '../arcade/pieces/merge-drop';
import { nounPhrase, plural, singular } from '../draft/lexicon';

import { type CastItem, type GenreModule, castFor, draftRoles, legacySpec, livesMechanic, titleCase } from './contract';

/** Výchozí věc, když ji věta nejmenuje: ovoce (scéna kreslí řadu ovoce z katalogu, největší je meloun). */
export const MERGE_DEFAULTS = { item: MERGE_ITEM } as const;

/** Předmět slovesa slučování („merges planets“, „drop the fruit“, „combine two gems“). */
const MERGE_OBJECT = /\b(?:merge|combine|drop|match|fuse)(?:s|es|ed|ing)?\s+(?:the\s+|two\s+|some\s+|all\s+|matching\s+|falling\s+)*([a-z][a-z -]*)/;
/** „merge into traffic“, „drop it“ nejsou věc v nádobě. */
const NOT_ITEM = /^(?:it|them|into|in|on|onto|off|out|down|by|with|to|and|together)\b/;

/** První text, který se vejde do meze schématu (dlouhé popisky z věty). */
const fit = (max: number, ...lines: readonly string[]): string => lines.find((line) => line.length <= max) ?? (lines.at(-1) as string);

export const mergeGenre: GenreModule<'merge'> = {
  id: 'merge',
  modes: ['default'],
  // Narážky žádné: věty k žánru povede až klasifikátor (T13b) – „merge into traffic“ je past dev sady.
  cues: [],
  heroClasses: ['prop', 'animal', 'humanoid', 'robot', 'monster'],
  paramBounds: {},
  availability: () => 'ready',
  compile: (spec) => {
    const item = castFor(spec, 'collect', 'scenery', 'reach')?.label ?? MERGE_DEFAULTS.item;
    const items = plural(singular(item), 2);
    return legacySpec(spec, {
      control: 'merge',
      controlParams: { generator: 'merge_box' },
      archetype: 'collect_exit',
      title: `${titleCase(spec.hero)} Merge`,
      objective: {
        kind: 'collect',
        description: fit(120, `Drop ${items} and merge two of a kind into bigger ones. Make ${String(MERGE.need)} merges before time runs out.`, `Merge ${String(MERGE.need)} times before time runs out.`),
        count: MERGE.need,
        role: 'item',
      },
      mechanics: [{ ...livesMechanic(), params: { max: MERGE.lives } }],
      roles: [{ id: 'item', kind: 'collectible', label: item }],
      tutorial: {
        goalLine: fit(50, `Merge ${String(MERGE.need)} times before time runs out!`, `Merge ${String(MERGE.need)} times!`),
        controlsHint: 'Drag to move, let go to drop. Arrows and Space work too.',
      },
      mood: 'playful',
      targetDurationSec: MERGE.seconds,
    });
  },
  draftFill: (sentence, reading) => {
    const { hero, setting, cast } = draftRoles(sentence, reading);
    // Slučování zná jen jednu roli: co se pouští a slučuje. Nepřátelé věty v nádobě nemají co dělat.
    let roles = (cast ?? []).filter((item) => item.does === 'collect' || item.does === 'scenery');
    const found = MERGE_OBJECT.exec(sentence.toLowerCase());
    const phrase = found === null ? null : nounPhrase(found[1] as string);
    if (phrase !== null && !NOT_ITEM.test(phrase)) {
      const label = singular(phrase);
      roles = [{ label, does: 'collect' } satisfies CastItem, ...roles.filter((item) => item.label !== label)];
    }
    return {
      genre: 'merge',
      mode: 'default',
      ...(hero === undefined ? {} : { hero }),
      ...(setting === undefined ? {} : { setting }),
      ...(roles.length === 0 ? {} : { cast: roles }),
    };
  },
};
