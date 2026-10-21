/**
 * `GameSpec v1` – **záměr hry**, vrstva nad `WorldDoc` (P23).
 *
 * `WorldDoc` odpovídá na otázku *jak přesně tahle instance běží* (entity,
 * sokety, pravidla, svědek). `GameSpec` odpovídá na otázku *co je to za hru*:
 * archetyp, cíl, mechaniky z uzavřeného registru, role, ověřovací tvrzení a
 * rozpočty. Model od P23 píše **jen tohle** – deterministický kompilátor
 * (`src/play/compile`, plán P23-A) z něj postaví `WorldstreamBlueprint`.
 *
 * ## Proč uzavřená gramatika
 *
 * Runtime je mřížkový a deterministický (`src/sim`), hráč se hýbe příkazem
 * `moveTo` na soket, sbírá `pickup`, používá `use`. Mechaniky tady jsou proto
 * jen ty, které se na tenhle runtime **snižují beze změny jeho tvaru** –
 * projektil, skok ani pohyblivá plošina v registru nejsou a `readGameSpec`
 * neznámou mechaniku odmítá (fail closed), místo aby ji tiše zahodila.
 *
 * ## Co drží schéma a co registr
 *
 * Schéma soudí tvar jednoho pole. Registr (`./registry`) soudí celek: zda
 * mechanika patří k archetypu, zda její parametry projdou vlastním schématem,
 * zda role, na které mechaniky odkazují, existují, a zda součet nákladů
 * mechanik nepřekročí rozpočty. `readGameSpec` dělá obojí v jednom kroku.
 */

import { z } from 'zod';
import { phasesSchema, dependsOnSchema } from './compose/progression';
import { assemblyPartsSchema } from './compose/parts';

import { ID_PATTERN } from '@/ir/types';
import { canonicalHash } from '@/ir/worlddoc';

import { ABILITIES, type AbilityId, ADDONS, type AddonId } from './arcade/contract';
import { LOOK_IDS, TIMES_OF_DAY, WEATHERS } from './arcade/look';
import { logicSchema, ruleIssues, rulesSchema, thingsSchema } from './arcade/rules/schema';
import { CAPABILITIES } from './capabilities';
import { ABILITY_WORDS, ALL_ABILITY_WORDS } from './draft/controls';
import { ALL_GENRE_MODES, GENRES, GENRE_MODES, isGenreMode } from './genre/contract';
import { heroActionSchema } from './hero-action';

import { ARENA_DENSITIES, ARENA_GOALS } from './arcade/pieces/arena';
import { SEGMENT_NEWS } from './arcade/pieces/pacing';
import { FLAP_DIFFICULTIES, FLAP_TRACK } from './arcade/pieces/flap';
import { PLATFORM_DIFFICULTIES, PLATFORM_LEVEL } from './arcade/pieces/platform';
import { OBSTACLE_KINDS, RUNNER_DENSITIES, RUNNER_SPEEDS, RUNNER_TRACK } from './arcade/pieces/runner';
import { DUEL, DUEL_DIFFICULTIES } from './arcade/pieces/duel';
import { RHYTHM, RHYTHM_DENSITIES } from './arcade/pieces/rhythm';
import { SHOOTER_DIFFICULTIES, SHOOTER_RISE_MAX, SHOOTER_WAVE_SIZE_MAX } from './arcade/pieces/shooter';
import { STEER_DIFFICULTIES, STEER_STYLES, STEER_TRACK } from './arcade/pieces/steer';
import { THROW_DIFFICULTIES, THROW_GOALS } from './arcade/pieces/throw';
import { TIMING, TIMING_MODES, TIMING_SPEEDS } from './arcade/pieces/timing';
import { ARCHETYPES, MECHANICS, type ArchetypeId, type MechanicEntry, type MechanicId, estimateCost } from './registry';

export const GAME_SPEC_SCHEMA = 'gamespec.v1' as const;

/** Ohraničený identifikátor – tentýž vzor, jaký mají entity a sloty v IR. */
export const gameId = z.string().regex(ID_PATTERN, 'identifier: letter, then letters/digits/_/. (max 64)');
const text = z.string().min(1).max(200);

