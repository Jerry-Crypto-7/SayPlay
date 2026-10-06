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
import { plural, singular } from '../draft/lexicon';

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
    goal: (count) => `Stop the marker in the zone ${String(count)} times. It speeds up.`,
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

/** Co se staví do věže: „stack burgers“, „stack animals on top of each other“, „pancake tower“. */
const STACKED = /\bstack(?:s|ing)? (?:the |a |an |some |\d+ )?([a-z]+)\b|\b([a-z]+) (?:tower|stack)\b/;
const NOT_A_PIECE = /^(?:as|up|on|them|it|high|tallest|highest|helix|the|a|an)$/;

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
    const piece = spec.mode === 'stack' ? (castFor(spec, 'collect')?.label ?? text.piece) : text.piece;
    const goal = text.goal(rounds, piece);
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
        { id: 'finish', kind: 'exit', label: text.finish },
      ],
      tutorial: { goalLine: goal, controlsHint: text.hint },
      mood: 'playful',
    });
  },
  draftFill: (sentence, reading) => {
    const { hero, setting } = draftRoles(sentence, reading);
    const match = STACKED.exec(sentence.toLowerCase());
    const stacked = match === null ? undefined : (match[1] ?? match[2]);
    const piece = stacked === undefined || NOT_A_PIECE.test(stacked) ? undefined : singular(stacked);
    return {
      genre: 'timing',
      ...(hero === undefined ? {} : { hero }),
      ...(setting === undefined ? {} : { setting }),
      ...(piece === undefined ? {} : { cast: [{ label: piece, does: 'collect' as const }] }),
    };
  },
};
