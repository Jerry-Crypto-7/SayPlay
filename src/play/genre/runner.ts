/**
 * Žánr Běžec (P32A T7): pruhy + skok + skluz, trať k cíli. Překládá na dnešní
 * ovládání `runner`: překážky a sběratelné věci z rolí věty, sada vzhledu
 * z prostředí, rychlost a hustota v mezích. Trať je ze tří úseků (P36A T4,
 * `RUNNER_SECTIONS`): každý hustší a rychlejší, délka podle počtů z věty
 * („dodge 40 cars“, „collect 30 coins“), robot ji uběhne za 30–90 s.
 *
 * Referenční věta: „A penguin slides down an icy mountain, collects snowflakes
 * and avoids rocks“ → tučňák, kámen, vločka, sníh (`__fixtures__/penguin.json`).
 */

import { lookFor } from '../arcade/look';
import { OBSTACLE_KINDS, RUNNER_DENSITIES, RUNNER_SECTIONS, RUNNER_SPEEDS, RUNNER_TRACK } from '../arcade/pieces/runner';
import { nounPhrase, singular } from '../draft/lexicon';

import { type GenreModule, draftRoles, legacySpec, livesMechanic, titleCase } from './contract';

/** Překážka z věty: čemu se hrdina vyhýbá, co přeskakuje nebo podbíhá. */
const OBSTACLE_CUE =
  /\b(?:avoid(?:s|ed|ing)?|dodg(?:e|es|ed|ing)|evad(?:e|es|ed|ing)|(?:jump|leap|hop)(?:s|ed|ing|ped|ping)? over|duck(?:s|ed|ing)? under|swerv(?:e|es|ed|ing) (?:around|past)|past) (?:the |a |an |all |any )?([a-z][a-z -]*)/;

/** Kudy běží, když věta místo neuvede předložkou „in/on/through“: „slides down an icy mountain“. */
const COURSE_CUE = /\b(?:down|along|across|over) (?:a |an |the )([a-z][a-z -]*)/;

/** Překážka nad hlavou se podbíhá – jen ta smí dostat laťku skluzu; kámen se přeskočí nebo oběhne. */
const OVERHEAD = /\b(?:low|overhead|hanging)\b|\b(?:branch|bar|beam|pipe|sign|banner|rope|wire|cable|arch|icicle)(?:e?s)?\b/;

/**
 * Slova jízdy: klouže, lyžuje, surfuje, jede na prkně, bruslích nebo saních (tvary jako `cues`).
 * Čte je i scéna ve jménu modelu hrdiny (`runner/heroMotion.ts`: `cc0-sled`).
 */
export const RIDE_WORDS =
  /\b(?:slid(?:e|es|ing)|ski(?:s|ed|ing|er|ers)?|surf(?:s|ed|ing|er|ers|board|boards)?|snowboard(?:s|ed|ing|er|ers)?|skat(?:e|es|ed|ing|er|ers)|skateboard(?:s|ing|er|ers)?|sled(?:s|ge|ges|ding)?|toboggan(?:s|ed|ing)?)\b/;

/** Nejvyšší počet z věty: strop `count` role ve `spec.ts` (generátor unese víc, `RUNNER_SECTIONS.maxRows`). */
const COUNT_MAX = Math.min(50, RUNNER_SECTIONS.maxRows, RUNNER_TRACK.maxCoins);

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
    /** 1 = hrdina jede (klouže, lyžuje, surfuje), ne běží – jen póza ve scéně (`theme.motion`, T5-R1). */
    ride: { min: 0, max: 1 },
    /** Kolik věcí sebrat po trati (`counts.collectible`, P36A T4); trať má aspoň tolik řad. */
    items: { min: 1, max: COUNT_MAX },
    /** Kolik řad překážek uhnout (`counts.enemy`, P36A T4). */
    obstacles: { min: 1, max: COUNT_MAX },
  },
  availability: () => 'ready',
  compile: (spec) => {
    const obstacle = spec.enemy ?? 'rock';
    const palette = spec.palette ?? lookFor(spec.setting) ?? undefined;
    const { lengthM, speed, density, ride, items, obstacles: rows } = spec.params ?? {};
    const game = legacySpec(palette === undefined ? spec : { ...spec, palette }, {
      control: 'runner',
      controlParams: {
        ...(lengthM === undefined ? {} : { lengthM }),
        ...(speed === undefined ? {} : { speed: RUNNER_SPEEDS[speed] }),
        ...(density === undefined ? {} : { density: RUNNER_DENSITIES[density] }),
        obstacles: OVERHEAD.test(obstacle) ? [...OBSTACLE_KINDS] : OBSTACLE_KINDS.filter((kind) => kind !== 'slide-bar'),
        // Skok odpouští jako skákačka: chvilku po hraně i stisk těsně před dopadem (P36A T6).
        feel: 2,
        // Rozjezd, hustší, nejtěžší úsek; délka podle počtů z věty (P36A T4).
        sections: 3,
      },
      archetype: 'hazard_crossing',
      title: `${titleCase(spec.hero)} Run`,
      objective: { kind: 'reach', description: `Run to the finish without hitting a ${obstacle}.`, role: 'finish' },
      // Náraz ubere život a běh jede dál (P36A T2).
      mechanics: [livesMechanic()],
      // Počet role čte generátor (`COUNTED_ROLES`): řady překážek a mince na trati.
      roles: [
        { id: 'obstacle', kind: 'hazard', label: obstacle, ...(rows === undefined ? {} : { count: rows }) },
        { id: 'coin', kind: 'collectible', label: spec.collectible ?? 'coin', ...(items === undefined ? {} : { count: items }) },
        { id: 'finish', kind: 'exit', label: 'finish line' },
      ],
      tutorial: { goalLine: 'Reach the finish line. Jump, slide and switch lanes.', controlsHint: 'Tap or Space to jump, swipe or arrows to change lane.' },
      mood: 'energetic',
    });
    // Bez jízdy `theme` bez pole – tvar hry je stejný jako před T5-R1.
    return ride === 1 ? { ...game, theme: { ...game.theme, motion: 'ride' } } : game;
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
      ...(RIDE_WORDS.test(sentence.toLowerCase()) ? { params: { ride: 1 } } : {}),
    };
  },
};
