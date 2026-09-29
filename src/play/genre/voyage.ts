/**
 * Žánr Plavba/Let (P32): volné řízení s plynem – loď, koště, letadlo, raketa,
 * pes ve městě. Pahýl P32-0 překládá oba režimy na dnešní závod `steer`;
 * přistání zatím nehraje, proto `fallback`. Obsah modulu doplní stopa F.
 */

import { STEER_TRACK } from '../arcade/pieces/steer';

import { type GenreModule, draftRoles, legacySpec, titleCase } from './contract';

export const voyageGenre: GenreModule<'voyage'> = {
  id: 'voyage',
  modes: ['race', 'land'],
  cues: ['sail', 'fly', 'ride', 'drive', 'pilot', 'land'],
  heroClasses: ['boat', 'aircraft', 'vehicle', 'animal', 'humanoid'],
  paramBounds: { lengthM: { min: STEER_TRACK.minLengthM, max: STEER_TRACK.maxLengthM } },
  availability: (mode) => (mode === 'race' ? 'ready' : 'fallback'),
  compile: (spec) =>
    legacySpec(spec, {
      control: 'steer',
      controlParams: { difficulty: 'normal', ...(spec.params?.lengthM === undefined ? {} : { lengthM: spec.params.lengthM }) },
      archetype: 'hazard_crossing',
      title: `${titleCase(spec.hero)} Voyage`,
      objective: { kind: 'reach', description: `Steer past every ${spec.enemy ?? 'barrier'} and reach the finish first.`, role: 'finish' },
      roles: [
        { id: 'barrier', kind: 'hazard', label: spec.enemy ?? 'barrier', count: 5 },
        { id: 'rival', kind: 'patrol', label: `rival ${spec.hero}`, count: 3 },
        { id: 'turbo', kind: 'collectible', label: spec.collectible ?? 'turbo', count: 3 },
        { id: 'finish', kind: 'exit', label: 'finish line' },
      ],
      tutorial: { goalLine: 'Beat the rivals to the finish line.', controlsHint: 'Drag or arrows to steer. Down or a second finger brakes.' },
      mood: 'fast',
    }),
  draftFill: (sentence, reading) => ({ genre: 'voyage', ...draftRoles(sentence, reading) }),
};
