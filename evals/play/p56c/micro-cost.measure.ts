/**
 * Cena ověření mikroher (P56C T4) → `micro-cost.json`: ms celého `verifyArcade` (robot, nečinný, dvojí přehrání,
 * svědci, důkaz sloves) a levné cesty bez svědků (robot, nečinný, dvojí přehrání) na záznam `MICRO`.
 * Medián přes semínka × 3 opakování; stroj nikdy není v klidu (souběžné autopiloty), čísla jsou orientační.
 *
 * `npx vitest run --config vitest.measure.mts evals/play/p56c/micro-cost.measure.ts`
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { it } from 'vitest';

import { arcadeWorldOf } from '../../../src/play/arcade/compile';
import { replay } from '../../../src/play/arcade/kernel';
import { ARCADE_LIBRARY } from '../../../src/play/arcade/library';
import { runBot, verifyArcade } from '../../../src/play/arcade/verify';
import { MICRO, genreModeOf, microSpec } from '../../../src/play/chain/micro';
import { draftGenreFor } from '../../../src/play/draft/draft';

const SEEDS = [1, 2, 8, 9, 13, 20];
const REPEATS = 3;

const median = (values: readonly number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
};

const timed = (run: () => void): number => {
  const start = performance.now();
  run();
  return performance.now() - start;
};

it('measures verifyArcade per microgame', () => {
  const rows = MICRO.map((entry) => {
    const { genre, mode } = genreModeOf(entry);
    const spec = microSpec(draftGenreFor('a fox in a forest', genre, mode)!, entry, 0);
    const full: number[] = [];
    const cheap: number[] = [];
    for (let repeat = 0; repeat < REPEATS; repeat += 1) {
      for (const seed of SEEDS) {
        const made = arcadeWorldOf(spec, seed);
        if (!made.ok) throw new Error(`${entry.key}: ${made.issues.join('; ')}`);
        full.push(timed(() => verifyArcade(made.world, ARCADE_LIBRARY, made.roleBindings)));
        cheap.push(timed(() => {
          const bot = runBot(made.world);
          replay(made.world, [], ARCADE_LIBRARY);
          replay(made.world, bot.inputs, ARCADE_LIBRARY);
          replay(made.world, bot.inputs, ARCADE_LIBRARY);
        }));
      }
    }
    return { key: entry.key, control: entry.control, boss: entry.boss === true, verifyMs: Math.round(median(full)), verifyMaxMs: Math.round(Math.max(...full)), cheapMs: Math.round(median(cheap)) };
  });
  writeFileSync(join(process.cwd(), 'evals/play/p56c/micro-cost.json'), `${JSON.stringify({ measuredAt: new Date().toISOString(), seeds: SEEDS, repeats: REPEATS, rows }, null, 2)}\n`);
}, 1_800_000);
