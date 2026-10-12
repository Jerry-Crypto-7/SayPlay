/**
 * Úseky a průběh tří žánrů (P46B T1): věty panelu P45 v buňkách běžec, řízení
 * a skákačka + 12 vět `sentences.json`, každá na semínku, které vybere
 * publikace (`publishedWorld`, táž cesta jako `/play`). Robot `intermediate`
 * odehraje hru; z jeho běhu telemetrie P45A (mrtvý čas, stoupání, finále,
 * chování) a měřidlo úseků (`segments.ts`).
 *
 * `P46B_OUT=baseline|after npx vitest run --config vitest.measure.mts evals/play/p46b/segments.measure.ts`
 * Výstup nemá čas ani datum, takže nový běh bez změny kódu nechá git čistý.
 */

import { readFileSync, writeFileSync } from 'node:fs';

import { expect, it } from 'vitest';

import { ARCADE_COMPILER_VERSION } from '@/play/arcade/compile';
import { funMetrics, traceRun } from '@/play/arcade/telemetry';
import { runBot } from '@/play/arcade/verify';

import { funSentences, publishedWorld } from '../p45/fun';
import { segmentRun } from './segments';

/** Žánr rychlého návrhu (`genreOf` v `p45/fun.ts`) → buňka P46B. */
export const CELLS: Readonly<Record<string, string>> = { runner: 'runner', 'control:steer': 'steer', platformer: 'platformer' };

interface Row {
  readonly id: string;
  readonly text: string;
  /** Buňka, do které věta patří (panel podle žánru P45, nové věty podle `sentences.json`). */
  readonly cell: string;
  /** Žánr, který rychlý návrh opravdu postavil. */
  readonly genre: string;
  readonly seed: number | null;
  readonly playable: boolean;
  readonly deadTimeS: number | null;
  readonly rising: boolean | null;
  readonly finale: boolean | null;
  readonly behaviours: number | null;
  readonly segmentChanges: number | null;
  readonly changes: readonly (readonly string[])[];
  readonly issues: readonly string[];
}

const round = (value: number): number => Math.round(value * 100) / 100;
function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return round(sorted.length % 2 === 1 ? (sorted[mid] as number) : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2);
}
const share = (flags: readonly boolean[]): number | null => (flags.length === 0 ? null : round(flags.filter(Boolean).length / flags.length));

async function rowOf(id: string, text: string, cell: string): Promise<Row> {
  const { genre, seed, playable, world, issues } = await publishedWorld(text);
  const empty = { deadTimeS: null, rising: null, finale: null, behaviours: null, segmentChanges: null, changes: [] };
  if (world === null) return { id, text, cell, genre, seed, playable, ...empty, issues };
  const bot = runBot(world, undefined, { profile: 'intermediate' });
  const metrics = funMetrics(traceRun(world, bot.inputs));
  const segments = segmentRun(world, bot.inputs);
  return {
    id, text, cell, genre, seed, playable,
    deadTimeS: metrics.longestGapS, rising: metrics.rising, finale: metrics.finale.present, behaviours: metrics.behaviourCount,
    segmentChanges: segments.segmentChanges, changes: segments.changes, issues,
  };
}

it('measures segments and pacing of the runner, steer and platformer cells', async () => {
  const out = process.env.P46B_OUT ?? 'baseline';
  const own = (JSON.parse(readFileSync('evals/play/p46b/sentences.json', 'utf8')) as { sentences: { id: string; cell: string; text: string }[] }).sentences;
  const rows: Row[] = [];
  for (const sentence of funSentences('panel')) {
    const draft = await publishedWorld(sentence.text);
    const cell = CELLS[draft.genre];
    if (cell !== undefined) rows.push(await rowOf(sentence.id, sentence.text, cell));
  }
  for (const sentence of own) rows.push(await rowOf(sentence.id, sentence.text, sentence.cell));
  // Souhrn jen nad hratelnými hrami, které opravdu postavily žánr své buňky (jako souhrn zábavy P45).
  const cells = Object.fromEntries(['runner', 'steer', 'platformer'].map((cell) => {
    const all = rows.filter((row) => row.cell === cell);
    const played = all.filter((row) => row.playable && row.deadTimeS !== null && CELLS[row.genre] === cell);
    return [cell, {
      sentences: all.length,
      playable: played.length,
      offGenre: all.filter((row) => CELLS[row.genre] !== cell).map((row) => `${row.id}:${row.genre}`),
      deadTimeMedianS: median(played.map((row) => row.deadTimeS as number)),
      risingShare: share(played.map((row) => row.rising === true)),
      finaleShare: share(played.map((row) => row.finale === true)),
      behavioursMedian: median(played.map((row) => row.behaviours as number)),
      segmentChangesMedian: median(played.map((row) => row.segmentChanges as number)),
      segmentChanges2Share: share(played.map((row) => (row.segmentChanges ?? 0) >= 2)),
    }];
  }));
  writeFileSync(`evals/play/p46b/${out}.json`, `${JSON.stringify({ schema: 'p46b-segments.v1', compiler: ARCADE_COMPILER_VERSION, profile: 'intermediate', cells, rows }, null, 1)}\n`);
  expect(rows.length).toBeGreaterThanOrEqual(own.length);
});
