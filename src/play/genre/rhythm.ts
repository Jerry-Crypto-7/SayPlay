/**
 * Žánr Rytmus (P36A T11): noty jedou ve čtyřech drahách k liště a ťuk do
 * dráhy (pozice prstu, klávesy D/F/J/K) je trefí na dobu. Překládá na dnešní
 * ovládání `rhythm` (`rhythm_level`); scéna `components/play/arcade/rhythm`
 * ho kreslí beze změny.
 *
 * Hloubka: písnička ~33 s (doby z tempa), houstne po třetinách (řídká →
 * normální → hustá), ťuk míří do dráhy (`lanes`), 3 životy – minutí noty
 * nebo ťuk mimo ni ubere život. Robot vyhraje za ~36 s, nečinný hráč
 * prohraje na třetí přejeté notě.
 */

import { RHYTHM } from '../arcade/pieces/rhythm';
import { singular } from '../draft/lexicon';

import { type GenreModule, castFor, draftRoles, legacySpec, livesMechanic, titleCase } from './contract';

/** Tempo výchozí, délka písničky v sekundách výchozí a v mezích (doby = délka × tempo, nejvýš `RHYTHM.maxBeats`). */
export const RHYTHM_GENRE = { bpm: 120, seconds: 33, minSeconds: 30, maxSeconds: 48 } as const;

/** Doby písničky dlouhé `seconds` v tempu `bpm`, v mezích kusu. */
export const rhythmBeats = (bpm: number, seconds: number): number => Math.min(RHYTHM.maxBeats, Math.max(RHYTHM.minBeats, Math.round((seconds * bpm) / 60)));

/** Co jede po dráhách: „glowing tiles“, „lily pads“, „notes“. */
const NOTE_CUE = /\b(tiles?|notes?|pads?|lily pads|drums?|beats?)\b/;

export const rhythmGenre: GenreModule<'rhythm'> = {
  id: 'rhythm',
  modes: ['default'],
  cues: ['beat', 'music', 'song', 'drum', 'dance', 'rhythm', 'piano', 'melody'],
  heroClasses: ['humanoid', 'animal', 'bird', 'robot', 'monster'],
  paramBounds: {
    bpm: { min: RHYTHM.minBpm, max: RHYTHM.maxBpm },
    /** Délka písničky; čas z věty („a 40 second song“) jde sem. */
    seconds: { min: RHYTHM_GENRE.minSeconds, max: RHYTHM_GENRE.maxSeconds },
  },
  availability: () => 'ready',
  compile: (spec) => {
    const { bpm = RHYTHM_GENRE.bpm, seconds = RHYTHM_GENRE.seconds } = spec.params ?? {};
    // Nota je věc, kterou věta sbírá; bez ní věc, do které se střílí nebo hází – ťuk do ní na dobu (P39).
    const note = castFor(spec, 'collect', 'shoot_at', 'throw_at')?.label ?? 'tile';
    return legacySpec(spec, {
      control: 'rhythm',
      // Brzký a pozdní ťuk odpuštěný jako skok skákačky (P37A T7).
      controlParams: { bpm, beats: rhythmBeats(bpm, seconds), ramp: true, lanes: true, feel: 2 },
      archetype: 'hazard_crossing',
      title: `${titleCase(spec.hero)} Beat`,
      objective: { kind: 'reach', description: `Hit each ${note} in its lane on the beat and play the song to the end.`, role: 'finish' },
      mechanics: [livesMechanic()],
      roles: [
        { id: 'note', kind: 'collectible', label: note, count: 12 },
        { id: 'miss', kind: 'hazard', label: 'missed beat' },
        { id: 'finish', kind: 'exit', label: 'last beat' },
      ],
      tutorial: { goalLine: 'Tap each lane as its note hits the line. The song gets busier.', controlsHint: 'Tap the lane, or D F J K, on the beat. M toggles sound.' },
      mood: 'energetic',
    });
  },
  draftFill: (sentence, reading) => {
    const { hero, setting } = draftRoles(sentence, reading);
    const said = NOTE_CUE.exec(sentence.toLowerCase())?.[1];
    // Bubny a doby jsou hudba, ne to, co po dráze jede.
    const note = said === undefined || /^(?:drums?|beats?)$/.test(said) ? undefined : singular(said);
    return {
      genre: 'rhythm',
      mode: 'default',
      ...(hero === undefined ? {} : { hero }),
      ...(setting === undefined ? {} : { setting }),
      ...(note === undefined ? {} : { cast: [{ label: note, does: 'collect' as const }] }),
    };
  },
};
