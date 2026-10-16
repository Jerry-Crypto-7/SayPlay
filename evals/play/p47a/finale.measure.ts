/**
 * Gauge finále P47A nad vývojovou sadou (`dev.json`) a panelem P45: řádek na
 * větu (`finale.ts`) a souhrn po žánrech zvlášť pro dev, panel a oba dohromady.
 * Holdout (`holdout.json`) jen s `P47A_HOLDOUT=1` (konečné měření T12): otisk
 * se ověří dřív, než se věty přečtou, a zapíše se do výstupu. Zapečetěnou sadu
 * P45 nečte nikdy.
 *
 * `P47A_OUT=baseline|after npx vitest run --config vitest.measure.mts evals/play/p47a/finale.measure.ts`
 * Výstup nemá čas ani datum, takže nový běh bez změny kódu nechá git čistý.
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

import { expect, it } from 'vitest';

import { GENRE_COMPILER_VERSION } from '@/play/genre/contract';

import { funSentences } from '../p45/fun';
import { type FinaleRow, finaleRow, genreSummary } from './finale';

/** SHA-256 nad LF bajty `holdout.json` ze vzniku sady (README, `__tests__/sets.test.ts`). */
const HOLDOUT_SHA256 = '7f62855dd8f45ad6ab1f050aea403ad76030b5c9163c6bedef643cdddbd9bd79';

/** Věty holdoutu, jen když otisk sedí – jinak sada není ta, kterou nikdo neviděl. */
function holdoutSentences(): { sha256: string; sentences: { id: string; text: string }[] } {
  const bytes = readFileSync('evals/play/p47a/holdout.json', 'utf8').replace(/\r\n/g, '\n');
  const sha256 = createHash('sha256').update(bytes, 'utf8').digest('hex');
  if (sha256 !== HOLDOUT_SHA256) throw new Error(`p47a: holdout.json SHA-256 ${sha256} is not the sealed ${HOLDOUT_SHA256}`);
  return { sha256, sentences: (JSON.parse(bytes) as { sentences: { id: string; text: string }[] }).sentences };
}

it('measures finale, pacing and dead time on the dev set and the P45 panel (and the holdout with P47A_HOLDOUT=1)', async () => {
  const out = process.env.P47A_OUT ?? 'baseline';
  const holdout = process.env.P47A_HOLDOUT === '1' ? holdoutSentences() : null;
  const dev = (JSON.parse(readFileSync('evals/play/p47a/dev.json', 'utf8')) as { sentences: { id: string; cell: string; text: string }[] }).sentences;
  const devRows: FinaleRow[] = [];
  for (const sentence of dev) devRows.push(await finaleRow(sentence.id, sentence.text, sentence.cell));
  const panelRows: FinaleRow[] = [];
  for (const sentence of funSentences('panel')) panelRows.push(await finaleRow(sentence.id, sentence.text));
  const holdoutRows: FinaleRow[] = [];
  for (const sentence of holdout?.sentences ?? []) holdoutRows.push(await finaleRow(sentence.id, sentence.text));
  const summary = { dev: genreSummary(devRows), panel: genreSummary(panelRows), both: genreSummary([...devRows, ...panelRows]), ...(holdout === null ? {} : { holdout: genreSummary(holdoutRows) }) };
  const rows = { dev: devRows, panel: panelRows, ...(holdout === null ? {} : { holdout: holdoutRows }) };
  const sealed = holdout === null ? {} : { holdoutSha256: holdout.sha256 };
  writeFileSync(`evals/play/p47a/${out}.json`, `${JSON.stringify({ schema: 'p47a-finale.v1', compiler: GENRE_COMPILER_VERSION, profile: 'intermediate', ...sealed, summary, rows }, null, 1)}\n`);
  expect(devRows).toHaveLength(dev.length);
  expect(holdoutRows).toHaveLength(holdout?.sentences.length ?? 0);
});
