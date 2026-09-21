/**
 * Regresní baseline kompilátoru her (P23-A, T10): 8 fixtur × 5 seedů přes
 * `compileGame` a `verifyGame`, zapsané do `report.json`.
 *
 * `worldHash` seedu 1 každého archetypu je **pin**: test ho čte z commitnutého
 * `report.json` dřív, než cokoli zapíše, a posun shodí test bez zápisu – jinak
 * by druhý běh posunutý hash tiše připíchl. Vědomá změna kompilátoru = zvednout
 * `GAME_COMPILER_VERSION`, zapsat nález do `docs/play/CONTRACT-CHANGES.md`,
 * smazat `report.json` a pustit test znovu (nové piny vezme z běhu).
 *
 * `compileMs` je čas samotného `compileGame`, bez verifikace.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { compileGame } from '@/play/compile';
import { GAME_COMPILER_VERSION } from '@/play/contracts';
import { ARCHETYPE_IDS } from '@/play/registry';
import { readGameSpec } from '@/play/spec';
import { verifyGame } from '@/play/verify';

const ARTIFACT = fileURLToPath(new URL('./report.json', import.meta.url));
const FIXTURES = new URL('../../../src/play/__fixtures__/', import.meta.url);
const SEEDS = [1, 2, 3, 4, 5] as const;

/** Naměřeno 21. 9. 2026 – pin, ne dolní strop z AC (36). */
const MEASURED_ELIGIBLE = 40;
const MEDIAN_COMPILE_MS_CAP = 500;

interface Run {
  readonly archetype: string;
  readonly seed: number;
  readonly compiled: boolean;
  readonly reason: string | null;
  readonly compileMs: number;
  readonly worldHash: string | null;
  readonly entities: number | null;
  readonly rules: number | null;
  readonly triangles: number | null;
  readonly winsAtTick: number | null;
  readonly keypointsPassed: number;
  readonly keypointsTotal: number;
  readonly publishEligible: boolean;
}

interface Report {
  readonly schema: 'play-compile-report.v1';
  readonly compilerVersion: string;
  readonly seeds: readonly number[];
  readonly summary: { readonly eligible: number; readonly total: number; readonly medianCompileMs: number };
  /** Pin: `worldHash` seedu 1 na archetyp. */
  readonly worldHashes: Readonly<Record<string, string | null>>;
  readonly runs: readonly Run[];
}

const round = (ms: number): number => Math.round(ms * 10) / 10;

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? (sorted[mid] as number) : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

function measure(archetype: string, seed: number): Run {
  const read = readGameSpec(JSON.parse(readFileSync(new URL(`${archetype}.json`, FIXTURES), 'utf8')));
  if (!read.ok) throw new Error(`${archetype}: ${read.reason} ${read.issues.join('; ')}`);
  const started = performance.now();
  const result = compileGame(read.value, seed);
  const compileMs = round(performance.now() - started);
  if (!result.ok) {
    const failed = { worldHash: null, entities: null, rules: null, triangles: null, winsAtTick: null };
    return { archetype, seed, compiled: false, reason: `${result.reason}: ${result.issues.join('; ')}`, compileMs, ...failed, keypointsPassed: 0, keypointsTotal: read.value.verification.length, publishEligible: false };
  }
  const quality = verifyGame(result.value);
  return {
    archetype,
    seed,
    compiled: true,
    reason: null,
    compileMs,
    worldHash: result.value.worldHash,
    entities: quality.budgets.entities,
    rules: quality.budgets.rules,
    triangles: quality.budgets.triangles ?? null,
    winsAtTick: quality.witness.winsAtTick,
    keypointsPassed: quality.keypoints.filter((keypoint) => keypoint.passed).length,
    keypointsTotal: quality.keypoints.length,
    publishEligible: quality.publishEligible,
  };
}

describe('compile baseline – eight archetypes × five seeds', () => {
  it('compiles, verifies and pins the seed-1 world of every archetype', () => {
    const previous = existsSync(ARTIFACT) ? (JSON.parse(readFileSync(ARTIFACT, 'utf8')) as Report) : null;
    const runs = ARCHETYPE_IDS.flatMap((archetype) => SEEDS.map((seed) => measure(archetype, seed)));
    const worldHashes = Object.fromEntries(ARCHETYPE_IDS.map((archetype) => [archetype, runs.find((run) => run.archetype === archetype && run.seed === 1)?.worldHash ?? null]));
    const eligible = runs.filter((run) => run.publishEligible).length;
    const medianCompileMs = round(median(runs.map((run) => run.compileMs)));
    const lines = runs.map((run) => `${run.archetype}/${run.seed}: ${run.publishEligible ? 'eligible' : (run.reason ?? `${run.keypointsPassed}/${run.keypointsTotal}`)}`);

    // Pin první – posunutý hash nesmí dojít k zápisu.
    if (previous !== null) {
      expect(worldHashes, 'compiler drift: bump GAME_COMPILER_VERSION, note it in docs/play/CONTRACT-CHANGES.md, delete report.json').toEqual(previous.worldHashes);
    }
    // Týž spec + seed ve dvou kompilacích téhož běhu.
    expect(measure('collect_exit', 1).worldHash).toBe(worldHashes.collect_exit);
    expect(Object.values(worldHashes).every((hash) => hash !== null)).toBe(true);
    expect(eligible, lines.join('\n')).toBeGreaterThanOrEqual(MEASURED_ELIGIBLE);
    expect(medianCompileMs).toBeLessThanOrEqual(MEDIAN_COMPILE_MS_CAP);
    for (const archetype of ARCHETYPE_IDS) {
      expect(runs.filter((run) => run.archetype === archetype && run.publishEligible).length, archetype).toBeGreaterThanOrEqual(4);
    }

    const report: Report = {
      schema: 'play-compile-report.v1',
      compilerVersion: GAME_COMPILER_VERSION,
      seeds: SEEDS,
      summary: { eligible, total: runs.length, medianCompileMs },
      worldHashes,
      runs,
    };
    writeFileSync(ARTIFACT, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  }, 120_000);
});
