/**
 * Žánr Poletování (P36A T11): hrdina letí sám vpřed a ťuk ho vynese vzhůru –
 * prolétá mezerami mezi trubkami („like flappy bird“). Překládá na dnešní
 * ovládání `flap` (`flap_track`); scéna `components/play/arcade/flap` ho
 * kreslí beze změny.
 *
 * Hloubka: trať 220 m (dřív 120 m, ~20 s), mezery se po třetinách zužují a
 * let na třetinách zrychlí (`rise`, rampa trati), 3 životy – náraz do trubky
 * ubere jeden a vteřinu další nebere; dotek země prohrává. Robot vyhraje za
 * ~37 s, nečinný hráč spadne na zem za půl vteřiny.
 */

import { FLAP_TRACK } from '../arcade/pieces/flap';

import { type GenreModule, draftRoles, legacySpec, livesMechanic, titleCase } from './contract';

/** Délka trati výchozí a v mezích: pod 180 m robot doletí pod 30 s. */
export const FLAP_GENRE = { lengthM: 220, minLengthM: 180 } as const;

export const flapGenre: GenreModule<'flap'> = {
  id: 'flap',
  modes: ['default'],
  cues: ['flap', 'flappy', 'wing', 'flutter'],
  heroClasses: ['bird', 'aircraft', 'animal', 'monster', 'robot', 'humanoid'],
  paramBounds: {
    lengthM: { min: FLAP_GENRE.minLengthM, max: FLAP_TRACK.maxLengthM },
  },
  availability: () => 'ready',
  compile: (spec) => {
    const { lengthM = FLAP_GENRE.lengthM } = spec.params ?? {};
    return legacySpec(spec, {
      control: 'flap',
      // Pozdní vzlet ze země odpuštěný jako skok skákačky (P37A T7).
      controlParams: { lengthM, rise: true, feel: 2 },
      archetype: 'hazard_crossing',
      title: `${titleCase(spec.hero)} Flight`,
      objective: { kind: 'reach', description: 'Flap through the gaps between the pipes to the finish.', role: 'finish' },
      mechanics: [livesMechanic()],
      roles: [
        { id: 'pipe', kind: 'hazard', label: 'pipe' },
        { id: 'coin', kind: 'collectible', label: spec.collectible ?? 'coin' },
        { id: 'finish', kind: 'exit', label: 'finish line' },
      ],
      tutorial: { goalLine: 'Fly through the gaps to the finish. They get tighter.', controlsHint: 'Tap or Space to flap.' },
      mood: 'cheerful',
    });
  },
  draftFill: (sentence, reading) => {
    const { hero, setting, collectible } = draftRoles(sentence, reading);
    return {
      genre: 'flap',
      mode: 'default',
      ...(hero === undefined ? {} : { hero }),
      ...(setting === undefined ? {} : { setting }),
      ...(collectible === undefined ? {} : { collectible }),
    };
  },
};
