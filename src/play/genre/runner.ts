/**
 * Žánr Běžec (P32): pruhy + skok, trať k cíli. Pahýl P32-0 překládá na dnešní
 * ovládání `runner`; skutečný obsah modulu doplní stopa A (P32A T7).
 */

import { RUNNER_TRACK } from '../arcade/pieces/runner';

import { type GenreModule, draftRoles, legacySpec, titleCase } from './contract';

export const runnerGenre: GenreModule<'runner'> = {
  id: 'runner',
  modes: ['default'],
  cues: ['run', 'dash', 'slide', 'ski', 'sled'],
  heroClasses: ['animal', 'bird', 'humanoid', 'robot', 'vehicle'],
  paramBounds: { lengthM: { min: RUNNER_TRACK.minLengthM, max: RUNNER_TRACK.maxLengthM } },
  availability: () => 'ready',
  compile: (spec) =>
    legacySpec(spec, {
      control: 'runner',
      ...(spec.params?.lengthM === undefined ? {} : { controlParams: { lengthM: spec.params.lengthM } }),
      archetype: 'hazard_crossing',
      title: `${titleCase(spec.hero)} Run`,
      objective: { kind: 'reach', description: `Run to the finish without hitting a ${spec.enemy ?? 'rock'}.`, role: 'finish' },
      roles: [
        { id: 'obstacle', kind: 'hazard', label: spec.enemy ?? 'rock' },
        { id: 'coin', kind: 'collectible', label: spec.collectible ?? 'coin' },
        { id: 'finish', kind: 'exit', label: 'finish line' },
      ],
      tutorial: { goalLine: 'Reach the finish line. Jump, slide and switch lanes.', controlsHint: 'Tap or Space to jump, swipe or arrows to change lane.' },
      mood: 'energetic',
    }),
  draftFill: (sentence, reading) => ({ genre: 'runner', ...draftRoles(sentence, reading) }),
};
