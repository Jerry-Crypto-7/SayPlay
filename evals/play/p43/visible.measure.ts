/**
 * P43 viditelnost akce a hrdiny nad panelem (T2 baseline, T8 a T15 po proudech).
 *
 *   P43_RUN=p43-baseline P43_OUT=baseline.json npx vitest run --config vitest.measure.mts evals/play/p43/visible.measure.ts
 *
 * Klip vyrobí a soudí `scripts/play-fidelity.mjs run --set <panel> --clip --draft-only --run <P43_RUN>`
 * a `judge --clip --run <P43_RUN>`. Konečné měření (T16) přidá `P43_OPEN_SEALED_ONCE=1`
 * až po běhu, který pečeť zlomil.
 */

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { it } from 'vitest';

import { loadRapier } from '@/play/arcade/physics/world';

import { clipOf, rowsOf, setOf, summary } from './visible';

const here = (relative: string) => fileURLToPath(new URL(relative, import.meta.url));

it('writes the P43 visibility report', async () => {
  const run = process.env.P43_RUN;
  const out = process.env.P43_OUT;
  if (!run || !out) throw new Error('set P43_RUN (clip run id) and P43_OUT (file in evals/play/p43)');
  await loadRapier();
  const runDir = here(`../fidelity/runs/${run}`);
  const rows = rowsOf(setOf({ openSealedOnce: process.env.P43_OPEN_SEALED_ONCE === '1' }), (id) => clipOf(runDir, id));
  const report = {
    about: 'P43 visibility: verb recognised in the 3-frame clip by the blind judge (all, and only where the offline witness proves the game plays the verb), hero drawn by its model, hero recognised, items drawn by a model. Draft only, no director. See README.md.',
    run,
    measuredAt: new Date().toISOString(),
    summary: summary(rows),
    rows,
  };
  writeFileSync(here(`./${out}`), `${JSON.stringify(report, null, 1)}\n`);
}, 30 * 60_000);
