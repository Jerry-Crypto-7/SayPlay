/**
 * Výchozí čísla P55 (T1): kam padají věty tří vývojových sad a kolik se toho děje ve čtyřech pruhových žánrech.
 *
 * ```
 * P55_OUT=baseline npx vitest run --config vitest.measure.mts evals/play/p55/baseline.measure.ts
 * ```
 *
 * Sady: p54c dev (80), p54c holdout otevřený v P54C T16 (80, od té doby vývojová data) a p30 dev (60, bez
 * očekávaného žánru – „beze ztráty“ znamená, že se řádek nepohne). Zábava: buňka `<žánr>.default`, semínko 1,
 * robot `intermediate`, `funMetrics`. Výstup `<P55_OUT>.json` (výchozí `baseline`) bez času, takže opakovaný běh
 * beze změny kódu nechá git čistý.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { it } from 'vitest';

import { arcadeWorldOf, preloadPhysics } from '../../../src/play/arcade/compile';
import { loadRapier } from '../../../src/play/arcade/physics/world';
import { funMetrics, traceRun } from '../../../src/play/arcade/telemetry';
import { runBot, verifyArcade } from '../../../src/play/arcade/verify';
import { assemblyOfCell, liveCells } from '../../../src/play/compose/allowed';
import { compileRecipe } from '../../../src/play/compose/compile';

import { rowOf, type Row } from '../p54c/rows';

const ROOT = join(process.cwd(), 'evals', 'play');
const OUT = join(ROOT, 'p55', `${process.env.P55_OUT ?? 'baseline'}.json`);
const LANE_GENRES = ['catch', 'whack', 'slice', 'defense'] as const;
const SEED = 1;

interface Sentence { readonly id: string; readonly family?: string; readonly expect?: string; readonly genre?: string | null; readonly text: string }
type Measured = Row & { readonly family: string | null; readonly expect: string | null };

const readSet = (path: string): Sentence[] => (JSON.parse(readFileSync(join(ROOT, path), 'utf8')) as { sentences: Sentence[] }).sentences;

function measure(sentences: readonly Sentence[]): Measured[] {
  return sentences.map((s) => {
    const expected = s.expect ?? s.genre ?? null;
    return { family: s.family ?? null, expect: expected === null ? null : expected.includes('.') ? expected : `${expected}.default`, ...rowOf(s.id, s.text) };
  });
}

/** Na očekávaný žánr: kolik cílových vět ho dá návrh; pasti zvlášť. */
function summaryOf(rows: readonly Measured[]) {
  const targets = rows.filter((row) => row.family === 'target');
  const genres = Object.fromEntries([...new Set(targets.map((row) => row.expect!))].sort().map((genre) => {
    const of = targets.filter((row) => row.expect === genre);
    return [genre, { of: of.length, draft: of.filter((row) => row.draft === genre).length, misses: of.filter((row) => row.draft !== genre).map((row) => `${row.id}: ${row.draft ?? row.error ?? 'none'}`) }];
  }));
  const hit = targets.filter((row) => row.draft === row.expect).length;
  return { targets: { of: targets.length, draft: hit }, genres };
}

async function laneFun(genre: string) {
  const cell = liveCells().find((candidate) => candidate.id === `${genre}.default`);
  if (cell === undefined) throw new Error(`${genre}.default is not a live cell`);
  const spec = compileRecipe(assemblyOfCell(cell));
  await preloadPhysics(spec, loadRapier);
  const made = arcadeWorldOf(spec, SEED);
  if (!made.ok) throw new Error(made.issues.join('; '));
  const verdict = verifyArcade(made.world);
  const bot = runBot(made.world, undefined, { profile: 'intermediate' });
  const m = funMetrics(traceRun(made.world, bot.inputs));
  return {
    genre, seed: SEED, botWins: verdict.bot.outcome === 'won', winSeconds: verdict.bot.outcome === 'won' ? Math.round((verdict.bot.tick / 60) * 10) / 10 : null,
    eventsPerS: m.eventsPerS, longestGapS: m.longestGapS, medianGapS: m.medianGapS, rising: m.rising, intensityRatio: m.intensityRatio, behaviourCount: m.behaviourCount, finale: m.finale,
  };
}

it('records the P55 baseline: genre on three dev sets and lane fun at seed 1', async () => {
  await loadRapier();
  const p54cDev = measure(readSet('p54c/dev.json'));
  const p54cHoldout = measure(readSet('p54c/holdout.json'));
  const p30Dev = measure(readSet('p30/dev.json'));
  const fun = [];
  for (const genre of LANE_GENRES) fun.push(await laneFun(genre));
  writeFileSync(OUT, `${JSON.stringify({
    schema: 'p55-baseline.v1',
    sets: {
      p54cDev: { summary: summaryOf(p54cDev), rows: p54cDev },
      p54cHoldoutOpened: { summary: summaryOf(p54cHoldout), rows: p54cHoldout },
      p30Dev: { rows: p30Dev },
    },
    laneFun: fun,
  }, null, 1)}\n`);
}, 900_000);
