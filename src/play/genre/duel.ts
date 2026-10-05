/**
 * Žánr Souboj (P36A T11): hráč a soupeř proti sobě – úhyb, když se soupeř
 * napřahuje, úder v mezeře po jeho útoku. Překládá na dnešní ovládání `duel`
 * (`duel_arena`); scéna `components/play/arcade/duel` ho kreslí beze změny.
 *
 * Jen pro duel, rivala a přestřelku za poledne („cowboy duel at high noon“);
 * rvačky a box (boxing, karate, pillow fight) hraje Aréna `fight`, která má
 * víc soupeřů po scéně. Hloubka: soupeři jdou za sebou (`rounds`), každý
 * útočí o 3 tiky rychleji, 3 životy. Robot vyhraje za 30–40 s, nečinný hráč
 * prohraje na třetím úderu.
 */

import { DUEL } from '../arcade/pieces/duel';
import { plural, singular } from '../draft/lexicon';

import { type GenreModule, draftRoles, legacySpec, livesMechanic, titleCase } from './contract';

/** Soupeřů výchozí a v mezích: 7 soupeřů robot porazí za ~28 s („cowboy duel at high noon“), pod 8 je souboj pod 30 s. */
export const DUEL_GENRE = { rounds: 9, minRounds: 8 } as const;

export const duelGenre: GenreModule<'duel'> = {
  id: 'duel',
  modes: ['default'],
  cues: ['duel', 'rival', 'showdown', 'standoff'],
  heroClasses: ['humanoid', 'animal', 'robot', 'monster'],
  paramBounds: {
    /** Soupeřů za sebou. */
    rounds: { min: DUEL_GENRE.minRounds, max: DUEL.maxRounds },
  },
  availability: () => 'ready',
  compile: (spec) => {
    const { rounds = DUEL_GENRE.rounds } = spec.params ?? {};
    const rival = spec.enemy ?? 'rival';
    const rivals = plural(singular(rival), 2);
    return legacySpec(spec, {
      control: 'duel',
      controlParams: { difficulty: 'normal', rounds },
      archetype: 'hazard_crossing',
      title: `${titleCase(spec.hero)} Duel`,
      objective: { kind: 'reach', description: `Beat ${String(rounds)} ${rivals} in a row. Each one attacks faster.`, role: 'finish' },
      mechanics: [livesMechanic()],
      roles: [
        { id: 'rival', kind: 'hazard', label: rival },
        { id: 'finish', kind: 'exit', label: 'knockout' },
      ],
      tutorial: { goalLine: `Dodge the wind-up, strike in the opening. Beat ${String(rounds)} ${rivals}.`, controlsHint: 'Tap right or Space to strike, tap left or Down to dodge.' },
      mood: 'tense',
    });
  },
  draftFill: (sentence, reading) => ({ genre: 'duel', mode: 'default', ...draftRoles(sentence, reading) }),
};
