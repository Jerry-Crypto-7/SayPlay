/**
 * Regresní harness PLAY (P23-D T3): 40 zlatých vět bez modelu – návrh ze slov
 * (`draftGameSpec`) → `readGameSpec` → `compileGame(spec, 1)` → `verifyGame`.
 * Zapisuje `report.json` a `report.md` vedle sebe.
 *
 * **Verdikty jsou pin.** Test přečte commitnutý `report.json` dřív, než cokoli
 * zapíše, a když se u některé věty posune verdikt (archetyp, kompilace,
 * publikovatelnost, keypointy, tik výhry, velikost světa), padne s diffem bez
 * zápisu – posun jedné věty jinak vypadá jako šum. Časy (`*Ms`, `measuredAt`)
 * se nesrovnávají. Vědomá změna = smazat `report.json` a pustit test znovu.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { arcadeReport, verifyArcade } from '@/play/arcade/verify';
import { compileGame } from '@/play/compile';
import { draftGameSpec } from '@/play/draft';
import { readGameSpec } from '@/play/spec';
import { verifyGame } from '@/play/verify';

import { goldenPrompts } from '../golden';

const ARTIFACT = fileURLToPath(new URL('./report.json', import.meta.url));
const TABLE = fileURLToPath(new URL('./report.md', import.meta.url));
const SEED = 1;

/** Naměřeno prvním během 21. 9. 2026 – pin, ne dolní strop z AC. */
const PIN = { specValid: 40, compiled: 40, eligible: 40, archetypeHits: 32 } as const;
const P90_COMPILE_MS_CAP = 1000;

interface Row {
  readonly id: string;
  readonly bucket: string;
  readonly archetype: string | null;
  readonly expectArchetype: string | null;
  readonly archetypeHit: boolean | null;
  readonly specValid: boolean;
  readonly compiled: boolean;
  readonly reason: string | null;
  readonly publishEligible: boolean;
  readonly keypointsPassed: number;
  readonly keypointsTotal: number;
  readonly winsAtTick: number | null;
  readonly entities: number | null;
  readonly rules: number | null;
  readonly draftMs: number;
  readonly compileMs: number;
  readonly verifyMs: number;
}

interface Report {
  readonly schema: 'play-regression-report.v1';
  readonly measuredAt: string;
  readonly seed: number;
  readonly rows: readonly Row[];
  readonly summary: {
    readonly specValid: number;
    readonly compiled: number;
    readonly eligible: number;
    readonly total: number;
    readonly archetypeHits: number;
    readonly withExpect: number;
    readonly medianCompileMs: number;
    readonly p90CompileMs: number;
  };
}

const round = (ms: number): number => Math.round(ms * 10) / 10;

function quantile(values: readonly number[], q: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)] ?? 0;
}

function measure(entry: ReturnType<typeof goldenPrompts>[number]): Row {
  const draftStarted = performance.now();
  const draft = draftGameSpec(entry.prompt);
  const draftMs = round(performance.now() - draftStarted);
  const read = readGameSpec(draft);
  const base = { id: entry.id, bucket: entry.bucket, expectArchetype: entry.expectArchetype, draftMs };
  const none = { compiled: false, publishEligible: false, keypointsPassed: 0, winsAtTick: null, entities: null, rules: null, verifyMs: 0 };
  if (!read.ok) {
    return { ...base, ...none, archetype: null, archetypeHit: null, specValid: false, reason: read.reason, keypointsTotal: 0, compileMs: 0 };
  }
  const spec = read.value;
  const archetype = spec.archetype;
  const archetypeHit = entry.expectArchetype === null ? null : archetype === entry.expectArchetype;
  const compileStarted = performance.now();
  const compiled = compileGame(spec, SEED);
  const compileMs = round(performance.now() - compileStarted);
  if (!compiled.ok) {
    return { ...base, ...none, archetype, archetypeHit, specValid: true, reason: `${compiled.reason}: ${compiled.issues.join('; ')}`, keypointsTotal: spec.verification.length, compileMs };
  }
  const verifyStarted = performance.now();
  // Arkádu (P28D: návrh volí nejbližší arkádovou hru) ověřuje táž cesta jako publikace (`_report.ts`).
  const arcade = compiled.value.arcade;
  const quality = arcade === undefined ? verifyGame(compiled.value) : arcadeReport(verifyArcade(arcade), arcade, compiled.value);
  const verifyMs = round(performance.now() - verifyStarted);
  return {
    ...base,
    archetype,
    archetypeHit,
    specValid: true,
    compiled: true,
    reason: null,
    publishEligible: quality.publishEligible,
    keypointsPassed: quality.keypoints.filter((keypoint) => keypoint.passed).length,
    keypointsTotal: quality.keypoints.length,
    winsAtTick: quality.witness.winsAtTick,
    entities: quality.budgets.entities,
    rules: quality.budgets.rules,
    compileMs,
    verifyMs,
  };
}

