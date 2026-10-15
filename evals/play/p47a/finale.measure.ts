/**
 * Gauge finále P47A nad vývojovou sadou (`dev.json`) a panelem P45: řádek na
 * větu (`finale.ts`) a souhrn po žánrech zvlášť pro dev, panel a oba dohromady.
 * Holdout ani zapečetěnou sadu P45 nečte.
 *
 * `P47A_OUT=baseline|after npx vitest run --config vitest.measure.mts evals/play/p47a/finale.measure.ts`
 * Výstup nemá čas ani datum, takže nový běh bez změny kódu nechá git čistý.
 */

import { readFileSync, writeFileSync } from 'node:fs';

import { expect, it } from 'vitest';

import { GENRE_COMPILER_VERSION } from '@/play/genre/contract';

import { funSentences } from '../p45/fun';
import { type FinaleRow, finaleRow, genreSummary } from './finale';

it('measures finale, pacing and dead time on the dev set and the P45 panel', async () => {
  const out = process.env.P47A_OUT ?? 'baseline';
  const dev = (JSON.parse(readFileSync('evals/play/p47a/dev.json', 'utf8')) as { sentences: { id: string; cell: string; text: string }[] }).sentences;
  const devRows: FinaleRow[] = [];
  for (const sentence of dev) devRows.push(await finaleRow(sentence.id, sentence.text, sentence.cell));
  const panelRows: FinaleRow[] = [];
  for (const sentence of funSentences('panel')) panelRows.push(await finaleRow(sentence.id, sentence.text));
  const summary = { dev: genreSummary(devRows), panel: genreSummary(panelRows), both: genreSummary([...devRows, ...panelRows]) };
  const rows = { dev: devRows, panel: panelRows };
  writeFileSync(`evals/play/p47a/${out}.json`, `${JSON.stringify({ schema: 'p47a-finale.v1', compiler: GENRE_COMPILER_VERSION, profile: 'intermediate', summary, rows }, null, 1)}\n`);
  expect(devRows).toHaveLength(dev.length);
});
