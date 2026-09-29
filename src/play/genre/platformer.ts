/**
 * Žánr Skákačka (P32): pohyb + skok po plošinách k vlajce. Pahýl P32-0 překládá
 * na dnešní ovládání `platform`; obsah modulu doplní stopa F.
 */

import { PLATFORM_LEVEL } from '../arcade/pieces/platform';

import { type GenreModule, draftRoles, legacySpec, titleCase } from './contract';

export const platformerGenre: GenreModule<'platformer'> = {
  id: 'platformer',
  modes: ['default'],
  cues: ['jump', 'climb', 'hop', 'leap'],
  heroClasses: ['animal', 'bird', 'humanoid', 'robot', 'monster'],
  paramBounds: { lengthM: { min: PLATFORM_LEVEL.minLengthM, max: PLATFORM_LEVEL.maxLengthM } },
  availability: () => 'ready',
  compile: (spec) =>
    legacySpec(spec, {
      control: 'platform',
      controlParams: { checkpoints: true, ...(spec.params?.lengthM === undefined ? {} : { lengthM: spec.params.lengthM }) },
      archetype: 'hazard_crossing',
      title: `${titleCase(spec.hero)} Jump`,
      objective: { kind: 'reach', description: `Jump across the platforms to the flag without touching a ${spec.enemy ?? 'spike'}.`, role: 'finish' },
      roles: [
        { id: 'spikes', kind: 'hazard', label: spec.enemy ?? 'spikes', count: 5 },
        { id: 'coin', kind: 'collectible', label: spec.collectible ?? 'coin' },
        { id: 'finish', kind: 'exit', label: 'flag' },
      ],
      tutorial: { goalLine: 'Reach the flag. Jump over gaps and hazards.', controlsHint: 'Arrows or A/D to move, Space or tap to jump.' },
      mood: 'playful',
    }),
  draftFill: (sentence, reading) => ({ genre: 'platformer', ...draftRoles(sentence, reading) }),
};
