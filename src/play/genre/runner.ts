/**
 * Žánr Běžec (P32A T7): pruhy + skok + skluz, trať k cíli. Překládá na dnešní
 * ovládání `runner`: překážky a sběratelné věci z rolí věty, sada vzhledu
 * z prostředí, rychlost a hustota v mezích. Rampa rychlosti jde s délkou
 * tratě sama (`rampMarks`), spec ji nenese.
 *
 * Referenční věta: „A penguin slides down an icy mountain, collects snowflakes
 * and avoids rocks“ → tučňák, kámen, vločka, sníh (`__fixtures__/penguin.json`).
 */

import { lookFor } from '../arcade/look';
import { OBSTACLE_KINDS, RUNNER_DENSITIES, RUNNER_SPEEDS, RUNNER_TRACK } from '../arcade/pieces/runner';
import { nounPhrase, singular } from '../draft/lexicon';

import { type GenreModule, draftRoles, legacySpec, titleCase } from './contract';

/** Překážka z věty: čemu se hrdina vyhýbá, co přeskakuje nebo podbíhá. */
const OBSTACLE_CUE =
  /\b(?:avoid(?:s|ed|ing)?|dodg(?:e|es|ed|ing)|evad(?:e|es|ed|ing)|(?:jump|leap|hop)(?:s|ed|ing|ped|ping)? over|duck(?:s|ed|ing)? under|swerv(?:e|es|ed|ing) (?:around|past)|past) (?:the |a |an |all |any )?([a-z][a-z -]*)/;

/** Kudy běží, když věta místo neuvede předložkou „in/on/through“: „slides down an icy mountain“. */
const COURSE_CUE = /\b(?:down|along|across|over) (?:a |an |the )([a-z][a-z -]*)/;

/** Překážka nad hlavou se podbíhá – jen ta smí dostat laťku skluzu; kámen se přeskočí nebo oběhne. */
const OVERHEAD = /\b(?:low|overhead|hanging)\b|\b(?:branch|bar|beam|pipe|sign|banner|rope|wire|cable|arch|icicle)(?:e?s)?\b/;

/** Druhy role nepřítele ve čtení modelem – tytéž, které čte `draftRoles`. */
const ENEMY_KINDS = ['chaser', 'threat', 'hazard', 'obstacle'];

const phraseAfter = (pattern: RegExp, text: string): string | null => {
  const match = pattern.exec(text.toLowerCase());
  return match === null ? null : nounPhrase(match[1]!, 2);
};

export const runnerGenre: GenreModule<'runner'> = {
  id: 'runner',
  modes: ['default'],
  cues: ['run', 'runner', 'dash', 'sprint', 'slide', 'ski', 'snowboard', 'skate', 'surf', 'sled', 'sledge', 'toboggan', 'escape', 'race down', 'rush down', 'jump over', 'dodge', 'endless', 'lane'],
  heroClasses: ['animal', 'bird', 'humanoid', 'robot', 'vehicle'],
  paramBounds: {
    lengthM: { min: RUNNER_TRACK.minLengthM, max: RUNNER_TRACK.maxLengthM },
    /** Index do `RUNNER_SPEEDS` (pomalu, normálně, rychle). */
    speed: { min: 0, max: RUNNER_SPEEDS.length - 1 },
    /** Index do `RUNNER_DENSITIES` (řídce, normálně, hustě). */
    density: { min: 0, max: RUNNER_DENSITIES.length - 1 },
  },
  availability: () => 'ready',
  compile: (spec) => {
    const obstacle = spec.enemy ?? 'rock';
    const palette = spec.palette ?? lookFor(spec.setting) ?? undefined;
    const { lengthM, speed, density } = spec.params ?? {};
    return legacySpec(palette === undefined ? spec : { ...spec, palette }, {
      control: 'runner',
      controlParams: {
        ...(lengthM === undefined ? {} : { lengthM }),
        ...(speed === undefined ? {} : { speed: RUNNER_SPEEDS[speed] }),
        ...(density === undefined ? {} : { density: RUNNER_DENSITIES[density] }),
        obstacles: OVERHEAD.test(obstacle) ? [...OBSTACLE_KINDS] : OBSTACLE_KINDS.filter((kind) => kind !== 'slide-bar'),
      },
      archetype: 'hazard_crossing',
      title: `${titleCase(spec.hero)} Run`,
      objective: { kind: 'reach', description: `Run to the finish without hitting a ${obstacle}.`, role: 'finish' },
      roles: [
        { id: 'obstacle', kind: 'hazard', label: obstacle },
        { id: 'coin', kind: 'collectible', label: spec.collectible ?? 'coin' },
        { id: 'finish', kind: 'exit', label: 'finish line' },
      ],
      tutorial: { goalLine: 'Reach the finish line. Jump, slide and switch lanes.', controlsHint: 'Tap or Space to jump, swipe or arrows to change lane.' },
      mood: 'energetic',
    });
  },
  draftFill: (sentence, reading) => {
    const roles = draftRoles(sentence, reading);
    // Čtení modelem má přednost; bez něj překážka z věty běžce („avoids rocks“) před nepřítelem ze slovníku.
    const readEnemy = reading?.roles.some((role) => ENEMY_KINDS.includes(role.kind)) === true;
    const dodged = phraseAfter(OBSTACLE_CUE, sentence);
    const enemy = readEnemy || dodged === null ? roles.enemy : singular(dodged);
    const setting = roles.setting ?? phraseAfter(COURSE_CUE, sentence) ?? undefined;
    const palette = setting === undefined ? null : lookFor(setting);
    return {
      genre: 'runner',
      mode: 'default',
      ...roles,
      ...(enemy === undefined ? {} : { enemy }),
      ...(setting === undefined ? {} : { setting }),
      ...(palette === null ? {} : { palette }),
    };
  },
};
