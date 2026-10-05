/**
 * Zapíše `depth.json` (P36A T1). Spouští ho
 * `npx vitest run --config vitest.measure.mts evals/play/p36/depth.measure.ts`;
 * výpočet je v `depth.ts`, definice polí v `README.md`. Přeměřují ho T2, T4,
 * T5, T10 a T11 – nový běh bez změny kódu nechá soubor beze změny.
 */

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { it } from 'vitest';

import { measureDepth } from './depth';

const pct = (value: number): string => `${(value * 100).toFixed(1)} %`;

it('writes evals/play/p36/depth.json', async () => {
  const report = await measureDepth();
  writeFileSync(fileURLToPath(new URL('./depth.json', import.meta.url)), `${JSON.stringify(report, null, 1)}\n`);
  for (const [name, summary] of Object.entries(report.summary)) {
    console.log(
      `${name}: ${summary.sentences} sentences, playable ${summary.playable}, band ${pct(summary.inBandShare)}, idle loses ${pct(summary.idleLosesShare)} (won ${summary.idle.won}, unfinished ${summary.idle.unfinished}), lives>1 ${pct(summary.livesOver1Share)}, score decides ${pct(summary.scoreDecidesShare)}`,
    );
  }
  for (const [genre, row] of Object.entries(report.summary.all.byGenre)) {
    console.log(`  ${genre}: ${row.sentences} sentences, median ${String(row.medianWinSeconds)} s (${String(row.minWinSeconds)}–${String(row.maxWinSeconds)}), band ${row.inBand}, idle loses ${row.idleLoses}, lives>1 ${row.livesOver1}`);
  }
}, 30 * 60_000);
