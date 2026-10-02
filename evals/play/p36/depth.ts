/**
 * Hloubka her rychlého návrhu (P36A T1) – měřítko, proti kterému se porovnávají
 * T2 (životy), T4 (délka 30–90 s), T5 (skóre), T10 a T11 (nové žánry).
 *
 * Každá věta 200 vět poptávky (`evals/play/demand/corpus.json`) a 60 vět
 * vývojové sady (`evals/play/p30/dev.json`) projde **toutéž cestou jako hra
 * z `/play`**: rychlý návrh ze slov (`draftGameSpecWithMeta`, semínko 1, bez
 * modelu) → semínka publikace (`derivedSeeds(seedFrom(věta))`) → první
 * semínko, na kterém robot vyhraje a nečinný hráč nevyhraje (táž výhybka jako
 * `compileOnSeeds` v `_publish.ts`) → `verifyArcade`.
 *
 * Definice polí řádku jsou v `README.md` vedle; tady jen to, co z kódu není vidět:
 * - **čas výhry** = tik konce vítězného běhu robota (`runBot` uvnitř
 *   `verifyArcade`, plánovač pravidel jako při publikaci) / 60 Hz;
 * - **nečinný hráč** = prázdný záznam vstupů až do horizontu jádra
 *   (`ARCADE_LIMITS.maxTicks` = 90 s); `unfinished` = na horizontu pořád běží;
 * - **životy** = čítač `health` na startu; souboj (`arena.fight`) ho nepoužívá
 *   a nese HP těla hráče; hra bez obojího má 1 (první zásah běh ukončí);
 * - **skóre rozhoduje** (definice T1, T5 ji zpřesní) = běh končí pravidlem,
 *   které čte čítač `score`. `grow_to` se nepočítá: v aréně (sběr, útěk) je
 *   `score` jen počítadlo sebraných věcí a výhra přijde vždy při témže čísle.
 *
 * Výstup je deterministický – žádné časy ani datum, jen verze kompilátoru –
 * takže nový běh bez změny kódu nechá `depth.json` v gitu čistý.
 */

import { readFileSync } from 'node:fs';

import { derivedSeeds, seedFrom } from '@/app/api/play/_publish';
import { ARCADE_COMPILER_VERSION, arcadeWorldOf } from '@/play/arcade/compile';
import { ARCADE_HZ, ARCADE_LIMITS, type ArcadeWorld, COUNTER, HEADER, type InputEvent, NO_INPUT, type PieceRef, bodyHp } from '@/play/arcade/contract';
import { instantiate, loadProgram, outcomeOf, step } from '@/play/arcade/kernel';
import { ARCADE_LIBRARY } from '@/play/arcade/library';
import { releasePhysics } from '@/play/arcade/physics/step';
import { loadRapier } from '@/play/arcade/physics/world';
import { type ArcadeVerdict, verifyArcade } from '@/play/arcade/verify';
import { draftGameSpecWithMeta, readNumbers } from '@/play/draft';
import { NUMBER_WORDS } from '@/play/draft/lexicon';

/** Cíle plánu P36A (řádek Goal) – podíl ze všech 260 vět. Pin test je drží jako cíl, ne jako dnešní stav. */
export const DEPTH_TARGETS = { inBandShare: 0.85, idleLosesShare: 0.95, livesOver1Share: 0.8 } as const;

/** Pásmo délky hry pro perfektního robota (spec `docs/specs/2026-10-01-hloubka-her.md`). */
export const BAND_SECONDS = { min: 30, max: 90 } as const;

export type DepthSet = 'demand' | 'dev';
export type RunEnd = 'won' | 'lost' | 'unfinished';

export interface DepthSentence {
  readonly set: DepthSet;
  readonly id: string;
  readonly text: string;
}

