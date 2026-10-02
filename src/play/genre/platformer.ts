/**
 * Žánr Skákačka (P32F T3): pohyb + skok po plošinách k cíli. Překládá na
 * dnešní ovládání `platform` s pocitem skoku `feel: 2` (coyote time, buffer
 * skoku, výška podle držení – `pieces/platform.ts`); ten nese `tuning`, takže
 * ho validuje generátor plošinovky, ne `spec.ts`.
 *
 * Cíl a věc z věty (P35 T3): `target` je cíl úrovně místo vlajky („reach the
 * moon“, „find its battery“), `collectible` věc místo mince. Sbírací sloveso
 * cíle („collect“, „grab“, „gather“) mění výhru: doskákat k cíli až se všemi
 * věcmi (`collectAll`); ostatní slovesa vyhrávají doskokem, věci jsou bonus.
 *
 * Úroveň má tři úseky s rostoucí obtížností a checkpointem na začátku druhého
 * a třetího (P36A T4, `sections` v `tuning`); věc ke sběru navíc úroveň prodlouží
 * a hodiny (robot je stihne s rezervou) dají prohrát i hráči, který stojí.
 *
 * Referenční věta: „A frog jumps across lily pads to reach the island“.
 */

import { PLATFORM_LEVEL } from '../arcade/pieces/platform';
import { nounPhrase, plural, singular } from '../draft/lexicon';

import { type GenreModule, type GenreSpecOf, draftRoles, legacySpec, livesMechanic, titleCase } from './contract';

/** Sloveso cíle, u kterého se vyhrává sebráním všech věcí. */
const COLLECT_VERB = /^(?:collect|grab|gather|pick)/;

/** „to collect carrots“, „grabs 5 apples“, „gathering all the acorns“: co se sbírá. */
const COLLECT_CUE = /\b(collect|grab|gather|pick up)(?:s|es|ing)? (.+)/;
/** „to find its battery“, „reach the moon“, „gets to the island“: kam se doskáče. */
const GOAL_CUE = /\b(find|reach|get(?:s|ting)? to)(?:s|es|ing)? (.+)/;

function compilePlatformer(spec: GenreSpecOf<'platformer'>) {
  const verb = spec.target?.verb.toLowerCase() ?? '';
  const collect = COLLECT_VERB.test(verb);
  const same = (a: string | undefined, b: string | undefined): boolean => a !== undefined && b !== undefined && singular(a) === singular(b);
  // Sbírací cíl, který jmenuje věc („collect carrots“), není cíl úrovně – zůstane vlajka. Jinak je cíl
  // vždy cíl a věc, která ho opakuje („find its crown“ čte slovník i jako věc), je mince.
  const item = collect ? (spec.collectible ?? spec.target?.label ?? 'coin') : same(spec.collectible, spec.target?.label) ? 'coin' : (spec.collectible ?? 'coin');
  const named = spec.target === undefined || (collect && same(spec.target.label, item)) ? null : spec.target.label;
  const goal = named ?? 'flag';
  const count = spec.params?.items ?? (collect ? PLATFORM_LEVEL.collectCount : undefined);
  const line = collect ? `Collect ${String(count)} ${plural(singular(item), count!)} and reach the ${goal}.` : named === null ? null : `${verb.startsWith('find') ? 'Find' : 'Reach'} the ${goal}.`;
  return legacySpec(spec, {
    control: 'platform',
    controlParams: {
      checkpoints: true,
      ...(spec.params?.lengthM === undefined ? {} : { lengthM: spec.params.lengthM }),
      // Tři úseky s rostoucí obtížností, checkpoint na začátku druhého a třetího, hodiny (P36A T4).
      tuning: { feel: 2, sections: 3, ...(collect ? { collectAll: true, coinCount: count } : {}) },
    },
    archetype: 'hazard_crossing',
    title: `${titleCase(spec.hero)} Jump`,
    objective: { kind: 'reach', description: line ?? `Jump across the platforms to the flag without touching a ${spec.enemy ?? 'spike'}.`, role: 'finish' },
    // Hrot ubere život a vrátí hrdinu na checkpoint (P36A T2).
    mechanics: [livesMechanic()],
    roles: [
      { id: 'spikes', kind: 'hazard', label: spec.enemy ?? 'spikes', count: 5 },
      { id: 'coin', kind: 'collectible', label: item, ...(count === undefined ? {} : { count }) },
      { id: 'finish', kind: 'exit', label: goal },
    ],
    tutorial: { goalLine: line ?? 'Reach the flag. Jump over gaps and hazards.', controlsHint: 'Arrows or A/D to move, Space or tap to jump.' },
    mood: 'playful',
  });
}

/** Věc a cíl z věty bez modelu (rychlá verze): sbírací sloveso dá věc, „find / reach / get to“ cíl. */
function sentenceGoal(sentence: string): Pick<Partial<GenreSpecOf<'platformer'>>, 'collectible' | 'target'> {
  const text = sentence.toLowerCase();
  const gathered = COLLECT_CUE.exec(text);
  const reached = GOAL_CUE.exec(text);
  const phrase = (rest: string): string | null => {
    const noun = nounPhrase(rest.replace(/^(?:his|her|their)\s+/, ''), 2);
    return noun === null ? null : singular(noun);
  };
  const item = gathered === null ? null : phrase(gathered[2]!);
  const goal = reached === null ? null : phrase(reached[2]!);
  const verb = gathered !== null && item !== null ? gathered[1]! : reached !== null && goal !== null ? reached[1]!.replace(/^get\w*/, 'get') : null;
  const label = goal ?? item;
  return {
    ...(item === null ? {} : { collectible: item }),
    ...(verb === null || label === null ? {} : { target: { label, verb, states: 2 as const } }),
  };
}

export const platformerGenre: GenreModule<'platformer'> = {
  id: 'platformer',
  modes: ['default'],
  cues: ['jump', 'climb', 'hop', 'leap', 'platform'],
  heroClasses: ['animal', 'bird', 'humanoid', 'robot', 'monster'],
  paramBounds: {
    lengthM: { min: PLATFORM_LEVEL.minLengthM, max: PLATFORM_LEVEL.maxLengthM },
    /** Kolik věcí sebrat (`counts.collectible`); nejvýš tolik, kolik míst na zemi má i nejkratší úroveň. */
    items: { min: 1, max: PLATFORM_LEVEL.maxCollect },
  },
  availability: () => 'ready',
  compile: compilePlatformer,
  draftFill: (sentence, reading) => {
    const roles = draftRoles(sentence, reading);
    const said = sentenceGoal(sentence);
    return { genre: 'platformer', mode: 'default', ...said, ...roles };
  },
};
