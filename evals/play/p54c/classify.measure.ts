/**
 * Kam padají věty dev sady P54C (T2 baseline, T13 měření po klasifikátoru).
 *
 * ```
 * P54C_OUT=baseline npx vitest run --config vitest.measure.mts evals/play/p54c/classify.measure.ts
 * npx vitest run --config vitest.measure.mts evals/play/p54c/classify.measure.ts
 * ```
 *
 * `baseline` píše `baseline.json` (dnešní stav před novými žánry); jiný název píše `<název>.json`, výchozí
 * `classify.json` (T13). Mimo `baseline` přidá souhrn: na žánr kolik z 8 vět klasifikátor a návrh dají
 * očekávaný žánr, a pasti proti `baseline.json`. U `classify` hlídá bránu T13: každý živý žánr (buňka v
 * `liveCells()`) ≥ 0,85 vět návrhem a žádná past se nepohne. Od T13b je živých všech osm žánrů. Žánr návrhu
 * dává skladba jen hře, kterou ověřil robot (`verifyArcade`: robot vyhraje, nečinný hráč prohraje, přehrání sedí),
 * takže „návrh hraje žánr“ znamená i „robot ho na semínku 1 vyhrál“.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, it } from 'vitest';

import { loadRapier } from '../../../src/play/arcade/physics/world';
import { liveCells } from '../../../src/play/compose/allowed';

import { rowOf, type Row } from './rows';

const DIR = join(process.cwd(), 'evals', 'play', 'p54c');
/** Brána T13: podíl vět živého žánru, které návrh zahraje jeho žánrem. */
const GATE = 0.85;

type Measured = Row & { readonly family: string; readonly expect: string };

/** Řádek pasti tak, jak ho porovnává brána: klasifikátor, náhrada, žánr návrhu, buňka a chyba. */
const trapKey = (row: Row): string => JSON.stringify([row.classify, row.fallback, row.draft, row.cell, row.error ?? null]);

function summaryOf(sentences: readonly Measured[]) {
  const live = new Set(liveCells().map((cell) => cell.id));
  const targets = sentences.filter((row) => row.family === 'target');
  const genres = Object.fromEntries([...new Set(targets.map((row) => row.expect))].map((expected) => {
    const rows = targets.filter((row) => row.expect === expected);
    return [expected, {
      live: live.has(expected),
      of: rows.length,
      classify: rows.filter((row) => row.classify === expected).length,
      draft: rows.filter((row) => row.draft === expected).length,
      misses: rows.filter((row) => row.draft !== expected).map((row) => `${row.id}: ${row.draft ?? row.error ?? 'none'}`),
    }];
  }));
  const baseline = new Map((JSON.parse(readFileSync(join(DIR, 'baseline.json'), 'utf8')) as { sentences: Row[] }).sentences.map((row) => [row.id, row]));
  const traps = sentences.filter((row) => row.family === 'trap');
  const changed = traps.filter((row) => trapKey(row) !== trapKey(baseline.get(row.id)!)).map((row) => `${row.id}: ${baseline.get(row.id)!.draft} → ${row.draft}`);
  return { genres, traps: { of: traps.length, unchanged: traps.length - changed.length, changed } };
}

it('records where the P54C dev sentences land', async () => {
  await loadRapier();
  const out = process.env.P54C_OUT ?? 'classify';
  const dev = JSON.parse(readFileSync(join(DIR, 'dev.json'), 'utf8')) as { sentences: { id: string; family: string; expect: string; text: string }[] };
  const sentences: Measured[] = dev.sentences.map(({ id, family, expect: expected, text }) => ({ family, expect: expected, ...rowOf(id, text) }));
  const summary = out === 'baseline' ? null : summaryOf(sentences);
  writeFileSync(join(DIR, `${out}.json`), `${JSON.stringify({ schema: 'p54c-classify.v1', label: out, ...(summary === null ? {} : { summary }), sentences }, null, 1)}\n`);
  if (out !== 'classify' || summary === null) return;
  for (const [genre, row] of Object.entries(summary.genres)) if (row.live) expect(row.draft / row.of, `${genre}: ${row.misses.join('; ')}`).toBeGreaterThanOrEqual(GATE);
  expect(summary.traps.changed).toEqual([]);
}, 600_000);