export interface DepthRow extends DepthSentence {
  /** `runner`, `platformer`, `arena.collect`, `quest.station`, …; `control:<id>` = stará hra bez žánru, `grid` = mřížka. */
  readonly genre: string;
  /** Semínko, na kterém by hra vyšla (`null` = žádné ze čtyř, hra se nepustí). */
  readonly seed: number | null;
  /** Robot vyhrál a nečinný hráč nevyhrál – publikace by hru zkompilovala. */
  readonly playable: boolean;
  /** Navíc prošly všechny kontroly `verifyArcade` (replay, meze, slovesa). */
  readonly publishable: boolean;
  /** Nálezy `verifyArcade` nebo důvod, proč svět nevznikl; prázdné = nic. */
  readonly failures: readonly string[];
  readonly bot: { readonly end: RunEnd; readonly tick: number };
  /** Sekundy do výhry robota; `null` = robot nevyhrál. */
  readonly winSeconds: number | null;
  readonly inBand: boolean;
  readonly idle: { readonly end: RunEnd; readonly tick: number };
  readonly lives: number;
  readonly livesFrom: 'counter' | 'hp' | 'none';
  /** Čítač `score` na konci robotova běhu. */
  readonly botScore: number | null;
  readonly scoreDecides: boolean;
  /** Pravidlo, které výsledek čte ze skóre (`rule:<verb> >= N`); `null` = žádné. */
  readonly scoreGoal: string | null;
  /** Číslo z věty: životy, cílové skóre, sekundy (`null` = věta ho neříká). */
  readonly said: { readonly lives: number | null; readonly score: number | null; readonly seconds: number | null };
  /** Nese hra číslo z věty? `null` = věta ho neříká. */
  readonly carried: { readonly lives: boolean | null; readonly score: boolean | null; readonly seconds: boolean | null };
}

export interface GenreSummary {
  readonly sentences: number;
  readonly medianWinSeconds: number | null;
  readonly minWinSeconds: number | null;
  readonly maxWinSeconds: number | null;
  readonly inBand: number;
  readonly idleLoses: number;
  readonly livesOver1: number;
}

export interface SetSummary {
  readonly sentences: number;
  readonly playable: number;
  readonly publishable: number;
  readonly inBand: number;
  readonly inBandShare: number;
  readonly idle: Readonly<Record<RunEnd, number>>;
  readonly idleLosesShare: number;
  readonly livesOver1: number;
  readonly livesOver1Share: number;
  readonly scoreDecides: number;
  readonly scoreDecidesShare: number;
  readonly numbers: Readonly<Record<'lives' | 'score' | 'seconds', { readonly said: number; readonly carried: number }>>;
  readonly byGenre: Readonly<Record<string, GenreSummary>>;
}

export interface DepthReport {
  readonly compilerVersion: string;
  readonly bandSeconds: typeof BAND_SECONDS;
  readonly targets: typeof DEPTH_TARGETS;
  readonly summary: { readonly all: SetSummary; readonly demand: SetSummary; readonly dev: SetSummary };
  readonly rows: readonly DepthRow[];
}

// ---------------------------------------------------------------------------
// Věty

const readJson = (relative: string): unknown => JSON.parse(readFileSync(new URL(relative, import.meta.url), 'utf8'));

/** Obě sady v pořadí souborů; vývojová sada sdílí s poptávkou 20 vět, proto klíč `set:id`. */
export function depthSentences(): DepthSentence[] {
  const demand = readJson('../demand/corpus.json') as readonly { readonly id: string; readonly text: string }[];
  const dev = (readJson('../p30/dev.json') as { readonly sentences: readonly { readonly id: string; readonly text: string }[] }).sentences;
  return [...demand.map(({ id, text }) => ({ set: 'demand' as const, id, text })), ...dev.map(({ id, text }) => ({ set: 'dev' as const, id, text }))];
}

// ---------------------------------------------------------------------------
// Čísla z věty

const NUMBER = `(\\d+|no|${Object.keys(NUMBER_WORDS).join('|')})`;
const LIVES_SAID = new RegExp(`\\b${NUMBER}\\s+(?:extra\\s+)?(?:lives|life|hearts?)\\b`);
const SCORE_SAID = [new RegExp(`\\b${NUMBER}\\s+points?\\b`), new RegExp(`\\bscore\\s+(?:of\\s+)?${NUMBER}\\b`)];

/** „no lives“ = jeden pokus (týž výklad jako T2). */
const valueOf = (token: string): number => (token === 'no' ? 1 : /^\d+$/.test(token) ? Number(token) : (NUMBER_WORDS[token] as number));

export function saidNumbers(text: string): DepthRow['said'] {
  const lower = text.toLowerCase();
  const lives = LIVES_SAID.exec(lower);
  const score = SCORE_SAID.map((pattern) => pattern.exec(lower)).find((match) => match !== null && match[1] !== 'no');
  return {
    lives: lives === null ? null : valueOf(lives[1] as string),
    score: score === undefined || score === null ? null : valueOf(score[1] as string),
    seconds: readNumbers(text).seconds,
  };
}

// ---------------------------------------------------------------------------
// Svět

