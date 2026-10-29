/**
 * Žánr Krádež (P66 T7): hrdina doběhne k cizí základně, popadne kořist z věty a odnese ji na svou, strážci (nepřítel
 * z věty) ho honí a při dotyku kořist vezmou zpět (ovládání `steal`, generátor `steal_bases` v
 * `arcade/pieces/steal.ts`). Kola „Round N of M“, mezi nimi výběr vylepšení (`speed`, `carry`, `extra_life`,
 * `magnet`), kořist se vzácností; každé kolo přidá strážce, poslední má velkou kořist a silnějšího strážce.
 *
 * Co se krade, je věc obsazení, kterou věta sbírá (`collect`, výchozí drahokam); kdo hlídá, je ten, kdo honí nebo se
 * pere (`chase_me`, `fight`, jinak `avoid`/`shoot_at`; výchozí robot `GENRE_FOE`).
 *
 * Narážky žádné: věty sem vede až klasifikátor P66 T12. Do té doby se žánr otevírá ručním specem (fixture e2e).
 */

import { STEAL } from '../arcade/pieces/steal';
import { plural, singular } from '../draft/lexicon';

import { type CastItem, type GenreModule, castFor, draftRoles, legacySpec, livesMechanic, titleCase } from './contract';

/** Výchozí kořist a strážce, když je věta nejmenuje. */
export const STEAL_DEFAULTS = { loot: 'gem', guard: 'robot' } as const;

/** První text, který se vejde do meze schématu (dlouhé popisky z věty). */
const fit = (max: number, ...lines: readonly string[]): string => lines.find((line) => line.length <= max) ?? (lines.at(-1) as string);

export const stealGenre: GenreModule<'steal'> = {
  id: 'steal',
  modes: ['default'],
  cues: [],
  heroClasses: ['humanoid', 'animal', 'robot', 'monster'],
  // Meze z měření robotem (T7, `evals/play/p66/README.md` → T7): kořist na kolo, kola, strážci prvního kola.
  paramBounds: {
    loot: { min: STEAL.perRound.min, max: STEAL.perRound.max },
    rounds: { min: STEAL.rounds.min, max: STEAL.rounds.max },
    guards: { min: STEAL.guards.min, max: STEAL.guards.max },
  },
  // Hraje (překlad i svět), ale pro výběr zůstává `staged` jako šipky (T9): klasifikátor, návrh i režisér procházejí
  // celé pořadí přes buňku receptu (`PRESETS`, `compose/presets.ts`) a tu přesune do živých až T12.
  availability: () => 'staged',
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
          `Grab ${String(loot)} ${things} from the rival base and carry them home in ${String(rounds)} rounds. Dodge the ${guardsWord}.`,
          `Grab ${String(loot)} ${things} and carry them home in ${String(rounds)} rounds.`,
          `Carry the loot home in ${String(rounds)} rounds.`,
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
