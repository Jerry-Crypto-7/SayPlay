/**
 * Žánr Načasování (P36A T11): jezdec jezdí kyvadlem sem a tam a ťuk ho
 * zastaví nad cílem – blok na věž (`stack`), ručička na liště (`precision`),
 * prkno přes propast (`bridge`). Překládá na dnešní ovládání `timing`
 * (`timing_level`); scéna `components/play/arcade/timing` ho kreslí beze změny.
 *
 * Hloubka: 36 kol, každé rychlejší (`rise` – od pomalé rychlosti o 40 jednotek
 * za tik do posledního kola), 3 životy (minutí ubere život a kolo se
 * opakuje). Robot vyhraje za ~32 s, nečinný hráč prohraje po třetím minutí
 * (dva celé kyvy bez ťuku = minutí).
 */

import { TIMING } from '../arcade/pieces/timing';
import { counted, plural, singular } from '../draft/lexicon';

import { type GenreModule, type GenreSpecOf, castFor, draftRoles, legacySpec, livesMechanic, titleCase } from './contract';

/** Kol výchozí a v mezích: pod 34 kol robot dohraje pod 30 s. */
export const TIMING_GENRE = { rounds: 36, minRounds: 34 } as const;

type TimingMode = GenreSpecOf<'timing'>['mode'];

/** Texty režimu; `piece` je, co ťuk položí (popisek role `block` přebije u věže). */
const TEXT: Readonly<Record<TimingMode, { readonly title: string; readonly piece: string; readonly finish: string; readonly goal: (count: number, piece: string) => string; readonly hint: string }>> = {
  stack: {
    title: 'Stack',
    piece: 'block',
    finish: 'top of the tower',
    goal: (count, piece) => `Stack ${String(count)} ${plural(piece, count)}. Each one swings faster.`,
    hint: 'Tap or Space to drop the block.',
  },
  precision: {
    title: 'Timing',
    piece: 'marker',
    finish: 'last round',
    goal: (count) => `Stop the marker in the zone ${counted(count, 'time')}. It speeds up.`,
    hint: 'Tap or Space to stop the marker.',
  },
  bridge: {
    title: 'Bridge',
    piece: 'plank',
    finish: 'far side',
    goal: (count) => `Stop each plank over the gap. Lay ${String(count)} to cross.`,
    hint: 'Tap or Space to drop the plank.',
  },
};

/**
 * Co se staví do věže: „stack burgers“, „stack animals on top of each other“, „pancake tower“; P73A T3 i „a tower of
 * pancakes“ – ta stavěla kvádry, protože „a tower“ vzal člen za předmět. Fráze s „of“ má přednost.
 */
const STACKED_OF = /\b(?:tower|stack|pile|heap) of (?:the |some |\d+ )?([a-z]+)\b/;
const STACKED = /\bstack(?:s|ing)? (?:the |a |an |some |\d+ )?([a-z]+)\b|\b([a-z]+) (?:tower|stack)\b/;
/** Ani věž sama („stack the tower as high as you can“) dílem věže není. */
const NOT_A_PIECE = /^(?:as|up|on|them|it|high|tallest|highest|helix|the|a|an|towers?|stacks?|piles?|heaps?)$/;

/**
 * „cut the rope … feed the monster“ (P71C T3): věc visí na laně nad tím, koho krmí, a ťuk lano přestřihne.
 * Krmí se příšera, kterou věta jmenuje (`feed the frog`), jinak příšera; visí, co se krmí (`feed the candy to`), jinak bonbon.
 */
const ROPE = /\bcut (?:the |a )?ropes?\b/;
const FED = /\bfeed (?:the |a |an |my )?([a-z]+)(?: to (?:the |a |an |my )?([a-z]+))?/;

export const timingGenre: GenreModule<'timing'> = {
  id: 'timing',
  modes: ['stack', 'precision', 'bridge'],
  cues: ['stack', 'timing', 'tower', 'swing'],
  heroClasses: ['humanoid', 'robot', 'animal', 'bird', 'monster', 'vehicle', 'boat', 'aircraft'],
  paramBounds: {
    rounds: { min: TIMING_GENRE.minRounds, max: TIMING.maxRounds },
  },
  availability: () => 'ready',
  compile: (spec) => {
    const { rounds = TIMING_GENRE.rounds } = spec.params ?? {};
    const text = TEXT[spec.mode];
    // P58A T6: věc z věty nese i ručička lišty („flipping pancakes“) – scéna ji kreslí na ručičce; můstek má prkno.
    const piece = spec.mode === 'bridge' ? text.piece : (castFor(spec, 'collect')?.label ?? text.piece);
    // P71C T3: věc z věty (`collect`) a komu ji lišta dopraví (`reach`) – scéna ho kreslí nad cílem a věc mu visí na laně.
    // Jen cíl bez věci („build a bridge at the right time“) lano nemá.
    const fed = spec.mode === 'precision' && castFor(spec, 'collect') !== undefined ? castFor(spec, 'reach')?.label : undefined;
    const goal = fed === undefined ? text.goal(rounds, piece) : `Cut the rope when the ${piece} is over the ${fed} – ${counted(rounds, 'time')}. It speeds up.`;
    return legacySpec(spec, {
      control: 'timing',
      // Brzký a pozdní ťuk odpuštěný jako skok skákačky (P37A T7).
      controlParams: { mode: spec.mode, speed: 'slow', rounds, rise: true, feel: 2 },
      archetype: 'hazard_crossing',
      title: `${titleCase(spec.hero)} ${text.title}`,
      objective: { kind: 'reach', description: goal, role: 'finish' },
      mechanics: [livesMechanic()],
      roles: [
        { id: 'block', kind: 'collectible', label: piece, count: Math.min(50, rounds) },
        { id: 'miss', kind: 'hazard', label: 'missed drop' },
        { id: 'finish', kind: 'exit', label: fed ?? text.finish },
      ],
      tutorial: { goalLine: goal, controlsHint: fed === undefined ? text.hint : 'Tap or Space to cut the rope.' },
      mood: 'playful',
    });
  },
  draftFill: (sentence, reading) => {
    const { hero, setting } = draftRoles(sentence, reading);
    const text = sentence.toLowerCase();
    if (ROPE.test(text)) {
      const fed = FED.exec(text);
      const [hanging, eater] = fed?.[2] === undefined ? ['candy', fed?.[1] ?? 'monster'] : [fed[1] ?? 'candy', fed[2]];
      return {
        genre: 'timing',
        ...(hero === undefined ? {} : { hero }),
        ...(setting === undefined ? {} : { setting }),
        cast: [
          { label: singular(hanging), does: 'collect' as const },
          { label: singular(eater), does: 'reach' as const },
        ],
      };
    }
    const match = STACKED.exec(text);
    const stacked = STACKED_OF.exec(text)?.[1] ?? (match === null ? undefined : (match[1] ?? match[2]));
    const piece = stacked === undefined || NOT_A_PIECE.test(stacked) ? undefined : singular(stacked);
    return {
      genre: 'timing',
      ...(hero === undefined ? {} : { hero }),
      ...(setting === undefined ? {} : { setting }),
      ...(piece === undefined ? {} : { cast: [{ label: piece, does: 'collect' as const }] }),
    };
  },
};
