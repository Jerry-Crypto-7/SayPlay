/**
 * Zpráva zábavy P45 (P45A T7): každá věta sady projde toutéž cestou jako hra
 * z `/play` (rychlý návrh, semínka publikace a táž výhybka jako `p36/depth.ts`),
 * robot `intermediate` ji odehraje a telemetrie (`traceRun` + `funMetrics`)
 * spočte čísla zábavy. Souhrn bere jen hratelné hry a porovná je s cíli spec.
 *
 * Zapečetěnou sadu čte jen konečné měření: `P45_OPEN_SEALED_ONCE=1` a pečeť
 * zlomená `loadSet` (`sealed-opened.json`) – jinak se soubor ani neotevře.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { derivedSeeds, seedFrom } from '@/app/api/play/_publish';
import { arcadeWorldOf, preloadPhysics } from '@/play/arcade/compile';
import type { ArcadeWorld } from '@/play/arcade/contract';
import { loadRapier } from '@/play/arcade/physics/world';
import { type FunMetrics, funMetrics, traceRun } from '@/play/arcade/telemetry';
import { runBot, verifyArcade } from '@/play/arcade/verify';
import { draftGameSpecWithMeta } from '@/play/draft';

export const P45_DIR = join(process.cwd(), 'evals', 'play', 'p45');
export const FUN_SETS = { panel: 'panel.json', sealed: 'sealed-100.json' } as const;
export type FunSet = keyof typeof FUN_SETS;

export interface FunSentence {
  readonly id: string;
  readonly text: string;
}

export interface FunRow {
  readonly id: string;
  readonly genre: string;
  /** Semínko, které publikace vybere; `null` = žádné nevyhovělo nebo hra nevznikla. */
  readonly seed: number | null;
  /** Robot publikace na vybraném semínku vyhraje a nečinný hráč ne. Jen hratelné hry vstupují do souhrnu. */
  readonly playable: boolean;
  /** Čísla běhu robota `intermediate`; `null` = arkádová hra nevznikla. */
  readonly metrics: FunMetrics | null;
  readonly issues: readonly string[];
}

/** Cíle spec P45 nad hratelnými hrami sady. */
export const FUN_TARGETS = [
  { metric: 'deadTimeMedianS', goal: '<= 3' },
  { metric: 'risingShare', goal: '>= 0.70' },
  { metric: 'behavioursMedian', goal: '>= 2' },
  { metric: 'finaleShare', goal: '>= 0.50' },
] as const;

export interface FunSummary {
  readonly n: number;
  readonly playable: number;
  readonly deadTimeMedianS: number | null;
  readonly risingShare: number | null;
  readonly behavioursMedian: number | null;
  readonly finaleShare: number | null;
  readonly eventsPerSMedian: number | null;
  readonly nearMissesMedian: number | null;
  readonly livesLostMedian: number | null;
  readonly targets: readonly { readonly metric: string; readonly goal: string; readonly value: number | null; readonly met: boolean }[];
  readonly met: boolean;
}

const readLf = (path: string): string => readFileSync(path, 'utf8').replace(/\r\n/g, '\n');

/**
 * Věty sady. Zapečetěná sada se přečte jen s `P45_OPEN_SEALED_ONCE=1` a se
 * zlomenou pečetí v `dir` – kontrola běží dřív, než se soubor otevře.
 */
export function funSentences(set: FunSet, { dir = P45_DIR, env = process.env, read = readLf }: { dir?: string; env?: Record<string, string | undefined>; read?: (path: string) => string } = {}): FunSentence[] {
  if (set === 'sealed') {
    if (env.P45_OPEN_SEALED_ONCE !== '1') throw new Error('p45: the sealed set is read only by the final measurement (P45_OPEN_SEALED_ONCE=1)');
    if (!existsSync(join(dir, 'sealed-opened.json'))) throw new Error('p45: the seal is not broken – open the set once through `play-fidelity.mjs fun --open-sealed-once`');
  }
  const corpus = JSON.parse(read(join(dir, FUN_SETS[set]))) as { sentences: FunSentence[] };
  return corpus.sentences.map(({ id, text }) => ({ id, text }));
}

