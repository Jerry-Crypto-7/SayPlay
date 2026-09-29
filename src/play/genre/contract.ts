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

import { LOOK_IDS } from '../arcade/look';
import { readRoles } from '../draft/lexicon';
import type { Reading } from '../read/schema';
import type { ControlId, GameRole, GameSpecV1 } from '../spec';

/** Verze překladu `GenreSpec → GameSpecV1`; zapisuje se do `spec.genre`. */
export const GENRE_COMPILER_VERSION = 'genre.v1';

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

/** `GenreSpec` + dnešní ovládání → `GameSpecV1`, který nese, z jakého žánru vznikl. */
export function legacySpec(spec: GenreSpec, game: LegacyGame): GameSpecV1 {
  return {
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
    roles: [{ id: 'player', kind: 'player', label: spec.hero, count: 1 }, ...game.roles.map((role) => ({ count: 1, ...role }))],
    tutorial: game.tutorial,
    verification: [{ id: 'winnable', kind: 'reachability', assert: { runState: 'won' } }],
    budgets: { maxEntities: 40, maxRules: 120, maxTriangles: 200000 },
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