/** Kde popisek přestává být jménem a začíná pokyn („Battery; first beside spawn…“, audit P26 bod 8). */
const LABEL_BREAK = /[;:,(]| [-–] | (?:that|which|who|while|when|with|first|then|along|beside|near)\b/i;

/**
 * Popisek role je 1–3 slova (P26 T7): hráč ho čte na kartě a model hrdiny se
 * vybírá z posledního slova. Za prvním zlomem se řeže, pak zůstanou poslední
 * tři slova – v angličtině nese podstatné jméno konec („big red angry dragon“).
 */
export function roleLabel(raw: string): string {
  const head = raw.split(LABEL_BREAK)[0].trim();
  return (head === '' ? raw.trim() : head).split(/\s+/).slice(-3).join(' ');
}

/**
 * Druhy rolí. Role je **sémantická**: kompilátor z ní odvodí entitu, soket,
 * zónu a vizuální vazbu; hráč ji uvidí pod `label`. Právě jedna role je `player`.
 */
export const ROLE_KINDS = [
  'player',
  'exit',
  'collectible',
  'key',
  'door',
  'switch',
  'hazard',
  'chaser',
  'patrol',
  'item',
  'destination',
  'checkpoint',
  'target',
  'prop',
  'zone',
] as const;
export type RoleKind = (typeof ROLE_KINDS)[number];

/** Výchozí stav entity podle druhu role; adaptéry stavy přepínají `setState`. */
export const ROLE_INITIAL_STATE: Readonly<Record<RoleKind, string>> = {
  player: 'idle',
  exit: 'open',
  collectible: 'present',
  key: 'present',
  door: 'closed',
  switch: 'off',
  hazard: 'on',
  chaser: 'hunting',
  patrol: 'walking',
  item: 'present',
  destination: 'waiting',
  checkpoint: 'pending',
  target: 'alive',
  prop: 'idle',
  zone: 'idle',
};

export const OBJECTIVE_KINDS = ['reach', 'collect', 'survive', 'checkpoints', 'deliver', 'puzzle', 'defeat_targets'] as const;
export type ObjectiveKind = (typeof OBJECTIVE_KINDS)[number];

export const VERIFICATION_KINDS = ['reachability', 'keypoint', 'termination', 'count', 'relation', 'replay'] as const;
export type VerificationKind = (typeof VERIFICATION_KINDS)[number];

export const roleSchema = z
  .object({
    id: gameId,
    kind: z.enum(ROLE_KINDS),
    /** Anglické podstatné jméno pro vizuál a titulky (`"Roomba"`, `"glowing mushroom"`). */
    label: text.max(60),
    count: z.int().min(1).max(50).default(1),
  })
  .strict();
export type GameRole = z.infer<typeof roleSchema>;

export const mechanicSchema = z
  .object({
    id: z.enum(Object.keys(MECHANICS) as [MechanicId, ...MechanicId[]]),
    /** Parametry soudí schéma mechaniky v registru, ne tohle pole. */
    params: z.record(z.string(), z.unknown()),
  })
  .strict();
export type GameMechanic = z.infer<typeof mechanicSchema>;

export const objectiveSchema = z
  .object({
    kind: z.enum(OBJECTIVE_KINDS),
    /** Jedna anglická věta pro hráče: co má udělat. */
    description: text.max(120),
    count: z.int().min(1).max(50).optional(),
    seconds: z.int().min(5).max(180).optional(),
    /** Role cíle (`exit`, `destination`) nebo sbíraná role. */
    role: gameId.optional(),
  })
  .strict();
export type GameObjective = z.infer<typeof objectiveSchema>;

/** Jedna herní akce ve stopě – stejný slovník jako svědek (`moveTo`, `pickup`, `use`). */
export const playActionSchema = z
  .object({ actionId: z.enum(['moveTo', 'pickup', 'use']), target: gameId })
  .strict();

/**
 * Tvrzení o stavu po krocích. Klíče jsou ID rolí nebo slotů z `GameSpec`,
 * ne entity z `WorldDoc` – kompilátor je přeloží; kdo píše spec, nezná
 * pojmenování entit.
 */
export const stateAssertSchema = z
  .object({
    runState: z.enum(['running', 'won', 'lost']).optional(),
    counters: z.record(gameId, z.int()).optional(),
    flags: z.record(gameId, z.boolean()).optional(),
    entityStates: z.record(gameId, z.string().max(32)).optional(),
    locked: z.record(gameId, z.boolean()).optional(),
    /** Mechaniky, jejichž pravidlo během kroků vystřelilo právě jednou. */
    firedMechanics: z.array(gameId).max(8).optional(),
    replayEqual: z.literal(true).optional(),
  })
  .strict();

/** Vstřik stavu před keypointem – jen deklarované sloty a legální umístění. */
export const stateSetupSchema = z
  .object({
    counters: z.record(gameId, z.int()).optional(),
    flags: z.record(gameId, z.boolean()).optional(),
    entityStates: z.record(gameId, z.string().max(32)).optional(),
    locked: z.record(gameId, z.boolean()).optional(),
    /** Role → role, u které má stát (kompilátor přeloží na soket). */
    placeAt: z.record(gameId, gameId).optional(),
  })
  .strict();

export const verificationSchema = z
  .object({
    id: gameId,
    kind: z.enum(VERIFICATION_KINDS),
    /** Mechanika, kterou tvrzení dokazuje; `keypoint` ji musí mít. */
    mechanic: gameId.optional(),
    setup: stateSetupSchema.optional(),
    actions: z.array(playActionSchema).max(32).optional(),
    /** Kolik tiků nechat po akcích doběhnout (výchozí volí verifikátor). */
    ticks: z.int().min(0).max(3600).optional(),
    assert: stateAssertSchema,
  })
  .strict();
export type VerificationAssertion = z.infer<typeof verificationSchema>;

export const budgetsSchema = z
  .object({
    maxEntities: z.int().min(2).max(64),
    maxRules: z.int().min(1).max(200),
    maxTriangles: z.int().min(1000).max(1_000_000),
  })
  .strict();
export type GameBudgets = z.infer<typeof budgetsSchema>;

/** Jak se hrdina hýbe, když to není během (`theme.motion`): `ride` = jízda v předklonu. */
export const THEME_MOTIONS = ['ride'] as const;
export type ThemeMotion = (typeof THEME_MOTIONS)[number];

export const themeSchema = z
  .object({
    /** Kde se to děje – vstup pro výběr assetů a palety (`"supermarket at night"`). */
    setting: text.max(80),
    mood: text.max(40),
    /** Sada prostředí arkády, která `setting` nejlíp ukáže (P26 T11); bez ní se hádá ze slov. */
    look: z.enum(LOOK_IDS).optional(),
  })
  .strict();

/**
 * `theme` uložené verze: navíc počasí a denní doba ze živých změn sdílené hry
 * (P29D T10); bez nich jasno ve dne. Model je nepíše – jeho tvar
 * (`director/prompt.ts`, `answer-schema.ts`) zůstává u `themeSchema`.
 */
export const storedThemeSchema = themeSchema
  .extend({
    weather: z.enum(WEATHERS).optional(),
    timeOfDay: z.enum(TIMES_OF_DAY).optional(),
    /**
     * P32A T5-R1: hrdina věty nejede během, ale jízdou (klouže, lyžuje, surfuje) – scéna
     * ho kreslí v předklonu. Píše modul žánru běžce (`genre/runner.ts`), model ne; stará hra
     * pole nemá a běží jako dřív. Jen vzhled, jádro ho nečte.
     */
    motion: z.enum(THEME_MOTIONS).optional(),
  })
  .strict();

/** Co hrdina viditelně dělá (P37-0) – seznam žije v `hero-action.ts` (P37A T3), tady se jen vystavuje. */
export { HERO_ACTIONS, type HeroAction, heroActionSchema } from './hero-action';

export const tutorialSchema = z
  .object({
    /** Do 80 znaků, anglicky, zobrazí se před první akcí. */
    goalLine: text.max(80),
    controlsHint: text.max(80),
  })
  .strict();

/**
 * Ovládání (P25A, P25C, P25F, P25G). `tap_go` = dnešní mřížka (`src/sim`), `runner`,
 * `platform`, `flap`, `steer`, `move_free`, `shooter` a `throw` = arkádové jádro
 * (`src/play/arcade`). Pole je volitelné
 * a **bez výchozí hodnoty**: default by ho vepsal do každého přečteného specu
 * a pohnul `specHash` všech dnešních her.
 */
export const CONTROLS = ['tap_go', 'runner', 'platform', 'flap', 'steer', 'move_free', 'shooter', 'throw', 'timing', 'rhythm', 'duel', 'glide', 'walker', 'ball', 'lanes', 'hop', 'crowd', 'merge', 'push'] as const;
export type ControlId = (typeof CONTROLS)[number];

/**
 * Ovládání nových žánrů P54C (T4), která ještě nehrají. Čtení modelem (`read/`) je nenabízí, aby se jeho
 * dotaz nezměnil dřív, než je některá živá buňka hraje. `lanes` hraje od T5 chytání, ale v seznamu zůstává:
 * věty k novým žánrům posílá až klasifikátor (T13), který ho odsud vyjme spolu se čtením modelem.
 */
export const STAGED_CONTROLS: readonly ControlId[] = ['lanes', 'hop', 'crowd', 'merge', 'push'];

/** Ovládání, mezi kterými volí čtení modelem: všechna kromě `STAGED_CONTROLS`, v pořadí `CONTROLS`. */
export const READ_CONTROLS = CONTROLS.filter((id) => !STAGED_CONTROLS.includes(id)) as unknown as readonly [ControlId, ...ControlId[]];

/**
 * Doplňky arkády (P26D), seznam v `arcade/contract.ts`. Pole ve specu je
 * volitelné **bez výchozí hodnoty**, jako `control`.
 */
export { ABILITIES, type AbilityId, ADDONS, type AddonId };

/** Parametry běžce; co chybí, doplní generátor tratě svým výchozím. */
export const runnerParamsSchema = z
  .object({
    speed: z.enum(RUNNER_SPEEDS).optional(),
    density: z.enum(RUNNER_DENSITIES).optional(),
    fullRowPct: z.int().min(0).max(100).optional(),
    lengthM: z.int().min(RUNNER_TRACK.minLengthM).max(RUNNER_TRACK.maxLengthM).optional(),
    obstacles: z.array(z.enum(OBSTACLE_KINDS)).min(1).max(OBSTACLE_KINDS.length).optional(),
    /**
     * Odpuštění skoku jako skákačka (P36A T6); žánr Běžec ho píše vždy. Bez výchozí
     * hodnoty: uložený spec bez něj má stejný hash i svět jako dřív. Ne přes `tuning` –
     * ten hru označí za delegovanou a čipy remixu běžce by ztichly (`director/remix.ts`).
     */
    feel: z.literal(2).optional(),
    /** Trať ze tří úseků s délkou podle obsahu (P36A T4); žánr Běžec ho píše vždy. Bez výchozí hodnoty – uložený spec bez něj staví tentýž svět. */
    sections: z.literal(3).optional(),
    /** Úseky z knihovny vzorů (P46D T2); žánr Běžec ho píše vždy. Bez výchozí hodnoty – uložený spec bez něj staví tentýž svět. */
    patterns: z.literal(1).optional(),
  })
  .strict();
export type RunnerParams = z.infer<typeof runnerParamsSchema>;

/** Parametry plošinovky; výchozí doplní generátor úrovně. */
export const platformParamsSchema = z
  .object({
    difficulty: z.enum(PLATFORM_DIFFICULTIES).optional(),
    lengthM: z.int().min(PLATFORM_LEVEL.minLengthM).max(PLATFORM_LEVEL.maxLengthM).optional(),
    movingPlatforms: z.boolean().optional(),
    checkpoints: z.boolean().optional(),
    coins: z.boolean().optional(),
    doubleJump: z.boolean().optional(),
  })
  .strict();
export type PlatformParams = z.infer<typeof platformParamsSchema>;

/** Parametry poletování; výchozí doplní generátor trati. */
export const flapParamsSchema = z
  .object({
    difficulty: z.enum(FLAP_DIFFICULTIES).optional(),
    lengthM: z.int().min(FLAP_TRACK.minLengthM).max(FLAP_TRACK.maxLengthM).optional(),
    coins: z.boolean().optional(),
    collectAll: z.boolean().optional(),
    /** Mezery se po třetinách zužují, náraz bere život s milostí – žánr Poletování (P36A T11); uložená hra bez něj jako dřív. */
    rise: z.boolean().optional(),
    /** Odpuštění pozdního vzletu ze země (P37A T7); žánr Poletování ho píše vždy. Bez výchozí hodnoty – uložený spec staví tentýž svět. */
    feel: z.literal(2).optional(),
  })
  .strict();
export type FlapParams = z.infer<typeof flapParamsSchema>;

/** Parametry střelby (P25G); výchozí doplní generátor střelnice podle obtížnosti. */
export const shooterParamsSchema = z
  .object({
    targetWidthPct: z.int().min(25).max(100).optional(),
    difficulty: z.enum(SHOOTER_DIFFICULTIES).optional(),
    magazine: z.int().min(2).max(30).optional(),
    reloadS: z.number().min(0.5).max(4).optional(),
    moving: z.boolean().optional(),
    waves: z.int().min(1).max(6).optional(),
    /** Nepřátel ve vlně a zrychlení za vlnu – žánr Střílečka (P36A T10); uložená hra bez nich jako dřív. */
    waveSize: z.int().min(1).max(SHOOTER_WAVE_SIZE_MAX).optional(),
    rise: z.int().min(1).max(SHOOTER_RISE_MAX).optional(),
  })
  .strict();
export type ShooterSpecParams = z.infer<typeof shooterParamsSchema>;

/** Parametry hodu (P25G); výchozí doplní generátor hřiště. */
export const throwParamsSchema = z
  .object({
    paceBudgetPct: z.int().min(50).max(100).optional(),
    difficulty: z.enum(THROW_DIFFICULTIES).optional(),
    goal: z.enum(THROW_GOALS).optional(),
    bounce: z.boolean().optional(),
    spareThrows: z.int().min(0).max(10).optional(),
    /** Rozpočet robota na celou hru v sekundách – pole naplánuje kola, která se do něj vejdou (P36A F5); bez něj jedno pole. */
    budget: z.int().min(1).max(90).optional(),
  })
  .strict();
export type ThrowSpecParams = z.infer<typeof throwParamsSchema>;

/** Parametry závodu (P25F); výchozí doplní generátor trati. */
export const steerParamsSchema = z
  .object({
    difficulty: z.enum(STEER_DIFFICULTIES).optional(),
    lengthM: z.int().min(STEER_TRACK.minLengthM).max(STEER_TRACK.maxLengthM).optional(),
    rivals: z.boolean().optional(),
    roadWidth: z.int().min(3600).max(10000).optional(),
    roadEntryWidth: z.int().min(3600).max(10000).optional(),
    crashBudget: z.int().min(1).max(9).optional(),
    delivery: z.boolean().optional(),
    centerCollectibles: z.boolean().optional(),
    turbo: z.boolean().optional(),
    drift: z.boolean().optional(),
    grip: z.int().min(4).max(20).optional(),
    brakeDrift: z.int().min(4).max(20).optional(),
    /** Nová hra s úseky a bossem (P46B T5, `steerTrack`); uložený spec bez pole hraje jako dřív. */
    segments: z.literal(true).optional(),
    /** Okruh ze vzorů (P46D T4); návrh závodu ho píše vždy. Bez výchozí hodnoty – uložený spec bez něj staví tentýž svět. */
    patterns: z.literal(1).optional(),
    /** Styl okruhu ze vzorů podle prostředí (P46D R2); bez něj ho vybere semínko. */
    style: z.enum(STEER_STYLES).optional(),
  })
  .strict();
export type SteerParams = z.infer<typeof steerParamsSchema>;

/** Parametry arény (P25F); výchozí doplní generátor arény. */
export const arenaParamsSchema = z
  .object({
    density: z.enum(ARENA_DENSITIES).optional(),
    goal: z.enum(ARENA_GOALS).optional(),
    seconds: z.int().min(20).max(80).optional(),
  })
  .strict();
export type ArenaSpecParams = z.infer<typeof arenaParamsSchema>;

/** Parametry načasování (P25H); tolerance nejméně `minSpecTolerance` – širší než dráha za tik i u `fast`. */
export const timingParamsSchema = z
  .object({
    mode: z.enum(TIMING_MODES).optional(),
    speed: z.enum(TIMING_SPEEDS).optional(),
    tolerance: z.int().min(TIMING.minSpecTolerance).max(TIMING.maxTolerance).optional(),
    rounds: z.int().min(TIMING.minRounds).max(TIMING.maxRounds).optional(),
    /** Každé kolo rychlejší – žánr Načasování (P36A T11); uložená hra bez něj jako dřív. */
    rise: z.boolean().optional(),
    /** Odpuštění brzkého a pozdního ťuku (P37A T7); žánr Načasování ho píše vždy. Bez výchozí hodnoty – uložený spec staví tentýž svět. */
    feel: z.literal(2).optional(),
  })
  .strict();
export type TimingParams = z.infer<typeof timingParamsSchema>;

/** Parametry rytmu (P25H): tempo, hustota not a délka písničky v dobách. */
export const rhythmParamsSchema = z
  .object({
    bpm: z.int().min(RHYTHM.minBpm).max(RHYTHM.maxBpm).optional(),
    density: z.enum(RHYTHM_DENSITIES).optional(),
    beats: z.int().min(RHYTHM.minBeats).max(RHYTHM.maxBeats).optional(),
    /** Písnička houstne po třetinách a ťuk míří do dráhy – žánr Rytmus (P36A T11); uložená hra bez nich jako dřív. */
    ramp: z.boolean().optional(),
    lanes: z.boolean().optional(),
    /** Odpuštění brzkého a pozdního ťuku (P37A T7); žánr Rytmus ho píše vždy. Bez výchozí hodnoty – uložený spec staví tentýž svět. */
    feel: z.literal(2).optional(),
  })
  .strict();
export type RhythmParams = z.infer<typeof rhythmParamsSchema>;

/** Parametry souboje (P25H): obtížnost určí vzorec soupeře a jeho životy; `rounds` soupeřů za sebou, každý rychlejší (žánr Souboj, P36A T11). */
export const duelParamsSchema = z.object({ roundRise: z.int().min(1).max(3).optional(), difficulty: z.enum(DUEL_DIFFICULTIES).optional(), rounds: z.int().min(1).max(DUEL.maxRounds).optional() }).strict();
export type DuelParams = z.infer<typeof duelParamsSchema>;

// Stored parameters have no defaults: old saved specs keep their exact hash.
export const glideSpecParamsSchema = z.object({
  clearancePermille: z.int().min(250).max(1000).optional(),
  clearanceRisePermille: z.int().min(0).max(250).optional(),
  mode: z.enum(['reach', 'collect', 'race', 'escape']).optional(),
  difficulty: z.enum(['easy', 'normal', 'hard']).optional(),
  lengthM: z.int().min(80).max(400).optional(),
  topSpeed: z.int().min(120).max(240).optional(),
  /** Nová hra s průběhem a tunelem finále (P51 T3, `GLIDE_FINALE`); uložený spec bez pole hraje jako dřív. */
  segments: z.literal(true).optional(),
}).strict();
export const walkerSpecParamsSchema = z.object({
  paceBudgetPct: z.int().min(100).max(180).optional(),
  corridorRisePermille: z.int().min(0).max(200).optional(),
  size: z.int().min(7).max(15).refine(value => value % 2 === 1, 'Maze size must be odd').optional(),
  speed: z.int().min(80).max(160).optional(),
  collect: z.boolean().optional(),
  /** Nová hra s průběhem a stezkou finále (P51 T3, `WALKER_FINALE`); uložený spec bez pole hraje jako dřív. */
  segments: z.literal(true).optional(),
}).strict();
export const ballSpecParamsSchema = z.object({
  team: z.boolean().optional(),
  goal: z.enum(['goal', 'hoop', 'hole']).optional(),
  knockdown: z.boolean().optional(),
  shotRecoveryTicks: z.int().min(120).max(240).optional(),
  shotRecoveryRiseTicks: z.int().min(0).max(12).optional(),
  paceSeconds: z.int().min(10).max(90).optional(),
  keeper: z.boolean().optional(),
  difficulty: z.enum(['easy', 'normal', 'hard']).optional(),
  targets: z.int().min(1).max(5).optional(),
  /** Nová hra s průběhem a soupeřem-bossem finále (P51 T4, `BALL_FINALE`); uložený spec bez pole hraje jako dřív. */
  segments: z.literal(true).optional(),
}).strict();

/** Která ovládání berou parametry a jakým schématem; `readGameSpec` je přiřadí podle `control`. */
export const CONTROL_PARAMS = {
  glide: glideSpecParamsSchema,
  walker: walkerSpecParamsSchema,
  ball: ballSpecParamsSchema,
  runner: runnerParamsSchema,
  platform: platformParamsSchema,
  flap: flapParamsSchema,
  steer: steerParamsSchema,
  move_free: arenaParamsSchema,
  shooter: shooterParamsSchema,
  throw: throwParamsSchema,
  timing: timingParamsSchema,
  rhythm: rhythmParamsSchema,
  duel: duelParamsSchema,
  // P54C T4: ovládání nových žánrů zatím bez vlastních parametrů – generátor žánru a jeho ladění nese `DELEGATION`.
  lanes: z.object({}).strict(),
  hop: z.object({}).strict(),
  crowd: z.object({}).strict(),
  merge: z.object({}).strict(),
  push: z.object({}).strict(),
} as const;

/**
 * Delegovaný výběr generátoru (P32-0 T4): překlad žánru smí k parametrům
 * ovládání přidat `generator` (id z `MODE_GENERATORS`) a `tuning` (parametry
 * režimu). `tuning` validuje zod schéma toho generátoru v `arcade/compile.ts`,
 * ne tady; klíč, který soudí `CONTROL_PARAMS`, ale nést nesmí. Bez výchozích hodnot: spec bez nich má stejný hash jako dřív.
 * Režisér je nepíše – `CONTROL_PARAMS` (jeho zadání) je nemá.
 */
const DELEGATION = {
  generator: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/, 'generator: a registered generator id').optional(),
  tuning: z.record(z.string().regex(/^[a-zA-Z][a-zA-Z0-9]{0,31}$/), z.union([z.number(), z.boolean(), z.string().max(40)])).optional(),
};
const delegated = <S extends z.ZodObject>(schema: S) => schema.extend(DELEGATION);
const SPEC_CONTROL_PARAMS = {
  glide: delegated(glideSpecParamsSchema),
  walker: delegated(walkerSpecParamsSchema),
  ball: delegated(ballSpecParamsSchema),
  runner: delegated(runnerParamsSchema),
  platform: delegated(platformParamsSchema),
  flap: delegated(flapParamsSchema),
  steer: delegated(steerParamsSchema),
  move_free: delegated(arenaParamsSchema),
  shooter: delegated(shooterParamsSchema),
  throw: delegated(throwParamsSchema),
  timing: delegated(timingParamsSchema),
  rhythm: delegated(rhythmParamsSchema),
  duel: delegated(duelParamsSchema),
  lanes: delegated(CONTROL_PARAMS.lanes),
  hop: delegated(CONTROL_PARAMS.hop),
  crowd: delegated(CONTROL_PARAMS.crowd),
  merge: delegated(CONTROL_PARAMS.merge),
  push: delegated(CONTROL_PARAMS.push),
} as const;

