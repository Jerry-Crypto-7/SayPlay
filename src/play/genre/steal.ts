/**
 * Žánr Krádež (P66 T7): hrdina doběhne k cizí základně, popadne kořist z věty a odnese ji na svou, strážci (nepřítel
 * z věty) ho honí a při dotyku kořist vezmou zpět (ovládání `steal`, generátor `steal_bases` v
 * `arcade/pieces/steal.ts`). Kola „Round N of M“, mezi nimi výběr vylepšení (`speed`, `carry`, `extra_life`,
 * `magnet`), kořist se vzácností; každé kolo přidá strážce, poslední má velkou kořist a silnějšího strážce.
 *
 * Co se krade, je věc obsazení, kterou věta sbírá (`collect`, výchozí drahokam); kdo hlídá, je ten, kdo honí nebo se
 * pere (`chase_me`, `fight`, jinak `avoid`/`shoot_at`; výchozí robot `GENRE_FOE`).
 *
 * Věty sem od P66 T12 vede znak žánru v `classify.ts` (kořist nesená domů); e2e hraje z ručního specu.
 */

import { STEAL } from '../arcade/pieces/steal';
import { counted, plural, singular } from '../draft/lexicon';

import { type CastItem, type GenreModule, castFor, draftRoles, legacySpec, livesMechanic, titleCase } from './contract';

/** Výchozí kořist a strážce, když je věta nejmenuje. */
export const STEAL_DEFAULTS = { loot: 'gem', guard: 'robot' } as const;

/** První text, který se vejde do meze schématu (dlouhé popisky z věty). */
const fit = (max: number, ...lines: readonly string[]): string => lines.find((line) => line.length <= max) ?? (lines.at(-1) as string);

export const stealGenre: GenreModule<'steal'> = {
  id: 'steal',
  modes: ['default'],
  // P66 T12: věty sem vede znak žánru v `classify.ts` (kořist nesená domů); narážky přidají bod proti útěku, když
  // věta plíží („sneaks into the rival camp … before the rangers catch him“), a v pořadí dají krádež před ostatní.
  cues: ['sneak', 'heist'],
  heroClasses: ['humanoid', 'animal', 'robot', 'monster'],
  // Meze z měření robotem (T7, `evals/play/p66/README.md` → T7): kořist na kolo, kola, strážci prvního kola.
  paramBounds: {
    loot: { min: STEAL.perRound.min, max: STEAL.perRound.max },
    rounds: { min: STEAL.rounds.min, max: STEAL.rounds.max },
    guards: { min: STEAL.guards.min, max: STEAL.guards.max },
  },
  // P66 T12: živý – buňka `steal.default` je v `PRESETS` a věty sem vede klasifikátor.
  availability: () => 'ready',
  compile: (spec) => {
    const loot = spec.params?.loot ?? STEAL.perRound.default;
    const rounds = spec.params?.rounds ?? STEAL.rounds.default;
    const guards = spec.params?.guards ?? STEAL.guards.default;
    const thing = singular(castFor(spec, 'collect', 'reach')?.label ?? STEAL_DEFAULTS.loot);
    const guard = singular(castFor(spec, 'chase_me', 'fight', 'avoid', 'shoot_at')?.label ?? STEAL_DEFAULTS.guard);
    const tuning = {
      ...(loot === STEAL.perRound.default ? {} : { loot }),
      ...(rounds === STEAL.rounds.default ? {} : { rounds }),
      ...(guards === STEAL.guards.default ? {} : { guards }),
    };
    const things = plural(thing, loot);
    const guardsWord = plural(guard, 2);
    return legacySpec(spec, {
      control: 'steal',
      controlParams: { generator: 'steal_bases', ...(Object.keys(tuning).length === 0 ? {} : { tuning }) },
      archetype: 'delivery',
      title: fit(80, `${titleCase(spec.hero)} Heist`, 'The Heist'),
      objective: {
        kind: 'deliver',
        description: fit(
          120,
          `Grab ${String(loot)} ${things} from the rival base and carry them home in ${counted(rounds, 'round')}. Dodge the ${guardsWord}.`,
          `Grab ${String(loot)} ${things} and carry them home in ${counted(rounds, 'round')}.`,
          `Carry the loot home in ${counted(rounds, 'round')}.`,
        ),
        role: 'loot',
      },
      mechanics: [livesMechanic()],
      roles: [
        { id: 'loot', kind: 'collectible', label: thing, count: loot * rounds },
        { id: 'guard', kind: 'chaser', label: guard, count: guards },
      ],
      tutorial: {
        goalLine: fit(50, `Grab the ${things} and run them home!`, `Grab the ${thing} and run home!`, 'Grab the loot and run home!'),
        controlsHint: `Drag or arrows to move. Dodge the ${fit(30, guardsWord, 'guards')}.`,
      },
      mood: 'tense',
      targetDurationSec: 60,
    });
  },
  draftFill: (sentence, reading) => {
    const { hero, setting, cast } = draftRoles(sentence, reading);
    // Krádež zná dvě role: co se krade (sbírá) a kdo hlídá (honí). Ostatní hrozby věty hlídají taky.
    const roles = (cast ?? []).map((item): CastItem => (item.does === 'collect' ? item : { ...item, does: 'chase_me' }));
    return {
      genre: 'steal',
      mode: 'default',
      ...(hero === undefined ? {} : { hero }),
      ...(setting === undefined ? {} : { setting }),
      ...(roles.length === 0 ? {} : { cast: roles }),
    };
  },
};
