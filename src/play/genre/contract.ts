/**
 * Kontrakt žánrů (P32-0 T3): pět žánrů PLAY, jejich režimy, tvar `GenreSpec`,
 * který píše AI i rychlá verze, a rozhraní modulu žánru.
 *
 * **Žánr je vrstva nad `GameSpecV1`.** Modul přeloží `GenreSpec` na dnešní spec
 * a ten jde dál dnešním kompilátorem a jádrem – uložené hry, replay i ověřovací
 * řetěz zůstávají jedna cesta. Spec bez pole `genre` jde starou cestou beze změny.
 *
 * Meze parametrů (`paramBounds`) patří modulu, ne tomuhle souboru: moduly plní
 * různé stopy P32 a každá edituje jen svůj soubor. Hlídá je `readGenreSpec`
 * v `./index`.
 */

import { z } from 'zod';

import { START_LIVES } from '../arcade/contract';
import { LOOK_IDS } from '../arcade/look';
import { THINGS_MAX, type Rule, modelRulesSchema, thingsSchema } from '../arcade/rules/schema';
import { readRoles } from '../draft/lexicon';
import type { Reading } from '../read/schema';
import type { ControlId, GameRole, GameSpecV1 } from '../spec';

/** Verze překladu `GenreSpec → GameSpecV1`; zapisuje se do `spec.genre`. */
export const GENRE_COMPILER_VERSION = 'genre.v1';

/**
 * Životy hry žánru (P36A T2): mechanika `health` se třemi životy. Čte ji
 * kompilátor (čítač životů, milost po zásahu) i HUD; číslo z věty („with 5
 * lives“) do ní dosadí rychlý návrh (`draft.ts`). Spec uložený bez ní hraje
 * dál bez životů, jako dřív.
 */
export const livesMechanic = (): GameSpecV1['mechanics'][number] => ({ id: 'health', params: { max: START_LIVES } });

export const GENRES = ['runner', 'platformer', 'arena', 'voyage', 'quest'] as const;
export type GenreId = (typeof GENRES)[number];

export const GENRE_MODES = {
  runner: ['default'],
  platformer: ['default'],
  arena: ['escape', 'collect', 'fight'],
  voyage: ['race', 'land'],
  quest: ['spatial', 'station'],
} as const satisfies Readonly<Record<GenreId, readonly [string, ...string[]]>>;
export type GenreMode<G extends GenreId = GenreId> = (typeof GENRE_MODES)[G][number];

/** Všechny režimy všech žánrů – schéma pole `genre` ve specu; kombinaci soudí `readGameSpec`. */
export const ALL_GENRE_MODES = [...new Set(GENRES.flatMap((genre) => GENRE_MODES[genre]))] as [GenreMode, ...GenreMode[]];

export const isGenreMode = (genre: GenreId, mode: string): boolean => (GENRE_MODES[genre] as readonly string[]).includes(mode);

/** Třídy modelů v manifestu assetů (`src/play/assets/manifest.ts`); žánr říká, které smějí hrát hrdinu. */
export const MODEL_CLASSES = ['animal', 'bird', 'robot', 'vehicle', 'boat', 'aircraft', 'humanoid', 'monster', 'prop'] as const;
export type ModelClass = (typeof MODEL_CLASSES)[number];

/** Popisek role: anglické podstatné jméno z věty („polar bear“). */
const label = z.string().min(1).max(60);

/** Předmět úkolu: co hráč dělá (`verb`) a kolik viditelných stavů předmět projde. */
export const genreTargetSchema = z
  .object({
    label,
    verb: z.string().min(1).max(24),
    states: z.union([z.literal(2), z.literal(3)]),
  })
  .strict();

/** Role, jejichž počet věta říká („grab 5 coins“, „two ghosts“). */
export const COUNT_ROLES = ['enemy', 'collectible', 'target'] as const;
export type CountRole = (typeof COUNT_ROLES)[number];

/** Počty rolí (B-R4); meze drží parametr modulu, do kterého počet jde (`COUNT_PARAMS`). */
export const genreCountsSchema = z.object({ enemy: z.int().optional(), collectible: z.int().optional(), target: z.int().optional() }).strict();