export const gameSpecSchema = z
  .object({
    schema: z.literal(GAME_SPEC_SCHEMA),
    phases: phasesSchema.optional(),
    assemblyParts: assemblyPartsSchema.optional(),
    dependsOn: dependsOnSchema.optional(),
    control: z.enum(CONTROLS).optional(),
    controlParams: z
      .union([
        SPEC_CONTROL_PARAMS.glide,
        SPEC_CONTROL_PARAMS.walker,
        SPEC_CONTROL_PARAMS.ball,
        SPEC_CONTROL_PARAMS.runner,
        SPEC_CONTROL_PARAMS.platform,
        SPEC_CONTROL_PARAMS.flap,
        SPEC_CONTROL_PARAMS.steer,
        SPEC_CONTROL_PARAMS.move_free,
        SPEC_CONTROL_PARAMS.shooter,
        SPEC_CONTROL_PARAMS.throw,
        SPEC_CONTROL_PARAMS.timing,
        SPEC_CONTROL_PARAMS.rhythm,
        SPEC_CONTROL_PARAMS.duel,
        SPEC_CONTROL_PARAMS.lanes,
        SPEC_CONTROL_PARAMS.hop,
        SPEC_CONTROL_PARAMS.crowd,
        SPEC_CONTROL_PARAMS.merge,
        SPEC_CONTROL_PARAMS.push,
      ])
      .optional(),
    addons: z.array(z.enum(ADDONS)).max(3).optional(),
    /** Akce hrdiny na dvou tlačítkách (P46A). Bez výchozí hodnoty: spec bez nich má stejný hash jako dřív. */
    abilities: z.array(z.enum(ABILITIES)).max(2).optional(),
    /**
     * Sloveso věty na tlačítkách akcí (P47B T10): slovo pro každou akci v pořadí `abilities`, každé ze seznamu
     * `ABILITY_WORDS` své akce. Jen popisek – svět ho nečte; bez výchozí hodnoty, jako `abilities`.
     */
    abilityWords: z.array(z.enum(ALL_ABILITY_WORDS)).max(2).optional(),
    /**
     * Boss finále od režiséra (P46E T4): `name` ukáže banner, `role` = popisek věci obsazení, jejíž model boss
     * dostane. Chování a útok zůstávají žánru (`pacingParts`). Bez výchozí hodnoty: hash rychlé verze se nemění.
     */
    boss: z.object({ name: text.max(40), role: text.max(40) }).strict().optional(),
    /** Scénář úseků od režiséra (P46E T4, `segmentScriptOf`): změna úseku 2, pak úseku 3 slovy `SEGMENT_NEWS`. */
    segments: z.array(z.enum(SEGMENT_NEWS)).min(1).max(3).optional(),
    /**
     * Žánr, ze kterého spec vznikl (P32, `genre/contract.ts`). Bez výchozí
     * hodnoty, jako `control`: spec bez něj má stejný `gameSpecHash` jako dřív.
     * Režim musí patřit žánru – soudí `readGameSpec`.
     */
    genre: z
      .object({ id: z.enum(GENRES), mode: z.enum(ALL_GENRE_MODES), compilerVersion: z.string().min(1).max(32) })
      .strict()
      .optional(),
    title: text.max(80),
    archetype: z.enum(Object.keys(ARCHETYPES) as [ArchetypeId, ...ArchetypeId[]]),
    targetDurationSec: z.int().min(30).max(180),
    theme: storedThemeSchema,
    objective: objectiveSchema,
    /** Právě jedna nesmí chybět; nad pěti se hra přestává vysvětlit jednou větou. */
    // Arkáda (P26 T5) smí být bez mechanik; mřížce aspoň jednu vynutí povinné mechaniky archetypu.
    mechanics: z.array(mechanicSchema).max(5),
    roles: z.array(roleSchema).min(2).max(30),
    tutorial: tutorialSchema,
    verification: z.array(verificationSchema).min(1).max(20),
    budgets: budgetsSchema,
    /**
     * Pravidla pro slovesa, která žádný dílek neumí (P29A, jazyk v
     * `arcade/rules/schema.ts`). Jen arkáda; bez výchozí hodnoty, jako `control`.
     */
    rules: rulesSchema.optional(),
    /** Doplňky rolí pro pravidla (skryté na startu). */
    things: thingsSchema.optional(),
    /**
     * Stav hry pro pravidla (P45B): proměnné, časovače, fáze a události – jen spolu
     * s pravidly, která ho čtou a mění. Bez výchozí hodnoty: uložený spec bez pole
     * staví tentýž svět.
     */
    logic: logicSchema.optional(),
    /**
     * Skóre, které rozhoduje (P36A T5, `arcade/compile.ts` `withScoring`):
     * kombo za sebrání v řadě a bonus na konci výhry; `target` = výhra až po
     * dosažení cílového skóre. Jen arkáda; bez výchozí hodnoty, jako `control` –
     * uložený spec bez pole staví tentýž svět.
     */
    scoring: z
      .object({ target: z.int().min(10).max(9999).optional() })
      .strict()
      .optional(),
    /**
     * Viditelná činnost hrdiny (P37-0 T1). Bez výchozí hodnoty, jako `control`:
     * uložená hra bez pole má tentýž `gameSpecHash`; render si doplní `none`.
     */
    heroAction: heroActionSchema.optional(),
  })
  .strict();

