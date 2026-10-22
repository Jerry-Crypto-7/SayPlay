/**
 * Výchozí čísla P56A (T1): co z věty dojde do hry na rychlé cestě bez čtečky (`reading: null`, jako produkce
 * s vypnutým `PLAY_READER`).
 *
 * ```
 * P56A_OUT=baseline npx vitest run --config vitest.measure.mts evals/play/p56a/baseline.measure.ts
 * ```
 *
 * Sady: p55 holdout (80, otevřený v P55 T9, od té doby dev), p54c dev (80), p54c holdout-opened (80), p30 dev (60),
 * p43 panel (30, sloty hero/role) a `audit-12.json`. Řádek věty nese celé pořadí `classifyGenre` (zlatý test T5),
 * hrdinu a protivníka s modelem a úrovní volby (T6), sadu vzhledu (T7), název (T8) a cílový řádek (T9). Výstup
 * `<P56A_OUT>.json` bez času, takže opakovaný běh beze změny kódu nechá git čistý; klíč `latency` zapisuje
 * `latency.mjs` a tenhle skript ho nechá být. Řádek a souhrny jsou v `rows.ts` (sdílí je `dev.measure.ts`, T11).
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { it } from 'vitest';

import { loadRapier } from '../../../src/play/arcade/physics/world';

import { ROOT, castSummary, genreSummary, panelSummary, readSet, rowOf } from './rows';

export { TEMPLATE_TITLE } from './rows';

const OUT = join(ROOT, 'p56a', `${process.env.P56A_OUT ?? 'baseline'}.json`);

it('records the P56A baseline: genre, cast, world, title and goal without the reader', async () => {
  await loadRapier();
  const sets = {
    p55HoldoutOpened: readSet('p55/holdout.json'),
    p54cDev: readSet('p54c/dev.json'),
    p54cHoldoutOpened: readSet('p54c/holdout.json'),
    p30Dev: readSet('p30/dev.json'),
    p43Panel: readSet('p43/panel.json'),
    audit12: readSet('p56a/audit-12.json'),
  };
  const out: Record<string, unknown> = {};
  for (const [name, sentences] of Object.entries(sets)) {
    const rows = sentences.map((sentence) => rowOf(sentence));
    out[name] = {
      genre: genreSummary(sentences, rows),
      cast: castSummary(sentences, rows),
      ...(name === 'p43Panel' ? { panel: panelSummary(sentences, rows) } : {}),
      rows,
    };
  }
  const previous = existsSync(OUT) ? (JSON.parse(readFileSync(OUT, 'utf8')) as { latency?: unknown }) : {};
  writeFileSync(OUT, `${JSON.stringify({ schema: 'p56a-baseline.v1', reading: null, seed: 1, sets: out, ...(previous.latency === undefined ? {} : { latency: previous.latency }) }, null, 1)}\n`);
}, 900_000);
