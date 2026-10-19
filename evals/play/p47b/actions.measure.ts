/**
 * Měřidlo akcí P47B: `P47B_SET=dev|p46a|holdout P47B_OUT=<soubor> npx vitest run
 * --config vitest.measure.mts evals/play/p47b/actions.measure.ts`. Holdout jen
 * s `P47B_OPEN_HOLDOUT=1` (T12). Výstup nemá datum; `draftMs` je čas stroje, takže
 * se mezi běhy hýbe i beze změny kódu.
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, it } from 'vitest';

import { ARCADE_COMPILER_VERSION } from '@/play/arcade/compile';

import { P47B_DIR, P52_DIR, type VerbRow, type VerbSet, verbRow, verbSentences, verbSummary } from './actions';

it('measures whether each labelled sentence gets, uses and proves its action', async () => {
  const set = (process.env.P47B_SET ?? 'dev') as VerbSet;
  // P52 (T2): sady `p52` a `p52-holdout` píší do `evals/play/p52/`; holdout jen s `P52_OPEN_HOLDOUT=1`.
  const out = process.env.P47B_OUT ?? (set.startsWith('p52') ? join(P52_DIR, `${set}.json`) : join(P47B_DIR, `baseline-${set}.json`));
  const rows: VerbRow[] = [];
  for (const sentence of verbSentences(set)) rows.push(await verbRow(sentence));
  const summary = verbSummary(rows);
  writeFileSync(out, `${JSON.stringify({ schema: 'p47b-actions.v1', set, compiler: ARCADE_COMPILER_VERSION, profile: 'intermediate', summary, rows }, null, 1)}\n`);
  expect(rows).toHaveLength(summary.n);
}, 1_800_000);