export type GameSpecV1 = z.infer<typeof gameSpecSchema>;

/**
 * Čím aréna (`move_free`) vyhrává – jediné místo, odkud to čte spec i
 * kompilátor. `goal` z parametrů, bez něj časovač končící výhrou = přežít,
 * jinak růst. Přežití trvá tolik, kolik říká ten časovač (nebo `seconds`),
 * a obě čísla se musí shodovat: hráč čte časovač, jádro `seconds`.
 */
export function arenaWinOf(spec: Pick<GameSpecV1, 'controlParams' | 'mechanics'>): { readonly goal: 'grow' | 'survive'; readonly seconds?: number } | { readonly issue: string } {
  const params = (spec.controlParams ?? {}) as ArenaSpecParams;
  const timer = spec.mechanics.find((m) => m.id === 'timer' && (m.params as { onEnd?: string }).onEnd === 'win')?.params as { readonly seconds: number } | undefined;
  const goal = params.goal ?? (timer === undefined ? 'grow' : 'survive');
  if (goal === 'grow') {
    return timer === undefined ? { goal } : { issue: '/controlParams/goal: an arena won by growing cannot also win on a timer – end the timer with lose' };
  }
  // Přežití s časovačem, který končí prohrou: jádro by vyhrálo po `seconds`, hráč čte jiné číslo.
  if (timer === undefined && spec.mechanics.some((m) => m.id === 'timer')) {
    return { issue: '/controlParams/goal: an arena won by surviving needs its timer to end with win' };
  }
  if (timer !== undefined && params.seconds !== undefined && params.seconds !== timer.seconds) {
    return { issue: `/controlParams/seconds: ${params.seconds} s but the winning timer says ${timer.seconds} s` };
  }
  const seconds = timer?.seconds ?? params.seconds;
  if (seconds !== undefined && (seconds < 20 || seconds > 80)) return { issue: `/controlParams/seconds: an arena survival lasts 20–80 s, not ${seconds}` };
  return seconds === undefined ? { goal } : { goal, seconds };
}

