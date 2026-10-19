/**
 * Kam padají věty dev sady P54C (T2 baseline, T13 měření po klasifikátoru).
 *
 * ```
 * P54C_OUT=baseline npx vitest run --config vitest.measure.mts evals/play/p54c/classify.measure.ts
 * ```
 *
 * `baseline` píše `baseline.json` (dnešní stav před novými žánry); jiný název píše `<název>.json`.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { it } from 'vitest';

import { loadRapier } from '../../../src/play/arcade/physics/world';

import { rowOf } from './rows';

const DIR = join(process.cwd(), 'evals', 'play', 'p54c');

it('records where the P54C dev sentences land', async () => {
  await loadRapier();
  const out = process.env.P54C_OUT ?? 'classify';
  const dev = JSON.parse(readFileSync(join(DIR, 'dev.json'), 'utf8')) as { sentences: { id: string; family: string; expect: string; text: string }[] };
  const sentences = dev.sentences.map(({ id, family, expect, text }) => ({ family, expect, ...rowOf(id, text) }));
  writeFileSync(join(DIR, `${out}.json`), `${JSON.stringify({ schema: 'p54c-classify.v1', label: out, sentences }, null, 1)}\n`);
}, 600_000);