interface CompiledRuleLike {
  readonly verb?: string;
  readonly when?: { readonly counter?: { readonly name?: string; readonly atLeast?: number } };
  readonly if?: readonly { readonly counter?: { readonly name?: string; readonly atLeast?: number } }[];
  readonly do?: readonly Record<string, unknown>[];
}

/** Pravidlo, které běh ukončí podle čítače `score` (definice T1); `grow_to` je počítadlo věcí, ne skóre. */
export function scoreGoalOf(rules: readonly PieceRef[]): { readonly label: string; readonly points: number | null } | null {
  for (const ref of rules) {
    const rule = ref.params as CompiledRuleLike;
    const ends = (rule.do ?? []).some((effect) => 'win' in effect || 'lose' in effect);
    const onScore = rule.when?.counter?.name === 'score' ? rule.when.counter : rule.if?.find((cond) => cond.counter?.name === 'score')?.counter;
    if (ends && onScore !== undefined) return { label: `rule:${rule.verb ?? ref.id} >= ${String(onScore.atLeast ?? 0)}`, points: onScore.atLeast ?? null };
  }
  return null;
}

function livesOf(world: ArcadeWorld): { readonly lives: number; readonly livesFrom: DepthRow['livesFrom'] } {
  const initial = Int32Array.from(world.initial);
  const counter = initial[HEADER.counters + COUNTER.health] as number;
  if (counter > 0) return { lives: counter, livesFrom: 'counter' };
  const hp = bodyHp(initial, initial[HEADER.player] as number);
  return hp > 0 ? { lives: hp, livesFrom: 'hp' } : { lives: 1, livesFrom: 'none' };
}

/** Čítač `score` na konci přehrání záznamu (táž smyčka jako `replay` v jádře). */
function scoreAfter(world: ArcadeWorld, inputs: readonly InputEvent[]): number {
  const program = loadProgram(world, ARCADE_LIBRARY);
  const state = instantiate(world);
  let next = 0;
  for (let tick = 0; tick < ARCADE_LIMITS.maxTicks && outcomeOf(state) === 'running'; tick += 1) {
    while (next < inputs.length && (inputs[next] as InputEvent).tick < tick) next += 1;
    const event = inputs[next];
    step(state, event !== undefined && event.tick === tick ? event : NO_INPUT, program);
  }
  releasePhysics(state);
  return state[HEADER.counters + COUNTER.score] as number;
}

const endOf = (outcome: 'running' | 'won' | 'lost'): RunEnd => (outcome === 'running' ? 'unfinished' : outcome);
const round2 = (value: number): number => Math.round(value * 100) / 100;

/** Řádek pro větu, jejíž svět nevznikl nebo není arkádový. */
function deadRow(sentence: DepthSentence, genre: string, failures: readonly string[], said: DepthRow['said']): DepthRow {
  const none = { lives: said.lives === null ? null : false, score: said.score === null ? null : false, seconds: said.seconds === null ? null : false };
  return { ...sentence, genre, seed: null, playable: false, publishable: false, failures, bot: { end: 'unfinished', tick: 0 }, winSeconds: null, inBand: false, idle: { end: 'unfinished', tick: 0 }, lives: 0, livesFrom: 'none', botScore: null, scoreDecides: false, scoreGoal: null, said, carried: none };
}

interface SeedRun {
  readonly seed: number;
  readonly world: ArcadeWorld;
  readonly verdict: ArcadeVerdict;
}