/** Co z řádku je verdikt – bez časů. */
function verdict(row: Row): Omit<Row, 'draftMs' | 'compileMs' | 'verifyMs'> {
  const { draftMs: _draft, compileMs: _compile, verifyMs: _verify, ...rest } = row;
  return rest;
}

function table(report: Report): string {
  const { summary } = report;
  const lines = [
    '# PLAY – regresní harness nad 40 zlatými větami',
    '',
    `Naměřeno ${report.measuredAt}, semínko ${String(report.seed)}, bez modelu (návrh ze slov). Generuje \`golden.test.ts\`.`,
    '',
    `Spec platný ${String(summary.specValid)}/${String(summary.total)} · zkompilováno ${String(summary.compiled)}/${String(summary.total)} · publikovatelné ${String(summary.eligible)}/${String(summary.total)} · archetyp trefen ${String(summary.archetypeHits)}/${String(summary.withExpect)} · kompilace medián ${String(summary.medianCompileMs)} ms, p90 ${String(summary.p90CompileMs)} ms`,
    '',
    '| id | kbelík | archetyp | trefa | kompilace | publikovatelné | keypointy | výhra (tik) | entity | pravidla | kompilace ms | kontrola ms |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|',
    ...report.rows.map((row) =>
      [
        row.id,
        row.bucket,
        row.archetype ?? '–',
        row.archetypeHit === null ? '–' : row.archetypeHit ? 'ano' : '**ne**',
        row.compiled ? 'ano' : `**ne** (${row.reason ?? ''})`,
        row.publishEligible ? 'ano' : '**ne**',
        `${String(row.keypointsPassed)}/${String(row.keypointsTotal)}`,
        row.winsAtTick ?? '–',
        row.entities ?? '–',
        row.rules ?? '–',
        row.compileMs,
        row.verifyMs,
      ].join(' | ').replace(/^/, '| ').replace(/$/, ' |'),
    ),
    '',
  ];
  return lines.join('\n');
}

describe('regression harness – forty golden sentences, draft only', () => {
  it('drafts, compiles and verifies every sentence and pins each verdict', () => {
    const previous = existsSync(ARTIFACT) ? (JSON.parse(readFileSync(ARTIFACT, 'utf8')) as Report) : null;
    const rows = goldenPrompts().map(measure);
    const compileTimes = rows.filter((row) => row.compiled).map((row) => row.compileMs);
    const summary: Report['summary'] = {
      specValid: rows.filter((row) => row.specValid).length,
      compiled: rows.filter((row) => row.compiled).length,
      eligible: rows.filter((row) => row.publishEligible).length,
      total: rows.length,
      archetypeHits: rows.filter((row) => row.archetypeHit === true).length,
      withExpect: rows.filter((row) => row.expectArchetype !== null).length,
      medianCompileMs: round(quantile(compileTimes, 0.5)),
      p90CompileMs: round(quantile(compileTimes, 0.9)),
    };
    const failures = rows.filter((row) => !row.publishEligible).map((row) => `${row.id}: ${row.reason ?? `${String(row.keypointsPassed)}/${String(row.keypointsTotal)}`}`);

    // Pin první – posunutý verdikt nesmí dojít k zápisu.
    if (previous !== null) {
      expect(rows.map(verdict), 'verdict drift: explain it, then delete report.json and re-run').toEqual(previous.rows.map(verdict));
    }
    expect(rows).toHaveLength(40);
    expect(summary.specValid).toBe(PIN.specValid);
    expect(summary.compiled, failures.join('\n')).toBeGreaterThanOrEqual(PIN.compiled);
    expect(summary.eligible, failures.join('\n')).toBeGreaterThanOrEqual(PIN.eligible);
    expect(summary.archetypeHits).toBeGreaterThanOrEqual(PIN.archetypeHits);
    expect(summary.p90CompileMs).toBeLessThanOrEqual(P90_COMPILE_MS_CAP);

    const report: Report = { schema: 'play-regression-report.v1', measuredAt: new Date().toISOString(), seed: SEED, rows, summary };
    writeFileSync(ARTIFACT, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    writeFileSync(TABLE, table(report), 'utf8');
  }, 180_000);
});
