/**
 * Zpráva zábavy P45 nad sadou: `P45_SET=panel|sealed P45_OUT=<soubor>
 * npx vitest run --config vitest.measure.mts evals/play/p45/fun.measure.ts`.
 * Výstup nemá čas ani datum, takže nový běh bez změny kódu nechá git čistý.
 */

import { writeFileSync } from 'node:fs';

import { expect, it } from 'vitest';

import { ARCADE_COMPILER_VERSION } from '@/play/arcade/compile';

import { FUN_SETS, type FunRow, type FunSet, funRow, funSentences, funSummary } from './fun';

it('measures the fun of every sentence in the set', async () => {
  const set = process.env.P45_SET as FunSet;
  const out = process.env.P45_OUT;
  if (!(set in FUN_SETS) || out === undefined) throw new Error('p45: set P45_SET=panel|sealed and P45_OUT=<file>');
  const rows: FunRow[] = [];
  for (const sentence of funSentences(set)) rows.push(await funRow(sentence));
  const summary = funSummary(rows);
  writeFileSync(out, `${JSON.stringify({ schema: 'p45-fun.v1', set, compiler: ARCADE_COMPILER_VERSION, profile: 'intermediate', summary, rows }, null, 1)}\n`);
  expect(rows).toHaveLength(summary.n);
});
