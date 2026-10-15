/**
 * Měřidlo finále P47A (T1): pro každou větu žánr a generátor rychlého návrhu,
 * zda svět nese pravidlo `pacing` (průběh P45C), a když ne, proč; z běhu robota
 * `intermediate` na semínku publikace (`publishedWorld`, táž cesta jako `/play`)
 * finále podle telemetrie P45A (`boss` / `climax` / žádné), počet chování,
 * nejdelší mezeru a stoupání. Souhrn po žánrech bere čísla zábavy jen z
 * hratelných her (jako `p45/fun.ts`), podíl průběhu ze všech postavených.
 *
 * Telemetrii ani měřidlo zábavy nemění: jen čte svět a stopu běhu.
 */

import { arcadeWorldOf, generatorOf } from '@/play/arcade/compile';
import { type ArcadeWorld, nativeRule } from '@/play/arcade/contract';
import { GENRE_PACING, UNPACED_GENRE_VERSION } from '@/play/arcade/pieces/pacing-parts';
import { funMetrics, traceRun } from '@/play/arcade/telemetry';
import { runBot } from '@/play/arcade/verify';
import { draftGameSpecWithMeta } from '@/play/draft';
import type { GameSpecV1 } from '@/play/spec';

import { publishedWorld } from '../p45/fun';

/** Proč hra průběh nemá: generátor bez záznamu či uložená verze, díly P42, pravidla či věci specu, málo životů, plný rozpočet pravidel. */
export const UNPACED_REASONS = ['entry', 'assembly', 'rules', 'things', 'lives', 'budget'] as const;
export type UnpacedReason = (typeof UNPACED_REASONS)[number];

/** Šest žánrů P47A (žánr rychlého návrhu jako `genreOf` v `p45/fun.ts`). */
export const P47A_GENRES = ['arena.collect', 'arena.escape', 'quest.spatial', 'quest.station', 'duel', 'throw'] as const;

export interface FinaleRow {
  readonly id: string;
  readonly text: string;
  /** Žánr, do kterého věta patří (dev sada: žánr návrhu na semínku 1; panel: táž věc). */
  readonly cell: string;
  readonly genre: string;
  readonly generator: string;
  readonly seed: number | null;
  readonly playable: boolean;
  readonly paced: boolean;
  /** `null` = průběh má, nebo arkádová hra nevznikla. */
  readonly reason: UnpacedReason | null;
  readonly finale: 'boss' | 'climax' | null;
  readonly behaviourCount: number | null;
  readonly behaviours: readonly string[];
  readonly longestGapS: number | null;
  readonly rising: boolean | null;
  readonly issues: readonly string[];
}

const livesOf = (spec: GameSpecV1): number | undefined => (spec.mechanics.find((mechanic) => mechanic.id === 'health')?.params as { readonly max?: number } | undefined)?.max;

/**
 * Proč svět průběh nenese, v pořadí podmínek `GENRE_PACING` / `pacingParts`;
 * `null` = pravidlo `pacing` ve světě je.
 * simplified: podmínky šesti žánrů P47A (`ownShape`, `livesAtMost`); generátor s vlastní výjimkou (díl `chaser`
 * skákačky, závod s jednou havárií) se přiřadí nejbližšímu důvodu – rozšířit, až gauge začne měřit i ty.
 */
export function unpacedReason(spec: GameSpecV1, world: ArcadeWorld): UnpacedReason | null {
  if (nativeRule(world.rules, 'pacing') !== undefined) return null;
  if (GENRE_PACING[generatorOf(spec)] === undefined || spec.genre === undefined || spec.genre.compilerVersion === UNPACED_GENRE_VERSION) return 'entry';
  if (spec.assemblyParts !== undefined) return 'assembly';
  if ((spec.rules?.length ?? 0) > 0) return 'rules';
  if ((spec.things?.length ?? 0) > 0) return 'things';
  const lives = livesOf(spec);
  if (lives !== undefined && lives <= 2) return 'lives';
  return 'budget';
}

/** Žánr rychlého návrhu jako `genreOf` v `p45/fun.ts`. */
export function genreOfSpec(spec: GameSpecV1): string {
  if (spec.genre !== undefined) return spec.genre.mode === 'default' ? spec.genre.id : `${spec.genre.id}.${spec.genre.mode}`;
  return spec.control === undefined || spec.control === 'tap_go' ? 'grid' : `control:${spec.control}`;
}

