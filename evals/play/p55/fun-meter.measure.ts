/**
 * P45 fun meter nad pruhovými žánry (P55 T8): cíle dev sady P54C po žánrech, robot `intermediate`,
 * souhrn `funSummary` pro každý žánr zvlášť. Brána T8: mrtvý čas (medián `longestGapS`) ≤ 3 s
 * a podíl her s rostoucí intenzitou ≥ 0,70 v každém ze čtyř žánrů.
 * `npx vitest run --config vitest.measure.mts evals/play/p55/fun-meter.measure.ts`
 * Výstup nemá čas ani datum, takže nový běh bez změny kódu nechá git čistý.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, it } from 'vitest';

import { ARCADE_COMPILER_VERSION } from '@/play/arcade/compile';

import { type FunRow, funRow, funSummary } from '../p45/fun';

const GENRES = ['catch', 'whack', 'slice', 'defense'] as const;
const DIR = join(process.cwd(), 'evals', 'play', 'p55');

it('lane genres keep dead time at most 3 s and rise in at least 70 % of games', async () => {
  const sentences = (JSON.parse(readFileSync(join(process.cwd(), 'evals', 'play', 'p54c', 'dev.json'), 'utf8')) as { sentences: { id: string; text: string; family: string; expect: string }[] }).sentences;
  const genres = [];
  for (const genre of GENRES) {
    const rows: FunRow[] = [];
    for (const sentence of sentences.filter((entry) => entry.family === 'target' && entry.expect === `${genre}.default`)) rows.push(await funRow(sentence));
    genres.push({ genre, summary: funSummary(rows), rows });
  }
  writeFileSync(join(DIR, 'fun-meter.json'), `${JSON.stringify({ schema: 'p55-fun-meter.v1', compiler: ARCADE_COMPILER_VERSION, profile: 'intermediate', gate: 'deadTimeMedianS <= 3 and risingShare >= 0.70 per genre', genres }, null, 1)}\n`);
  for (const { genre, summary } of genres) {
    expect(summary.playable, genre).toBeGreaterThan(0);
    expect(summary.deadTimeMedianS, genre).toBeLessThanOrEqual(3);
    expect(summary.risingShare, genre).toBeGreaterThanOrEqual(0.7);
  }
});
