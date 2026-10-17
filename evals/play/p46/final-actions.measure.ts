// Dočasné (T8 P46E): měřidlo akcí P46A nad zapečetěnou sadou P45, týž běh jako `fun --open-sealed-once`.
import { writeFileSync } from 'node:fs';

import { expect, it } from 'vitest';

import { funSentences } from '../p45/fun';

import { type ActionRow, actionRow, actionSummary } from './actions';

it('measures verb -> action over the sealed set', async () => {
  const out = process.env.P46_OUT;
  if (out === undefined) throw new Error('P46_OUT');
  const rows: ActionRow[] = [];
  for (const sentence of funSentences('sealed')) rows.push(await actionRow(sentence));
  const summary = actionSummary(rows);
  writeFileSync(out, `${JSON.stringify({ schema: 'p46-actions.v1', set: 'p45-sealed', profile: 'intermediate', summary, rows }, null, 1)}\n`);
  expect(rows).toHaveLength(summary.n);
});