/** Řádek gauge nad hotovým světem (bez výběru semínka): průběh, důvod a běh robota `intermediate`. */
export function gaugeOf(spec: GameSpecV1, world: ArcadeWorld): Pick<FinaleRow, 'paced' | 'reason' | 'finale' | 'behaviourCount' | 'behaviours' | 'longestGapS' | 'rising'> {
  const reason = unpacedReason(spec, world);
  const metrics = funMetrics(traceRun(world, runBot(world, undefined, { profile: 'intermediate' }).inputs));
  return {
    paced: reason === null,
    reason,
    finale: metrics.finale.why === 'boss' || metrics.finale.why === 'climax' ? metrics.finale.why : null,
    behaviourCount: metrics.behaviourCount,
    behaviours: metrics.behaviours,
    longestGapS: metrics.longestGapS,
    rising: metrics.rising,
  };
}

export async function finaleRow(id: string, text: string, cell?: string): Promise<FinaleRow> {
  const { spec } = draftGameSpecWithMeta(text, 1);
  const { genre, seed, playable, world, issues } = await publishedWorld(text);
  const base = { id, text, cell: cell ?? genre, genre, generator: generatorOf(spec), seed, playable, issues };
  if (world === null) return { ...base, paced: false, reason: null, finale: null, behaviourCount: null, behaviours: [], longestGapS: null, rising: null };
  return { ...base, ...gaugeOf(spec, world) };
}

/** Svět specu na semínku – pro testy a sondy bez výhybky publikace. */
export function worldOf(spec: GameSpecV1, seed = 1): ArcadeWorld {
  const made = arcadeWorldOf(spec, seed);
  if (!made.ok) throw new Error(made.issues.join('; '));
  return made.world;
}

const round2 = (value: number): number => Math.round(value * 100) / 100;

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return round2(sorted.length % 2 === 1 ? (sorted[mid] as number) : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2);
}

const share = (flags: readonly boolean[]): number | null => (flags.length === 0 ? null : round2(flags.filter(Boolean).length / flags.length));

export interface GenreSummary {
  readonly sentences: number;
  /** Arkádová hra vznikla (s průběhem či bez). */
  readonly built: number;
  readonly playable: number;
  readonly pacedShare: number | null;
  /** Kolik postavených her průběh nemá a proč. */
  readonly reasons: Partial<Record<UnpacedReason, number>>;
  readonly finaleShare: number | null;
  readonly bossShare: number | null;
  readonly behavioursMedian: number | null;
  readonly deadTimeMedianS: number | null;
  readonly risingShare: number | null;
}

/** Souhrn jedné skupiny řádků: průběh nad postavenými hrami, zábava nad hratelnými. */
export function summaryOf(rows: readonly FinaleRow[]): GenreSummary {
  const built = rows.filter((row) => row.behaviourCount !== null);
  const played = built.filter((row) => row.playable);
  const reasons: Partial<Record<UnpacedReason, number>> = {};
  for (const row of built) if (row.reason !== null) reasons[row.reason] = (reasons[row.reason] ?? 0) + 1;
  return {
    sentences: rows.length,
    built: built.length,
    playable: played.length,
    pacedShare: share(built.map((row) => row.paced)),
    reasons,
    finaleShare: share(played.map((row) => row.finale !== null)),
    bossShare: share(played.map((row) => row.finale === 'boss')),
    behavioursMedian: median(played.map((row) => row.behaviourCount as number)),
    deadTimeMedianS: median(played.map((row) => row.longestGapS as number)),
    risingShare: share(played.map((row) => row.rising === true)),
  };
}

/** Souhrn po žánrech, které hra opravdu postavila, a celek. */
export function genreSummary(rows: readonly FinaleRow[]): { readonly all: GenreSummary; readonly genres: Readonly<Record<string, GenreSummary>> } {
  const genres = [...new Set(rows.map((row) => row.genre))].sort();
  return { all: summaryOf(rows), genres: Object.fromEntries(genres.map((genre) => [genre, summaryOf(rows.filter((row) => row.genre === genre))])) };
}