/**
 * Role, kterou potřebují jen pravidla (klíč, dveře, zvon) – modul žánru ji
 * nestaví. Druh soudí `readGameSpec` až na přeloženém specu: `spec.ts` tenhle
 * soubor importuje, jeho výčet druhů tady být nemůže.
 */
export const ruleRoleSchema = z
  .object({
    id: z.string().regex(/^[A-Za-z][A-Za-z0-9_.]{0,63}$/),
    kind: z.string().min(1).max(24),
    label,
    count: z.int().min(1).max(50).optional(),
  })
  .strict();

const variant = <G extends GenreId>(genre: G) =>
  z
    .object({
      genre: z.literal(genre),
      mode: z.enum(GENRE_MODES[genre]),
      hero: label,
      enemy: label.optional(),
      collectible: label.optional(),
      target: genreTargetSchema.optional(),
      setting: z.string().min(1).max(80),
      /** Sada vzhledu a její paleta (`arcade/look`); bez ní se hádá ze `setting`. */
      palette: z.enum(LOOK_IDS).optional(),
      /** Číselné parametry žánru; meze drží `paramBounds` modulu (`readGenreSpec`). */
      params: z.record(z.string(), z.int()).optional(),
      /** Kolik nepřátel, věcí a předmětů úkolu věta chce; překlad je propíše do parametrů modulu (`withCounts`). */
      counts: genreCountsSchema.optional(),
      /**
       * Sloveso mimo žánr (B-R5): pravidla P29A, jejich role a doplňky. Modul je
       * přeloží spolu se svými rolemi (`legacySpec`); vyhrává-li pravidlo na
       * volném pohybu, hraje se na dvorku pravidel místo generátoru režimu.
       */
      ruleRoles: z.array(ruleRoleSchema).max(THINGS_MAX).optional(),
      things: thingsSchema.optional(),
      rules: modelRulesSchema.optional(),
    })
    .strict();

/**
 * Rozlišené podle `genre`, takže režim jiného žánru neprojde tvarem – bez
 * dodatečné kontroly a i ve JSON Schema, které z něj dostane režisér.
 */
export const genreSpecSchema = z.discriminatedUnion('genre', [variant('runner'), variant('platformer'), variant('arena'), variant('voyage'), variant('quest')]);
export type GenreSpec = z.infer<typeof genreSpecSchema>;
export type GenreSpecOf<G extends GenreId> = Extract<GenreSpec, { readonly genre: G }>;

export type ParamBounds = Readonly<Record<string, { readonly min: number; readonly max: number }>>;

/** `ready` = režim hraje, co slibuje; `fallback` = hraje náhradu a klasifikátor ho volí až naposled. */
export type ModeAvailability = 'ready' | 'fallback';

export interface GenreModule<G extends GenreId = GenreId> {
  readonly id: G;
  readonly modes: readonly GenreMode<G>[];
  /** Slova věty (slovesa, žánrové narážky), ze kterých klasifikátor skládá skóre. */
  readonly cues: readonly string[];
  /** Třídy modelů, které smějí hrát hrdinu. */
  readonly heroClasses: readonly ModelClass[];
  readonly paramBounds: ParamBounds;
  availability(mode: GenreMode<G>): ModeAvailability;
  compile(spec: GenreSpecOf<G>): GameSpecV1;
  /** Co jde z věty vyčíst bez AI; `reading` je čtení modelem, když je k dispozici. */
  draftFill(sentence: string, reading: Reading | null): Partial<GenreSpecOf<G>>;
}

// ---------------------------------------------------------------------------
// Počty rolí (B-R4): parametr modulu, který počet nese

/**
 * Režim → role → parametr modulu, ze kterého modul staví generátor, cíl i
 * `count` role. Žánr bez řádku počty nečte (plavba staví trať podle délky,
 * ne podle počtu; plošinovka počítá jen věci ke sběru, P35 T3; běžec od P36A T4
 * natahuje trať podle překážek i věcí). Hlídá test, že každý parametr má modul
 * v `paramBounds`.
 */
