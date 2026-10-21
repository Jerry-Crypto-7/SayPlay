/**
 * Výchozí cena návrhu z věty P56C (T1): kolik ms stojí kompilace a ověření jedné hry.
 *
 * ```
 * npx vitest run --config vitest.measure.mts evals/play/p56c/baseline.measure.ts
 * ```
 *
 * Cesta jako `POST /api/play/games {sentence}` bez čtecího modelu: `draftGameSpecWithMeta` a `publishReadSpec`
 * nad paměťovým úložištěm se semínky z věty. Návrh z věty si `timings` do hry neukládá (jen verze od režiséra),
 * proto se tady předají – `publishReadSpec` pak `compileMs` a `verifyMs` změří stejně jako na serveru.
 * Každá věta se měří `RUNS`× a bere se medián (stroj nikdy není v klidu). Výstup `baseline-cost.json`.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { it } from 'vitest';

import { derivedSeeds, publishReadSpec, seedFrom } from '../../../src/app/api/play/_publish';
import { loadRapier } from '../../../src/play/arcade/physics/world';
import { draftGameSpecWithMeta } from '../../../src/play/draft';
import { memoryVersionStore } from '../../../src/play/version/store';

const ROOT = join(process.cwd(), 'evals', 'play');
const RUNS = 3;

const median = (values: readonly number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
};
const round = (ms: number): number => Math.round(ms * 10) / 10;

it('measures compile and verify cost of a drafted game', async () => {
  await loadRapier();
  const sentences = (JSON.parse(readFileSync(join(ROOT, 'p32', 'baseline-sentences.json'), 'utf8')) as { sentences: { id: string; text?: string }[] }).sentences
    .filter((s): s is { id: string; text: string } => typeof s.text === 'string');
  const rows = [];
  for (const { id, text } of sentences) {
    const compile: number[] = [];
    const verify: number[] = [];
    let genre: string | null = null;
    let error: string | null = null;
    for (let run = 0; run < RUNS; run += 1) {
      const meta = draftGameSpecWithMeta(text, 1, { reading: null });
      const spec = meta.spec;
      const published = await publishReadSpec(memoryVersionStore(), spec, derivedSeeds(seedFrom(text.trim())), null, {
        timings: { ackMs: null, draftReadyMs: null, directorMs: 0, source: 'draft' },
      });
      if (!published.ok) { error = published.issues?.join('; ') ?? 'not published'; break; }
      const timings = published.value.game.timings!;
      compile.push(timings.compileMs);
      verify.push(timings.verifyMs);
      genre = meta.genre === null ? spec.archetype : `${meta.genre.genre}.${meta.genre.mode}`;
    }
    rows.push({
      id, genre, error,
      compileMs: compile.length === 0 ? null : round(median(compile)),
      verifyMs: verify.length === 0 ? null : round(median(verify)),
      runs: { compileMs: compile.map(round), verifyMs: verify.map(round) },
    });
  }
  const ok = rows.filter((row) => row.error === null);
  const summary = {
    sentences: rows.length,
    published: ok.length,
    compileMsMedian: round(median(ok.map((row) => row.compileMs!))),
    verifyMsMedian: round(median(ok.map((row) => row.verifyMs!))),
    verifyMsMax: round(Math.max(...ok.map((row) => row.verifyMs!))),
  };
  writeFileSync(join(ROOT, 'p56c', 'baseline-cost.json'), `${JSON.stringify({ runs: RUNS, summary, rows }, null, 2)}\n`);
}, 600_000);
