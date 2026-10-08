import { writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';

import { expect, it } from 'vitest';

import { arcadeWorldOf, preloadPhysics } from '@/play/arcade/compile';
import { ARCADE_HZ } from '@/play/arcade/contract';
import { ARCADE_LIBRARY } from '@/play/arcade/library';
import { loadRapier } from '@/play/arcade/physics/world';
import { runBot, verifyArcade } from '@/play/arcade/verify';
import { assemblyOfCell, liveCells } from '@/play/compose/allowed';
import { compileRecipe } from '@/play/compose/compile';

import { behavioursOf, finaleOf, pressureRun, quantile, risingOf, type Thirds } from './pacing';

/** Výstup: `P45C_OUT=after npx vitest run --config vitest.measure.mts evals/play/p45c/pacing.measure.ts` zapíše `after.json`. */
const OUT = process.env.P45C_OUT ?? 'baseline';
const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8] as const;
const round = (value: number): number => Math.round(value * 100) / 100;
const roundThirds = (thirds: Thirds): number[] => thirds.map(round);

interface Row {
  readonly cell: string;
  readonly seed: number;
  readonly threatsPerThird: number[];
  readonly countPerThird: number[];
  readonly rising: boolean;
  readonly finale: boolean;
  readonly behaviours: number;
  readonly behaviourNames: readonly string[];
  readonly winSeconds: number | null;
  readonly noviceWon: boolean;
  readonly intermediateWon: boolean;
  readonly idleWon: boolean;
  readonly replayEqual: boolean;
  readonly buildMs: number;
  readonly error: string | null;
}

it('measures pacing for every live cell over eight seeds', async () => {
  const rows: Row[] = [];
  for (const cell of liveCells()) for (const seed of SEEDS) {
    try {
      await preloadPhysics(compileRecipe(assemblyOfCell(cell)), loadRapier);
      const started = performance.now();
      const spec = compileRecipe(assemblyOfCell(cell));
      const made = arcadeWorldOf(spec, seed);
      if (!made.ok) throw new Error(made.issues.join('; '));
      const verdict = verifyArcade(made.world, ARCADE_LIBRARY, made.roleBindings);
      const buildMs = performance.now() - started;
      const intermediate = runBot(made.world, ARCADE_LIBRARY, { profile: 'intermediate' });
      const novice = runBot(made.world, ARCADE_LIBRARY, { profile: 'novice' });
      const run = pressureRun(made.world, intermediate.inputs);
      const names = behavioursOf(made.world);
      rows.push({
        cell: cell.id, seed, threatsPerThird: roundThirds(run.threatsPerThird), countPerThird: roundThirds(run.countPerThird), rising: risingOf(run.threatsPerThird),
        finale: finaleOf(made.world), behaviours: names.length, behaviourNames: names,
        winSeconds: intermediate.outcome === 'won' ? round(intermediate.tick / ARCADE_HZ) : null,
        noviceWon: novice.outcome === 'won', intermediateWon: intermediate.outcome === 'won', idleWon: verdict.idle.outcome === 'won',
        replayEqual: run.hash === intermediate.hash && verdict.replayEqual, buildMs: round(buildMs), error: null,
      });
    } catch (error) {
      rows.push({ cell: cell.id, seed, threatsPerThird: [], countPerThird: [], rising: false, finale: false, behaviours: 0, behaviourNames: [], winSeconds: null, noviceWon: false, intermediateWon: false, idleWon: false, replayEqual: false, buildMs: 0, error: String(error) });
    }
  }
  const share = (count: number, of: number): number => round(of === 0 ? 0 : count / of);
  const cells = liveCells().map((cell) => {
    const runs = rows.filter((row) => row.cell === cell.id);
    const wins = runs.filter((row) => row.winSeconds !== null).map((row) => row.winSeconds as number);
    return {
      cell: cell.id, rising: runs.filter((row) => row.rising).length, finale: runs.some((row) => row.finale), behaviours: runs[0]?.behaviourNames ?? [],
      novice: share(runs.filter((row) => row.noviceWon).length, runs.length), intermediate: share(runs.filter((row) => row.intermediateWon).length, runs.length),
      idleWins: runs.filter((row) => row.idleWon).length, replayMismatches: runs.filter((row) => !row.replayEqual).length, errors: runs.filter((row) => row.error !== null).length,
      medianWinSeconds: wins.length === 0 ? null : quantile(wins, 0.5),
    };
  });
  const wins = rows.filter((row) => row.winSeconds !== null).map((row) => row.winSeconds as number);
  const summary = {
    games: rows.length,
    risingShare: share(rows.filter((row) => row.rising).length, rows.length),
    finaleShare: share(rows.filter((row) => row.finale).length, rows.length),
    behavioursMedian: quantile(rows.map((row) => row.behaviours), 0.5),
    noviceBand: { min: 0.3, max: 0.7, cellsOutside: cells.filter((cell) => cell.novice < 0.3 || cell.novice > 0.7).map((cell) => cell.cell) },
    intermediateMin: { min: 0.8, cellsBelow: cells.filter((cell) => cell.intermediate < 0.8).map((cell) => cell.cell) },
    lengthBandShare: share(wins.filter((seconds) => seconds >= 30 && seconds <= 90).length, wins.length),
    idleWins: rows.filter((row) => row.idleWon).length,
    replayEqualShare: share(rows.filter((row) => row.replayEqual).length, rows.length),
    buildMsP95: round(quantile(rows.map((row) => row.buildMs), 0.95)),
    errors: rows.filter((row) => row.error !== null).length,
  };
  writeFileSync(`evals/play/p45c/${OUT}.json`, `${JSON.stringify({ version: 1, seeds: SEEDS, summary, cells, rows }, null, 2)}\n`);
  expect(rows).toHaveLength(liveCells().length * SEEDS.length);
}, 60 * 60_000);