export function measureSentence(sentence: DepthSentence): DepthRow {
  const said = saidNumbers(sentence.text);
  const meta = draftGameSpecWithMeta(sentence.text, 1);
  const { spec } = meta;
  const genre = spec.genre !== undefined ? (spec.genre.mode === 'default' ? spec.genre.id : `${spec.genre.id}.${spec.genre.mode}`) : spec.control === undefined || spec.control === 'tap_go' ? 'grid' : `control:${spec.control}`;
  if (genre === 'grid') return deadRow(sentence, genre, ['the draft fell back to the grid game – no arcade world to measure'], said);

  // Táž výhybka jako `compileOnSeeds`: další semínko jen tehdy, když robot nevyhrál nebo nečinný vyhrál.
  let chosen: SeedRun | null = null;
  let last: SeedRun | null = null;
  for (const seed of derivedSeeds(seedFrom(sentence.text.trim()))) {
    const made = arcadeWorldOf(spec, seed);
    if (!made.ok) return deadRow(sentence, genre, made.issues, said);
    const verdict = verifyArcade(made.world);
    last = { seed, world: made.world, verdict };
    if (verdict.bot.outcome === 'won' && verdict.idle.outcome !== 'won') {
      chosen = last;
      break;
    }
  }
  // `derivedSeeds` vrací vždy čtyři semínka, takže `last` po smyčce není `null`.
  const run = (chosen ?? last) as SeedRun;
  const { verdict, world } = run;
  const won = verdict.bot.outcome === 'won';
  const winSeconds = won ? round2(verdict.bot.tick / ARCADE_HZ) : null;
  const { lives, livesFrom } = livesOf(world);
  const goal = scoreGoalOf(world.rules);
  const timed = world.rules.some((ref) => (ref.id === 'time_limit' || ref.id === 'survive_time') && ref.params.seconds === said.seconds);
  return {
    ...sentence,
    genre,
    seed: chosen === null ? null : run.seed,
    playable: chosen !== null,
    publishable: chosen !== null && verdict.publishEligible,
    failures: verdict.failures,
    bot: { end: endOf(verdict.bot.outcome), tick: verdict.bot.tick },
    winSeconds,
    inBand: winSeconds !== null && winSeconds >= BAND_SECONDS.min && winSeconds <= BAND_SECONDS.max,
    idle: { end: endOf(verdict.idle.outcome), tick: verdict.idle.tick },
    lives,
    livesFrom,
    botScore: won ? scoreAfter(world, verdict.bot.inputs) : null,
    scoreDecides: goal !== null,
    scoreGoal: goal?.label ?? null,
    said,
    carried: {
      lives: said.lives === null ? null : said.lives === lives,
      score: said.score === null ? null : goal?.points === said.score,
      seconds: said.seconds === null ? null : timed,
    },
  };
}

// ---------------------------------------------------------------------------
// Souhrn

const share = (count: number, total: number): number => (total === 0 ? 0 : Math.round((count / total) * 1000) / 1000);

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? (sorted[middle] as number) : round2(((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2);
}

function genreSummary(rows: readonly DepthRow[]): GenreSummary {
  const wins = rows.flatMap((row) => (row.winSeconds === null ? [] : [row.winSeconds]));
  return {
    sentences: rows.length,
    medianWinSeconds: median(wins),
    minWinSeconds: wins.length === 0 ? null : Math.min(...wins),
    maxWinSeconds: wins.length === 0 ? null : Math.max(...wins),
    inBand: rows.filter((row) => row.inBand).length,
    idleLoses: rows.filter((row) => row.idle.end === 'lost').length,
    livesOver1: rows.filter((row) => row.lives > 1).length,
  };
}

export function summarize(rows: readonly DepthRow[]): SetSummary {
  const count = (test: (row: DepthRow) => boolean): number => rows.filter(test).length;
  const total = rows.length;
  const inBand = count((row) => row.inBand);
  const idle = { won: count((row) => row.idle.end === 'won'), lost: count((row) => row.idle.end === 'lost'), unfinished: count((row) => row.idle.end === 'unfinished') };
  const livesOver1 = count((row) => row.lives > 1);
  const scoreDecides = count((row) => row.scoreDecides);
  const numbers = (key: 'lives' | 'score' | 'seconds') => ({ said: count((row) => row.said[key] !== null), carried: count((row) => row.carried[key] === true) });
  const genres = [...new Set(rows.map((row) => row.genre))].sort();
  return {
    sentences: total,
    playable: count((row) => row.playable),
    publishable: count((row) => row.publishable),
    inBand,
    inBandShare: share(inBand, total),
    idle,
    idleLosesShare: share(idle.lost, total),
    livesOver1,
    livesOver1Share: share(livesOver1, total),
    scoreDecides,
    scoreDecidesShare: share(scoreDecides, total),
    numbers: { lives: numbers('lives'), score: numbers('score'), seconds: numbers('seconds') },
    byGenre: Object.fromEntries(genres.map((genre) => [genre, genreSummary(rows.filter((row) => row.genre === genre))])),
  };
}

export function summaries(rows: readonly DepthRow[]): DepthReport['summary'] {
  return { all: summarize(rows), demand: summarize(rows.filter((row) => row.set === 'demand')), dev: summarize(rows.filter((row) => row.set === 'dev')) };
}

/** Celé měření; Rapier se načte předem, protože jádro je synchronní a fyzikální svět bez něj robot neodehraje. */
export async function measureDepth(): Promise<DepthReport> {
  await loadRapier();
  const rows = depthSentences().map(measureSentence);
  return { compilerVersion: ARCADE_COMPILER_VERSION, bandSeconds: BAND_SECONDS, targets: DEPTH_TARGETS, summary: summaries(rows), rows };
}
