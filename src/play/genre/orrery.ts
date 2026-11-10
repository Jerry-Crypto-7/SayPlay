/**
 * Typ Klikací simulace (P83C T2, `orrery`): věta, která nepopisuje hru, ale věc k prozkoumání („a solar system where
 * clicking a planet shows its name and makes it orbit faster“). Na scéně stojí 2–9 věcí z věty, hýbou se a klepnutí na
 * věc ji probudí – jmenovka a efekt podle věty (svítí / zrychlí / vyroste), další klepnutí efekt stupňuje (max 3).
 * Jádro, robot a generátor `orrery_scene` jsou v `arcade/pieces/orrery.ts`.
 *
 * **Parametry jsou celá čísla** (tvar `GenreSpec.params`): `things` 2–9, `layout` = index v `ORRERY_LAYOUTS`
 * (oběh, kruh, řada, rozházené), `answer` = index v `ORRERY_ANSWERS` (svítí, zrychlí, vyroste), `hub` 0/1 (první věc
 * stojí ve středu – slunce, jádro). Co z věty vyčíst, doplní T4; do té doby je typ `staged` a jeho buňka
 * v `STAGED_PRESETS` – klasifikátor, režisér ani čtečka ho nevidí, překlad i jádro už hrají (testy modulu).
 *
 * **Věci z věty:** role `orrery0`–`orrery8` (druh těla jádra = id role, scéna najde popisek přes vazbu rolí). Věta
 * s méně věcmi, než je počet, je opakuje dokola (zahrada s „flower“ dá pět květin).
 */

import { ORRERY, ORRERY_ANSWERS, ORRERY_LAYOUTS, orreryKind } from '../arcade/pieces/orrery';
import { counted, plural } from '../draft/lexicon';

import { type CastItem, type GenreModule, draftRoles, legacySpec, titleCase } from './contract';

/** Věc, když věta žádnou nejmenuje. */
export const ORRERY_DEFAULTS = { things: ['planet'] } as const;

/** První text, který se vejde do meze schématu (dlouhé popisky z věty). */
const fit = (max: number, ...lines: readonly string[]): string => lines.find((line) => line.length <= max) ?? (lines.at(-1) as string);

/**
 * Věci k prozkoumání: kulisy a sbírané z obsazení, bez opakování. Popisek zůstane, jak ho věta dala – `singular`
 * by z vlastních jmen udělal nesmysl („mars“ → „mar“); tvar popisku hlídá čtení věty (T4).
 */
function thingLabels(cast: readonly CastItem[]): string[] {
  const labels = cast.filter((item) => item.does === 'scenery' || item.does === 'collect').map((item) => item.label);
  return [...new Set(labels)].slice(0, ORRERY.things.max);
}

/** Index z parametru, oříznutý do délky výčtu. */
const pick = <T>(list: readonly T[], index: number | undefined, fallback: number): T => list[Math.min(list.length - 1, Math.max(0, index ?? fallback))] as T;

export const orreryGenre: GenreModule<'orrery'> = {
  id: 'orrery',
  modes: ['default'],
  // Narážky a znak typu v `classify.ts` přidá T4.
  cues: [],
  heroClasses: ['humanoid', 'animal', 'robot', 'monster', 'prop'],
  paramBounds: {
    things: { min: ORRERY.things.min, max: ORRERY.things.max },
    layout: { min: 0, max: ORRERY_LAYOUTS.length - 1 },
    answer: { min: 0, max: ORRERY_ANSWERS.length - 1 },
    hub: { min: 0, max: 1 },
  },
  // T4 přepne na `ready` spolu s přesunem buňky `orrery.default` do `PRESETS`.
  availability: () => 'staged',
  compile: (spec) => {
    const said = thingLabels(spec.cast ?? []);
    const labels = said.length > 0 ? said : [...ORRERY_DEFAULTS.things];
    const things = Math.min(ORRERY.things.max, Math.max(ORRERY.things.min, spec.params?.things ?? (said.length >= ORRERY.things.min ? said.length : ORRERY.things.default)));
    const layout = pick(ORRERY_LAYOUTS, spec.params?.layout, 0);
    const answer = pick(ORRERY_ANSWERS, spec.params?.answer, 0);
    const hub = spec.params?.hub === 1;
    const named = labels.slice(0, 3).map((label) => (labels.length === 1 ? plural(label, 2) : label));
    const list = named.length === 1 ? (named[0] as string) : `${named.slice(0, -1).join(', ')} and ${named.at(-1) as string}`;
    const does = answer === 'faster' ? 'spin faster' : answer === 'bigger' ? 'grow' : 'light up';
    return legacySpec(spec, {
      control: 'orrery',
      controlParams: { generator: 'orrery_scene', tuning: { things, layout, answer, hub } },
      archetype: 'collect_exit',
      title: fit(80, titleCase(spec.setting), 'Tap and See'),
      objective: {
        kind: 'collect',
        description: fit(120, `Tap the ${list} to see their names and make them ${does}: wake all ${String(things)}.`, `Tap each of the ${counted(things, 'thing')} to wake it.`),
        count: things,
        role: orreryKind(0),
      },
      mechanics: [],
      roles: Array.from({ length: things }, (_, index) => ({ id: orreryKind(index), kind: 'target' as const, label: labels[index % labels.length] as string })),
      tutorial: {
        goalLine: fit(50, `Tap the ${list}!`, `Wake all ${counted(things, 'thing')}!`),
        controlsHint: 'Tap a thing to wake it, tap again for more. Arrows and Space work too.',
      },
      mood: 'curious',
      targetDurationSec: ORRERY.parSeconds,
    });
  },
  draftFill: (sentence, reading) => {
    const { hero, setting, cast } = draftRoles(sentence, reading);
    // Klikací simulace nemá nepřítele: z obsazení zůstanou jen věci k prozkoumání.
    const roles = (cast ?? []).filter((item) => item.does === 'scenery' || item.does === 'collect');
    return {
      genre: 'orrery',
      mode: 'default',
      ...(hero === undefined ? {} : { hero }),
      ...(setting === undefined ? {} : { setting }),
      ...(roles.length === 0 ? {} : { cast: roles }),
    };
  },
};
