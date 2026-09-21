/**
 * Měď stránky `/play` a osm startovních karet.
 *
 * Texty jsou doslova z `docs/play/pack/PRODUCT_COPY.md` a věty karet ze
 * `golden_prompts.csv` – natvrdo, protože klient balíček z disku nečte;
 * `__tests__/starters.test.ts` drží obě kopie u sebe. Strop věty je týž jako
 * u dveří (`MAX_SENTENCE_CHARS` v `_publish.ts`), ale tenhle modul ho nesmí
 * importovat: šel by do klientského bundlu i s úložištěm a zodem.
 */

import type { ArchetypeId } from '@/play/registry';

export const HERO = 'Imagine a game. Play it.';
export const SUBHEAD = 'Describe anything. WORLDSTREAM turns it into a short playable 3D game — then change the rules with a sentence.';
export const PLACEHOLDER = 'A hamster escaping a supermarket while a giant Roomba hunts me…';

/** Stavový řádek při stavbě; první dva patří `/play`, druhé dva `/play/[id]`. */
export const BUILD_STEPS = ['Designing the challenge', 'Building a playable version', 'Checking the rules', 'Adding the look'] as const;

export const SENTENCE_LIMIT = 500;

export interface Starter {
  readonly archetype: ArchetypeId;
  readonly label: string;
  readonly sentence: string;
}

export const STARTERS: readonly Starter[] = [
  { archetype: 'chase_escape', label: 'Chase', sentence: 'A hamster escapes a supermarket while a giant Roomba hunts it.' },
  { archetype: 'collect_exit', label: 'Collect', sentence: 'Collect five glowing mushrooms then open a portal.' },
  { archetype: 'survival_timer', label: 'Survive', sentence: 'Survive 60 seconds while red floor tiles pulse dangerously.' },
  { archetype: 'checkpoint_race', label: 'Race', sentence: 'Race through five neon gates in order.' },
  { archetype: 'delivery', label: 'Deliver', sentence: 'Carry a fragile cake across a kitchen to a party table.' },
  { archetype: 'switch_puzzle', label: 'Puzzle', sentence: 'Press red and blue but not green to open the door.' },
  { archetype: 'hazard_crossing', label: 'Cross', sentence: 'Cross floating islands; falling restarts at the last checkpoint.' },
  { archetype: 'combat_lite', label: 'Fight', sentence: 'Defeat five slime targets with energy balls.' },
];

/**
 * Měď po dohrání (T6), doslova z `PRODUCT_COPY.md`. Čipy jsou opis
 * `CHIP_LABELS` z `src/play/remix/chips.ts` – ten modul táhne registr a zod,
 * a do klientského bundlu nepatří; `__tests__/starters.test.ts` drží obě
 * kopie u sebe.
 */
export const CHANGE_ONE_THING = 'CHANGE ONE THING';
export const CHALLENGE_A_FRIEND = 'CHALLENGE A FRIEND';

export const POST_RUN_CHIPS = [
  { chip: 'harder', label: 'Make it harder' },
  { chip: 'twist', label: 'Add a twist' },
  { chip: 'swap_enemy', label: 'Swap the enemy' },
  { chip: 'reskin', label: 'Change the world, keep the rules' },
] as const;
