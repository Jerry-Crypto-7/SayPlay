/**
 * P43 T9: podstatná jména bez modelu přes všechny vývojové sady.
 *
 *   npx vitest run --config vitest.measure.mts evals/play/p43/missing.measure.ts
 *
 * Zapíše `evals/play/p43/missing.json`. Zapečetěné sady se nečtou (`SETS` v
 * `scripts/p37d/missing-nouns.mjs`).
 */

import { expect, it } from 'vitest';

import { writeReport } from '../../../scripts/p37d/missing-nouns.mjs';

it('writes the P43 missing-noun ranking', () => {
  const counts = writeReport('evals/play/p43/missing.json');
  expect(counts.missing).toBeGreaterThan(0);
});
