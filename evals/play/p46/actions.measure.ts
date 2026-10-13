/**
 * Měřidlo „sloveso → akce“ P46A nad panelem P45 a 20 větami akcí:
 * `P46_OUT=<soubor> npx vitest run --config vitest.measure.mts evals/play/p46/actions.measure.ts`
 * (bez `P46_OUT` zapíše `evals/play/p46/actions-baseline.json`). Výstup nemá čas
 * ani datum, takže nový běh bez změny kódu nechá git čistý.
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, it } from 'vitest';

import { ARCADE_COMPILER_VERSION } from '@/play/arcade/compile';

import { type ActionRow, P46_DIR, actionRow, actionSentences, actionSummary } from './actions';

it('measures whether each sentence gets the action its verb asks for', async () => {
  const out = process.env.P46_OUT ?? join(P46_DIR, 'actions-baseline.json');
  const rows: ActionRow[] = [];
  for (const sentence of actionSentences()) rows.push(await actionRow(sentence));
  const summary = actionSummary(rows);
  writeFileSync(out, `${JSON.stringify({ schema: 'p46-actions.v1', compiler: ARCADE_COMPILER_VERSION, profile: 'intermediate', summary, rows }, null, 1)}\n`);
  expect(rows).toHaveLength(summary.n);
});