export const COUNT_PARAMS: { readonly [G in GenreId]: { readonly [M in GenreMode<G>]?: Readonly<Partial<Record<CountRole, string>>> } } = {
  runner: { default: { enemy: 'obstacles', collectible: 'items' } },
  platformer: { default: { collectible: 'items' } },
  arena: { escape: { enemy: 'chasers', collectible: 'items' }, collect: { collectible: 'items' }, fight: { enemy: 'enemies' } },
  voyage: {},
  quest: { spatial: { target: 'count', enemy: 'chasers' }, station: { target: 'count' } },
};

const countParamsOf = (spec: Pick<GenreSpec, 'genre' | 'mode'>): Readonly<Partial<Record<CountRole, string>>> =>
  (COUNT_PARAMS[spec.genre] as Readonly<Record<string, Readonly<Partial<Record<CountRole, string>>> | undefined>>)[spec.mode] ?? {};

/**
 * Počty → parametry modulu, jak je modul čte. Parametr, který spec nese sám,
 * má přednost; počet role, kterou režim nepočítá, se zahodí (přepnutý žánr ho nemusí znát).
 */
export function withCounts(spec: GenreSpec): GenreSpec {
  if (spec.counts === undefined) return spec;
  const table = countParamsOf(spec);
  const { counts, ...rest } = spec;
  const from = Object.entries(counts).flatMap(([role, value]) => {
    const key = table[role as CountRole];
    return key === undefined || value === undefined ? [] : [[key, value] as const];
  });
  const params = { ...Object.fromEntries(from), ...spec.params };
  return (Object.keys(params).length === 0 ? rest : { ...rest, params }) as GenreSpec;
}

/** Počty mimo meze parametru, do kterého jdou – `readGenreSpec` je hlásí jako parametry. */
export function countIssues(spec: GenreSpec, bounds: ParamBounds): string[] {
  const table = countParamsOf(spec);
  return Object.entries(spec.counts ?? {}).flatMap(([role, value]) => {
    const key = table[role as CountRole];
    const range = key === undefined ? undefined : bounds[key];
    if (range === undefined || value === undefined) return [];
    return value < range.min || value > range.max ? [`/counts/${role}: ${String(value)} is outside ${String(range.min)}–${String(range.max)}`] : [];
  });
}

// ---------------------------------------------------------------------------
// Společné kusy pahýlů: překlad na dnešní ovládání a čtení rolí z věty

/** Co pahýl žánru říká o hře; zbytek `GameSpecV1` doplní `legacySpec`. */
export interface LegacyGame {
  readonly control: ControlId;
  readonly controlParams?: GameSpecV1['controlParams'];
  readonly archetype: GameSpecV1['archetype'];
  readonly title: string;
  readonly objective: GameSpecV1['objective'];
  readonly mechanics?: GameSpecV1['mechanics'];
  /** Role kromě hráče; hráč je vždy `hero` z `GenreSpec`. */
  readonly roles: readonly (Omit<GameRole, 'count'> & { readonly count?: number })[];
  readonly tutorial: GameSpecV1['tutorial'];
  readonly mood: string;
  readonly targetDurationSec?: number;
}

/** Pravidlo, které vyhrává, a čí popisek jmenuje: „Ring the bronze bell.“ */
function ruleGoal(rules: readonly Rule[], roles: readonly Pick<GameRole, 'id' | 'label'>[]): string | null {
  const winning = rules.find((rule) => rule.do.some((effect) => 'win' in effect));
  if (winning === undefined) return null;
  const refs = 'contact' in winning.when ? winning.when.contact : 'hit' in winning.when ? [winning.when.hit] : [];
  const object = roles.find((role) => role.id === [...refs].reverse().find((id) => id !== 'player'))?.label;
  const verb = winning.verb.charAt(0).toUpperCase() + winning.verb.slice(1);
  return object === undefined ? `${verb} to win.` : `${verb} the ${object}.`;
}