export type GameSpecReason =
  /** Tvar neodpovídá schématu. */
  | 'MALFORMED_SPEC'
  /** Mechanika nepatří k archetypu, nebo parametry neprošly jejím schématem. */
  | 'MECHANIC_REJECTED'
  /** Odkaz na roli, mechaniku nebo slot, který spec nedeklaruje; nebo chybí právě jeden `player`. */
  | 'DANGLING_REFERENCE'
  /** Cíl neodpovídá archetypu, nebo mu chybí `count`/`seconds`/`role`, které jeho druh žádá. */
  | 'OBJECTIVE_MISMATCH'
  /** Odhad nákladů mechanik a rolí překračuje rozpočty specu nebo strop registru. */
  | 'BUDGET_EXCEEDED';

export type GameSpecResult =
  | { readonly ok: true; readonly value: GameSpecV1; readonly specHash: string }
  | { readonly ok: false; readonly reason: GameSpecReason; readonly issues: readonly string[] };

/** Hash záměru – FNV-1a nad kanonickou serializací, tatáž rodina jako `simHashOf`. */
export function gameSpecHash(spec: GameSpecV1): string {
  return canonicalHash(spec);
}

const OBJECTIVE_NEEDS: Readonly<Record<ObjectiveKind, readonly ('count' | 'seconds' | 'role')[]>> = {
  reach: ['role'],
  collect: ['count', 'role'],
  survive: ['seconds'],
  checkpoints: ['count', 'role'],
  deliver: ['role'],
  puzzle: ['role'],
  defeat_targets: ['count', 'role'],
};

