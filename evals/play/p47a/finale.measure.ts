/**
 * Gauge finále P47A nad vývojovou sadou (`dev.json`) a panelem P45: řádek na
 * větu (`finale.ts`) a souhrn po žánrech zvlášť pro dev, panel a oba dohromady.
 * Holdout (`holdout.json`) jen s `P47A_HOLDOUT=1` (konečné měření T12): otisk
 * se ověří dřív, než se věty přečtou, a zapíše se do výstupu. Zapečetěnou sadu
 * P45 nečte nikdy.
 *
 * `P47A_OUT=baseline|after npx vitest run --config vitest.measure.mts evals/play/p47a/finale.measure.ts`
 * Výstup nemá čas ani datum, takže nový běh bez změny kódu nechá git čistý.
 * `P47A_SET=p51` měří sady P51 (`evals/play/p51/dev.json`, holdout s otiskem P51) a píše do `evals/play/p51/<out>.json`.
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

import { expect, it } from 'vitest';

import { GENRE_COMPILER_VERSION } from '@/play/genre/contract';

import { funSentences } from '../p45/fun';
import { type FinaleRow, finaleRow, genreSummary } from './finale';

/** SHA-256 nad LF bajty `holdout.json` každé sady ze vzniku sady (README, `__tests__/sets.test.ts`). */
const HOLDOUT_SHA256: Readonly<Record<string, string>> = {
  p47a: '7f62855dd8f45ad6ab1f050aea403ad76030b5c9163c6bedef643cdddbd9bd79',
  p51: '3b36fe64a2d7864245799f62bf91ce8a0423c45c7900c36efa640f03db321352',
};

/** Věty holdoutu, jen když otisk sedí – jinak sada není ta, kterou nikdo neviděl. */
function holdoutSentences(set: string): { sha256: string; sentences: { id: string; text: string }[] } {
  const bytes = readFileSync(`evals/play/${set}/holdout.json`, 'utf8').replace(/\r\n/g, '\n');
  const sha256 = createHash('sha256').update(bytes, 'utf8').digest('hex');
  if (sha256 !== HOLDOUT_SHA256[set]) throw new Error(`${set}: holdout.json SHA-256 ${sha256} is not the sealed ${String(HOLDOUT_SHA256[set])}`);
  return { sha256, sentences: (JSON.parse(bytes) as { sentences: { id: string; text: string }[] }).sentences };
}

it('measures finale, pacing and dead time on the dev set and the P45 panel (and the holdout with P47A_HOLDOUT=1)', async () => {
  const out = process.env.P47A_OUT ?? 'baseline';
  const set = process.env.P47A_SET ?? 'p47a';
  if (HOLDOUT_SHA256[set] === undefined) throw new Error(`P47A_SET=${set}: no such set`);
  const holdout = process.env.P47A_HOLDOUT === '1' ? holdoutSentences(set) : null;
  const dev = (JSON.parse(readFileSync(`evals/play/${set}/dev.json`, 'utf8')) as { sentences: { id: string; cell: string; text: string }[] }).sentences;
  const devRows: FinaleRow[] = [];
  for (const sentence of dev) devRows.push(await finaleRow(sentence.id, sentence.text, sentence.cell));
  const panelRows: FinaleRow[] = [];
  for (const sentence of funSentences('panel')) panelRows.push(await finaleRow(sentence.id, sentence.text));
  const holdoutRows: FinaleRow[] = [];
  for (const sentence of holdout?.sentences ?? []) holdoutRows.push(await finaleRow(sentence.id, sentence.text));
  const summary = { dev: genreSummary(devRows), panel: genreSummary(panelRows), both: genreSummary([...devRows, ...panelRows]), ...(holdout === null ? {} : { holdout: genreSummary(holdoutRows) }) };
  const rows = { dev: devRows, panel: panelRows, ...(holdout === null ? {} : { holdout: holdoutRows }) };
  const sealed = holdout === null ? {} : { holdoutSha256: holdout.sha256 };
  writeFileSync(`evals/play/${set}/${out}.json`, `${JSON.stringify({ schema: 'p47a-finale.v1', compiler: GENRE_COMPILER_VERSION, profile: 'intermediate', ...sealed, summary, rows }, null, 1)}\n`);
  expect(devRows).toHaveLength(dev.length);
  expect(holdoutRows).toHaveLength(holdout?.sentences.length ?? 0);
});