/** Žánr rychlého návrhu jako `p36/depth.ts`; `grid` = hra spadla do mřížky. */
function genreOf(spec: ReturnType<typeof draftGameSpecWithMeta>['spec']): string {
  if (spec.genre !== undefined) return spec.genre.mode === 'default' ? spec.genre.id : `${spec.genre.id}.${spec.genre.mode}`;
  return spec.control === undefined || spec.control === 'tap_go' ? 'grid' : `control:${spec.control}`;
}

/** Svět, který publikace vybere (`world`), nebo důvod, proč arkádová hra nevznikla. */
export interface PublishedWorld {
  readonly genre: string;
  readonly seed: number | null;
  readonly playable: boolean;
  readonly world: ArcadeWorld | null;
  readonly issues: readonly string[];
}

export async function publishedWorld(text: string): Promise<PublishedWorld> {
  const { spec } = draftGameSpecWithMeta(text, 1);
  const genre = genreOf(spec);
  const dead = (issues: readonly string[]): PublishedWorld => ({ genre, seed: null, playable: false, world: null, issues });
  if (genre === 'grid') return dead(['the draft fell back to the grid game – no arcade world to measure']);
  await preloadPhysics(spec, loadRapier);
  // Táž výhybka jako `compileOnSeeds`: další semínko jen tehdy, když robot nevyhrál nebo nečinný vyhrál.
  let chosen: { seed: number; world: ArcadeWorld } | null = null;
  let last: ArcadeWorld | null = null;
  for (const seed of derivedSeeds(seedFrom(text.trim()))) {
    const made = arcadeWorldOf(spec, seed);
    if (!made.ok) return dead(made.issues);
    last = made.world;
    const verdict = verifyArcade(made.world);
    if (verdict.bot.outcome === 'won' && verdict.idle.outcome !== 'won') {
      chosen = { seed, world: made.world };
      break;
    }
  }
  // Nehratelná hra se změří taky (hráč ji může dostat), do souhrnu ale nevstupuje.
  return { genre, seed: chosen?.seed ?? null, playable: chosen !== null, world: chosen?.world ?? last, issues: [] };
}

export async function funRow(sentence: FunSentence): Promise<FunRow> {
  const { genre, seed, playable, world, issues } = await publishedWorld(sentence.text);
  if (world === null) return { id: sentence.id, genre, seed, playable, metrics: null, issues };
  const bot = runBot(world, undefined, { profile: 'intermediate' });
  return { id: sentence.id, genre, seed, playable, metrics: funMetrics(traceRun(world, bot.inputs)), issues };
}

const round2 = (value: number): number => Math.round(value * 100) / 100;

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return round2(sorted.length % 2 === 1 ? (sorted[mid] as number) : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2);
}

const share = (flags: readonly boolean[]): number | null => (flags.length === 0 ? null : round2(flags.filter(Boolean).length / flags.length));

export function funSummary(rows: readonly FunRow[]): FunSummary {
  const played = rows.filter((row) => row.playable && row.metrics !== null).map((row) => row.metrics as FunMetrics);
  const values = {
    deadTimeMedianS: median(played.map((m) => m.longestGapS)),
    risingShare: share(played.map((m) => m.rising)),
    behavioursMedian: median(played.map((m) => m.behaviourCount)),
    finaleShare: share(played.map((m) => m.finale.present)),
  };
  const targets = FUN_TARGETS.map(({ metric, goal }) => {
    const value = values[metric];
    const bound = Number(goal.slice(3));
    return { metric, goal, value, met: value !== null && (goal.startsWith('<=') ? value <= bound : value >= bound) };
  });
  return {
    n: rows.length,
    playable: played.length,
    ...values,
    eventsPerSMedian: median(played.map((m) => m.eventsPerS)),
    nearMissesMedian: median(played.map((m) => m.nearMisses)),
    livesLostMedian: median(played.map((m) => m.livesLost)),
    targets,
    met: targets.every((target) => target.met),
  };
}