/** `GenreSpec` + dnešní ovládání → `GameSpecV1`, který nese, z jakého žánru vznikl. */
export function legacySpec(spec: GenreSpec, game: LegacyGame): GameSpecV1 {
  const own = [{ id: 'player', kind: 'player' as const, label: spec.hero, count: 1 }, ...game.roles.map((role) => ({ count: 1, ...role }))];
  // Role pravidel s id, které modul už staví, míří na tělesa modulu – druhá role téhož id by spec rozbila.
  const extra = (spec.ruleRoles ?? []).filter((role) => !own.some((taken) => taken.id === role.id)).map((role) => ({ count: 1, ...role }) as GameRole);
  const roles = [...own, ...extra];
  const rules = spec.rules ?? [];
  return rulesYard({
    schema: 'gamespec.v1',
    control: game.control,
    ...(game.controlParams === undefined ? {} : { controlParams: game.controlParams }),
    genre: { id: spec.genre, mode: spec.mode, compilerVersion: GENRE_COMPILER_VERSION },
    title: game.title,
    archetype: game.archetype,
    targetDurationSec: game.targetDurationSec ?? 60,
    theme: { setting: spec.setting, mood: game.mood, ...(spec.palette === undefined ? {} : { look: spec.palette }) },
    objective: game.objective,
    mechanics: [...(game.mechanics ?? [])],
    roles,
    ...(rules.length === 0 ? {} : { rules }),
    ...(spec.things === undefined || spec.things.length === 0 ? {} : { things: spec.things }),
    tutorial: game.tutorial,
    verification: [{ id: 'winnable', kind: 'reachability', assert: { runState: 'won' } }],
    budgets: { maxEntities: 40, maxRules: 120, maxTriangles: 200000 },
  });
}

/**
 * Vyhrává-li pravidlo na volném pohybu, hraje se na dvorku (`rulesOwnGoal`):
 * generátor režimu by sloveso přehlušil a robot by ho nevystřelil. Cíl pak
 * říká pravidlo, ne režim. Platí pro překlad `GenreSpec` i pro záplatu
 * opravného kola, která pravidla hře žánru dopíše (`applyRepairAnswer`).
 */
export function rulesYard(spec: GameSpecV1): GameSpecV1 {
  const goal = spec.control === 'move_free' ? ruleGoal(spec.rules ?? [], spec.roles) : null;
  if (goal === null) return spec;
  const { controlParams, ...rest } = spec;
  const { generator: _generator, tuning: _tuning, ...plain } = (controlParams ?? {}) as Record<string, unknown>;
  return {
    ...rest,
    ...(Object.keys(plain).length > 0 ? { controlParams: plain as GameSpecV1['controlParams'] } : {}),
    objective: { ...spec.objective, description: goal },
    tutorial: { ...spec.tutorial, goalLine: goal },
  };
}

/** „polar bear“ → „Polar Bear“ pro titulek hry. */
export const titleCase = (text: string): string => text.replace(/\b\p{L}/gu, (letter) => letter.toUpperCase());

/** Hrdina, nepřítel, sbíraná věc a prostředí z věty; čtení modelem má přednost před slovníkem. */
export function draftRoles(sentence: string, reading: Reading | null): Pick<Partial<GenreSpec>, 'hero' | 'enemy' | 'collectible' | 'setting'> {
  const words = readRoles(sentence);
  const read = (kinds: readonly string[]): string | null => reading?.roles.find((role) => kinds.includes(role.kind))?.noun ?? null;
  const hero = reading?.hero ?? words.player;
  const enemy = read(['chaser', 'threat', 'hazard', 'obstacle']) ?? words.threat?.label ?? words.chaser ?? words.hazard;
  const collectible = read(['collectible', 'item']) ?? words.collectible;
  const setting = reading?.setting ?? words.setting;
  return {
    ...(hero === null ? {} : { hero }),
    ...(enemy === null ? {} : { enemy }),
    ...(collectible === null ? {} : { collectible }),
    ...(setting === null ? {} : { setting }),
  };
}
