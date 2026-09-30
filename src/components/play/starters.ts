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

/** Nadpis domova; poslední slovo nese zvýraznění kitu (`.sp-highlight`). */
export const HERO = 'What do you want to play?';
export const SUBHEAD = 'Say one sentence and play it in seconds. Then change one thing.';
export const PROMPT_LABEL = 'Say it in one sentence';
export const PLACEHOLDER = "A fox steals eggs while the farmer's dog chases it…";

/** Stavový řádek při stavbě; první dva patří `/play`, druhé dva `/play/[id]`. */
export const BUILD_STEPS = ['Designing the challenge', 'Building a playable version', 'Checking the rules', 'Adding the look'] as const;

/** Strop věty z kitu (`07-components.md`, Prompt); dveře serveru snesou víc. */
export const SENTENCE_LIMIT = 140;
/** Od kolika znaků je počítadlo rajčatové. */
export const COUNTER_WARN = 130;
/** „Make it!“ s prázdným polem (kit `11-voice-copy.md`, Errors: Too vague). */
export const TOO_VAGUE = 'Add who you are and what you\'re doing, like "a cat stealing fish".';

/**
 * Karty nápadů na domově (kit `.sp-idea`): krátká věta, klepnutí ji vloží do
 * pole. Archetyp je ten, na který věta přistane v návrhu ze slov – slib karty.
 */
export const IDEA_LIMIT = 45;
export const IDEAS: readonly { readonly archetype: ArchetypeId; readonly sentence: string }[] = [
  { archetype: 'chase_escape', sentence: 'Hamster escapes a supermarket Roomba' },
  { archetype: 'collect_exit', sentence: 'Grab five glowing mushrooms' },
  { archetype: 'delivery', sentence: 'Carry a wobbly cake to the party' },
  { archetype: 'survival_timer', sentence: 'The floor is lava, for 60 seconds' },
];

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
 * `REMIX_CHIP_LABELS` ze `src/play/director/remix.ts` – ten modul táhne registr a zod,
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
