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

/**
 * Kroky stavby v pořadí a znění kitu (`07-components.md`, Generation progress);
 * první dva patří `/play`, druhé dva `/play/[id]`.
 */
export const BUILD_STEPS = ['Reading your idea', 'Building the world', 'Setting the rules', 'Painting it in'] as const;

/**
 * Chyby dveří (kit `11-voice-copy.md`, Errors): co se stalo a co dělat.
 * Kit píše u offline dlouhou pomlčku, repo ji zakazuje – tady krátká.
 */
export const BUILD_FAILED = "Couldn't build that. Try fewer rules.";
export const OFFLINE = "You're offline. Your idea is saved – we'll build it when you're back.";
/** Síť hlásí spojení, ale dveře neodpověděly (kit tenhle případ nemá). */
export const NOT_SENT = "Couldn't send your idea. Try again.";

/**
 * AI verze nad hrou (kit `.sp-status` a `.sp-toast`): pilulka, dokud se
 * dopočítává, toast s tlačítkem, když je hotová.
 */
export const QUICK_VERSION = 'Quick version';
export const QUICK_VERSION_REST = ' · the full-detail one is on its way';
export const FULL_READY = 'Full-detail version ready';
export const PLAY_FULL = 'Play it';
/** Přepínač verzí (P38): slovník kitu říká „quick“ a „full-detail“, ne „AI“ (`11-voice-copy.md`). */
export const QUICK_LABEL = 'Quick';
export const FULL_LABEL = 'Full detail';

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

/**
 * Nápověda první návštěvy (P44D T12): pět vět, u kterých měření
 * `evals/play/p37/o8.json` (návrh ze slov, dev sady) naměřilo hratelnou hru,
 * sloveso poznané v klipu a poznaného hrdinu – v pěti různých žánrech. Text je
 * doslova ten měřený, i s malým písmenem na začátku: jiný zápis už měřený není.
 * `set` a `id` drží `__tests__/starters.test.ts` u měření.
 */
export const JUDGE_PICKS: readonly { readonly set: 'p37a' | 'p30dev'; readonly id: string; readonly sentence: string }[] = [
  { set: 'p37a', id: 'f22', sentence: 'A knight fights a three-headed hydra at the castle gates.' },
  { set: 'p30dev', id: 's037', sentence: 'A space marine shoots alien bugs in a mining colony' },
  { set: 'p30dev', id: 'h10', sentence: 'a penguin that slides down a glacier, jumps over seals and catches fish' },
  { set: 'p37a', id: 'm16', sentence: 'a kangaroo jumps over cars then collects coins on the highway' },
  { set: 'p37a', id: 'f08', sentence: 'a unicorn gallops across a rainbow to reach a castle in the clouds' },
];
export const FIRST_VISIT_TITLE = 'New here? Tap one, then Make it!';
export const TRY_YOUR_OWN = 'Try your own';
export const NOT_NOW = 'Not now';

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
 * Měď po dohrání (P34 T6, kit `11-voice-copy.md` a Result screen v
 * `08-game-hud.md`), doslova z `PRODUCT_COPY.md` a ve větném tvaru – karta
 * je bere, jak jsou. „Dare a friend“ je krátký popisek téhož sdílení pro
 * vedlejší M tlačítko po prohře, kam se celá věta nevejde. Čipy jsou opis
 * `REMIX_CHIP_LABELS` ze `src/play/director/remix.ts` – ten modul táhne registr a zod,
 * a do klientského bundlu nepatří; `__tests__/starters.test.ts` drží obě
 * kopie u sebe.
 */
export const CHANGE_ONE_THING = 'Change one thing';
export const YOU_DID_IT = 'You did it!';
export const SO_CLOSE = 'So close.';
/** Překonaný osobní rekord (P36B T2) – na výsledku i v HUD. */
export const NEW_BEST = 'New best!';
export const DARE_A_FRIEND = 'Dare a friend to beat it';
export const DARE_SHORT = 'Dare a friend';
/** Výzva kamaráda (P36B T7): poražený kamarád – a hlavní akce po výhře pošle novou výzvu zpátky. */
export const YOU_BEAT_IT = 'You beat it!';
export const DARE_BACK = 'Dare back';
/** Mezi body výzvy přebitými za běhu (P36B T7) – vyhrát ještě musí, proto ne „You beat it!“. */
export const AHEAD = "You're ahead!";
export const LINK_COPIED = 'Link copied. Go dare someone.';

export const POST_RUN_CHIPS = [
  { chip: 'harder', label: 'Make it harder' },
  { chip: 'twist', label: 'Add a twist' },
  { chip: 'swap_enemy', label: 'Swap the enemy' },
  { chip: 'reskin', label: 'Change the world, keep the rules' },
] as const;

/**
 * List „Change one thing“ (P34 T7, vzor `.sp-sheet` v `guidelines.html`):
 * viditelný popisek pole, příklad v poli a tlačítko odeslání. Příklad kitu
 * „Make the dog slower“ patří jeho ukázkové hře se psem; tady obecný.
 */
export const REMIX_LABEL = 'What should change?';
export const REMIX_PLACEHOLDER = 'Make the enemies slower';
export const REMIX_IT = 'Remix it';

/**
 * List sdílení v HUD (P34 T7, kit `07-components.md` Screens map): Dare
 * a friend, Copy link a Save video. Video vzniká z běhu, takže během hry je
 * Save video zašedlé s větou, kdy bude.
 */
export const SHARE_TITLE = 'Share this game';
export const COPY_LINK = 'Copy link';
export const SAVE_VIDEO = 'Save video';
export const VIDEO_AFTER_RUN = 'Your video is ready when the run ends.';

/**
 * Karta výzvy – náhled odkazu (P34 T7, kit `13-assets.md` Dare card). Slovo
 * pod časem na slunečném odznaku: přežití, závod s časovačem, hra bez
 * měřeného času (pak jen slovo), nebo výsledek kamaráda z odkazu výzvy (P36B T8).
 */
export const CAN_YOU_BEAT_IT = 'Can you beat it?';
export const DARE_BADGE = { survive: 'Survive!', hurry: 'Hurry!', none: 'Your turn!', dare: 'to beat' } as const;
/** Kdo vyzývá (P44B T7): „Ada dares you“ nad výsledkem na kartě i v proužku výzvy. */
export const daresYou = (name: string): string => `${name} dares you`;