/**
 * Přečte a **celý** posoudí spec. Vrací verdikt, ne výjimku – volá se nad
 * odpovědí modelu i nad ručními fixturami a v obou případech je odmítnutí
 * s důvodem to, co volající potřebuje pro opravné kolo.
 */
export function readGameSpec(input: unknown): GameSpecResult {
  const parsed = gameSpecSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      reason: 'MALFORMED_SPEC',
      issues: parsed.error.issues.map((issue) => `/${issue.path.join('/')}: ${issue.message}`),
    };
  }
  // Popisky se čistí tady, ne `transform` ve schématu – z toho se staví JSON Schema zadání.
  const spec = { ...parsed.data, roles: parsed.data.roles.map((role) => ({ ...role, label: roleLabel(role.label) })) };
  if (spec.controlParams !== undefined) {
    if (spec.control === undefined || spec.control === 'tap_go') {
      return {
        ok: false,
        reason: 'MALFORMED_SPEC',
        issues: ['/controlParams: only an arcade game (any control but tap_go) takes control parameters'],
      };
    }
    // Sjednocení ve schématu pustí parametry kteréhokoli ovládání; tady musí sedět na to zvolené.
    const own = SPEC_CONTROL_PARAMS[spec.control].safeParse(spec.controlParams);
    if (!own.success) {
      return { ok: false, reason: 'MALFORMED_SPEC', issues: own.error.issues.map((issue) => `/controlParams/${issue.path.join('/')}: ${issue.message} (${spec.control})`) };
    }
    // `tuning` přebije parametry až v kompilaci: klíč, který soudí tohle schéma (meze, cíl arény proti časovači), by obešel (revize T4).
    const shape = CONTROL_PARAMS[spec.control].shape;
    const shadowed = Object.keys(own.data.tuning ?? {}).filter((key) => Object.hasOwn(shape, key));
    if (shadowed.length > 0) {
      return {
        ok: false,
        reason: 'MALFORMED_SPEC',
        issues: shadowed.map((key) => `/controlParams/tuning/${key}: ${spec.control} takes ${key} in controlParams itself – tuning carries only the generator's own keys`),
      };
    }
  }
  if (spec.genre !== undefined && !isGenreMode(spec.genre.id, spec.genre.mode)) {
    return { ok: false, reason: 'MALFORMED_SPEC', issues: [`/genre/mode: ${spec.genre.id} has modes ${GENRE_MODES[spec.genre.id].join(', ')}, not ${spec.genre.mode}`] };
  }
  if (spec.addons !== undefined) {
    // Frozen voyage generators do not implement the new driving addons.
    const voyage = spec.control === 'steer' && typeof spec.controlParams?.generator === 'string' && spec.controlParams.generator.startsWith('voyage_');
    const allowed: readonly AddonId[] = voyage ? [] : CAPABILITIES[spec.control ?? 'tap_go'].addons;
    const addonIssues = spec.addons.flatMap((addon, index) =>
      spec.addons!.indexOf(addon) !== index
        ? [`/addons/${index}: ${addon} is listed twice`]
        : allowed.includes(addon)
          ? []
          : [`/addons/${index}: ${spec.control ?? 'tap_go'} does not take ${addon} (allowed: ${allowed.join(', ') || 'none'})`],
    );
    if (addonIssues.length > 0) return { ok: false, reason: 'MALFORMED_SPEC', issues: addonIssues };
  }
  if (spec.abilities !== undefined) {
    const allowed = CAPABILITIES[spec.control ?? 'tap_go'].abilities;
    const abilityIssues = spec.abilities.flatMap((ability, index) =>
      spec.abilities!.indexOf(ability) !== index
        ? [`/abilities/${index}: ${ability} is listed twice`]
        : allowed.includes(ability)
          ? []
          : [`/abilities/${index}: ${spec.control ?? 'tap_go'} does not take ${ability} (allowed: ${allowed.join(', ') || 'none'})`],
    );
    if (abilityIssues.length > 0) return { ok: false, reason: 'MALFORMED_SPEC', issues: abilityIssues };
  }
  if (spec.abilityWords !== undefined) {
    // Slovo patří akci na tomtéž místě (P47B T10): „Dodge“ na tlačítku úderu by hráči lhalo.
    const abilities = spec.abilities ?? [];
    const wordIssues =
      spec.abilityWords.length !== abilities.length
        ? [`/abilityWords: ${spec.abilityWords.length} words for ${abilities.length} abilities – one word per ability, in the same order`]
        : spec.abilityWords.flatMap((word, index) => {
            const allowed: readonly string[] = ABILITY_WORDS[abilities[index]!];
            return allowed.includes(word) ? [] : [`/abilityWords/${index}: ${word} is not a word for ${abilities[index]} (allowed: ${allowed.join(', ')})`];
          });
    if (wordIssues.length > 0) return { ok: false, reason: 'MALFORMED_SPEC', issues: wordIssues };
  }
  if (spec.control === 'move_free') {
    const win = arenaWinOf(spec);
    if ('issue' in win) return { ok: false, reason: 'MALFORMED_SPEC', issues: [win.issue] };
  }
  const archetype = ARCHETYPES[spec.archetype];
  const roleIds = new Set(spec.roles.map((role) => role.id));
  const issues: string[] = [];

  if (roleIds.size !== spec.roles.length) issues.push('/roles: duplicate role id');
  if (spec.roles.filter((role) => role.kind === 'player').length !== 1) issues.push('/roles: exactly one role of kind player');
  const partRoles = new Set<string>();
  for (const [index, part] of (spec.assemblyParts ?? []).entries()) {
    if (!roleIds.has(part.role) || spec.roles.find(role => role.id === part.role)?.kind === 'player') issues.push(`/assemblyParts/${index}/role: expected a named non-player role`);
    if (partRoles.has(part.role)) issues.push(`/assemblyParts/${index}/role: each part owns a distinct role`);
    partRoles.add(part.role);
  }
  if (spec.assemblyParts?.length && (!spec.control || spec.control === 'tap_go')) issues.push('/assemblyParts: an arcade movement is required');
  const mechanicIds = new Set<string>();
  spec.mechanics.forEach((mechanic, index) => {
    if (mechanicIds.has(mechanic.id)) issues.push(`/mechanics/${index}: mechanic ${mechanic.id} declared twice`);
    mechanicIds.add(mechanic.id);
  });
  if (issues.length > 0) return { ok: false, reason: 'DANGLING_REFERENCE', issues };

  if (spec.logic !== undefined && (spec.rules ?? []).length === 0) {
    return { ok: false, reason: 'MALFORMED_SPEC', issues: ['/logic: a logic block needs rules that read and change it'] };
  }
  if (spec.rules !== undefined || spec.things !== undefined) {
    if (spec.control === undefined || spec.control === 'tap_go') {
      return { ok: false, reason: 'MALFORMED_SPEC', issues: ['/rules: only an arcade game (any control but tap_go) takes rules'] };
    }
    // Vyhrává-li pravidlo na volném pohybu, hraje robot pravidel na dvorku. Generátor se počítá,
    // dokud ho spec nese: svět ho postaví. Zahodí ho jen `rulesYard` a ten běží před čtením (B-R10).
    const yard = spec.control === 'move_free' && (spec.rules ?? []).some((rule) => rule.do.some((effect) => 'win' in effect));
    const ruleProblems = ruleIssues(spec.rules ?? [], spec.things ?? [], roleIds, { addons: spec.addons, generator: spec.controlParams?.generator, yard, ...(spec.logic === undefined ? {} : { logic: spec.logic }) });
    if (ruleProblems.length > 0) return { ok: false, reason: 'DANGLING_REFERENCE', issues: ruleProblems };
  }

  // Arkáda povinné mechaniky archetypu nečte (P26 T5, `capabilities.ts`) – vyžadovat
  // je by nutilo model psát, co hra nehraje.
  const arcade = spec.control !== undefined && spec.control !== 'tap_go';
  for (const required of arcade ? [] : archetype.requiredMechanics) {
    if (!mechanicIds.has(required)) issues.push(`/mechanics: archetype ${spec.archetype} requires ${required}`);
  }
  spec.mechanics.forEach((mechanic, index) => {
    const entry = MECHANICS[mechanic.id] as MechanicEntry<unknown>;
    if (!archetype.allowedMechanics.includes(mechanic.id)) {
      issues.push(`/mechanics/${index}: ${mechanic.id} is not allowed in ${spec.archetype}`);
      return;
    }
    const params = entry.params.safeParse(mechanic.params);
    if (!params.success) {
      for (const issue of params.error.issues) issues.push(`/mechanics/${index}/params/${issue.path.join('/')}: ${issue.message}`);
      return;
    }
    for (const [field, roleId] of entry.roleRefs(params.data)) {
      if (!roleIds.has(roleId)) issues.push(`/mechanics/${index}/params/${field}: unknown role ${roleId}`);
    }
  });
  if (issues.length > 0) return { ok: false, reason: 'MECHANIC_REJECTED', issues };

  // `property_transform.from`, který role nemá od startu a žádná mechanika ho
  // nenastaví, je mrtvé pravidlo: spec by prošel a transformace nevystřelila.
  const reachable = new Map(spec.roles.map((role) => [role.id, new Set([ROLE_INITIAL_STATE[role.kind]])]));
  const parsedParams = spec.mechanics.map((mechanic) => (MECHANICS[mechanic.id] as MechanicEntry<unknown>).params.parse(mechanic.params));
  spec.mechanics.forEach((mechanic, index) => {
    const entry = MECHANICS[mechanic.id] as MechanicEntry<unknown>;
    for (const [roleId, state] of entry.setsStates?.(parsedParams[index]) ?? []) reachable.get(roleId)?.add(state);
  });
  spec.mechanics.forEach((mechanic, index) => {
    if (mechanic.id !== 'property_transform') return;
    const { role, from } = parsedParams[index] as { role: string; from: string };
    if (!reachable.get(role)?.has(from)) {
      issues.push(`/mechanics/${index}/params/from: role ${role} is never in state ${from} (reachable: ${[...(reachable.get(role) ?? [])].join(', ')})`);
    }
  });
  if (issues.length > 0) return { ok: false, reason: 'MECHANIC_REJECTED', issues };

  if (spec.objective.kind !== archetype.objective) {
    issues.push(`/objective/kind: ${spec.archetype} expects ${archetype.objective}, got ${spec.objective.kind}`);
  }
  for (const field of OBJECTIVE_NEEDS[spec.objective.kind]) {
    if (spec.objective[field] === undefined) issues.push(`/objective/${field}: required for ${spec.objective.kind}`);
  }
  if (spec.objective.role !== undefined && !roleIds.has(spec.objective.role)) {
    issues.push(`/objective/role: unknown role ${spec.objective.role}`);
  }
  if (issues.length > 0) return { ok: false, reason: 'OBJECTIVE_MISMATCH', issues };

  spec.verification.forEach((assertion, index) => {
    if (assertion.kind === 'keypoint' && assertion.mechanic === undefined) {
      issues.push(`/verification/${index}/mechanic: keypoint must name the mechanic it proves`);
    }
    if (assertion.mechanic !== undefined && !mechanicIds.has(assertion.mechanic)) {
      issues.push(`/verification/${index}/mechanic: unknown mechanic ${assertion.mechanic}`);
    }
    for (const action of assertion.actions ?? []) {
      if (!roleIds.has(action.target)) issues.push(`/verification/${index}/actions: unknown role ${action.target}`);
    }
    for (const [from, at] of Object.entries(assertion.setup?.placeAt ?? {})) {
      if (!roleIds.has(from) || !roleIds.has(at)) issues.push(`/verification/${index}/setup/placeAt: unknown role ${from} or ${at}`);
    }
    for (const id of assertion.assert.firedMechanics ?? []) {
      if (!mechanicIds.has(id)) issues.push(`/verification/${index}/assert/firedMechanics: unknown mechanic ${id}`);
    }
  });
  if (issues.length > 0) return { ok: false, reason: 'DANGLING_REFERENCE', issues };

  // Odhad počítá pravidla mřížky; arkáda je nekompiluje a svoje meze drží `ARCADE_LIMITS` (P26 T3).
  const cost = arcade ? null : estimateCost(spec.mechanics, spec.roles);
  if (cost !== null && cost.entities > spec.budgets.maxEntities) {
    issues.push(`/budgets/maxEntities: estimate ${cost.entities} exceeds ${spec.budgets.maxEntities}`);
  }
  if (cost !== null && cost.rules > spec.budgets.maxRules) issues.push(`/budgets/maxRules: estimate ${cost.rules} exceeds ${spec.budgets.maxRules}`);
  if (issues.length > 0) return { ok: false, reason: 'BUDGET_EXCEEDED', issues };

  return { ok: true, value: spec, specHash: gameSpecHash(spec) };
}
