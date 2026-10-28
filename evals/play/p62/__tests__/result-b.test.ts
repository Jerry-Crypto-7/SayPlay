/**
 * P62 T12: brána na zapečetěné sadě B přepočítaná z `result-b.json`, ne opsaná. Mediány znovu ze skóre po větách,
 * „po čtení“ znovu z řádků listu (hra ze čtení, když na listu je, jinak rychlá hra); prahy jsou tady z Pravidel
 * fáze 4 plánu P62, ne z výsledku. Rychlá hra: věrnost i „hrál bych“ nejvýš o 0,02 (šum soudce) pod `main`. Po
 * čtení: „hrál bych“ ne pod `main`. Start na telefonu: medián nejvýš +200 ms. Robot, nečinný hráč a přehrání na
 * všech hrách větve. FPS Pixel 7: medián B/A přes scény ≥ 0,95. Každá brána i celkový verdikt („připraveno
 * k sloučení“ / „nesloučit“) musí mít v `result-b.json` i v README tentýž výsledek, jaký dávají čísla.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { P62_HOLDOUT_B_SHA256, sha256Lf } from '../seal';

const DIR = join(process.cwd(), 'evals', 'play', 'p62');
const readLf = (name: string): string => readFileSync(join(DIR, name), 'utf8').replace(/\r\n/g, '\n');

interface Score { readonly fidelity: number; readonly wouldPlay: number; readonly reason: string }
interface Median { readonly fidelity: number; readonly wouldPlay: number; readonly n: number }
interface Gate { readonly id: string; readonly pass: boolean }
interface TimingRow { readonly id: string; readonly A: readonly number[]; readonly B: readonly number[] }
interface TimingMedian { readonly A: number; readonly B: number; readonly diff: number; readonly pairedDiff: number; readonly pass: boolean }
interface FpsScene { readonly scene: string; readonly A: readonly (number | null)[]; readonly B: readonly (number | null)[] }
interface FpsRun { readonly scenes: readonly FpsScene[]; readonly scenesMeasured: number; readonly ratioMedian: number; readonly pass: boolean }
interface RobotRow { readonly file: string; readonly botWins: boolean; readonly idleLoses: boolean; readonly replayEqual: boolean }
interface Result {
  readonly holdout: { readonly file: string; readonly sha256: string; readonly openedAt: string; readonly commit: string };
  readonly plan: readonly { readonly id: string; readonly rows: readonly { readonly side: string; readonly kind: string }[] }[];
  readonly sentences: readonly { readonly id: string; readonly scores: Readonly<Record<string, Score>> }[];
  readonly skipped: readonly string[];
  readonly medians: Readonly<Record<string, Median>>;
  readonly gates: readonly Gate[];
  readonly verdict: { readonly pass: boolean; readonly unmet: readonly string[]; readonly text: string };
  readonly timing: { readonly runs: number; readonly profiles: Readonly<Record<string, readonly TimingRow[]>>; readonly medians: Readonly<Record<string, TimingMedian>>; readonly gate: Gate };
  readonly robot: { readonly games: number; readonly published: number; readonly expected: number; readonly rows: readonly RobotRow[]; readonly gate: Gate };
  readonly fps: { readonly runs: readonly FpsRun[]; readonly gate: Gate };
}

const result = JSON.parse(readLf('result-b.json')) as Result;
const readme = readLf('README.md');
const start = readme.indexOf('### Zapečetěná sada B: brána (T12');
const section = readme.slice(start, readme.indexOf('\n## ', start));

const round = (x: number): number => Math.round(x * 1000) / 1000;
function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Hra, kterou hráč hraje po příchodu čtení: hra ze čtení, když je na listu, jinak rychlá hra. */
function played(id: string, name: 'main' | 'p62'): Score | undefined {
  const kinds = result.plan.find((item) => item.id === id)!.rows.map((row) => row.kind);
  const scores = result.sentences.find((row) => row.id === id)!.scores;
  return kinds.includes(`${name}-reading`) ? scores[`${name}-reading`] : scores[`${name}-quick`];
}

const shared = result.sentences.filter((row) => row.scores['main-quick'] && row.scores['p62-quick']).map((row) => row.id);
const sideOf = (side: string): Median => {
  const scores = shared.map((id) => {
    if (side === 'main-after-reading') return played(id, 'main')!;
    if (side === 'p62-after-reading') return played(id, 'p62')!;
    return result.sentences.find((row) => row.id === id)!.scores[side]!;
  });
  return { fidelity: round(median(scores.map((s) => s.fidelity))), wouldPlay: round(median(scores.map((s) => s.wouldPlay))), n: scores.length };
};

const quick = sideOf('p62-quick');
const after = sideOf('p62-after-reading');
const mainQuick = sideOf('main-quick');
const mainAfter = sideOf('main-after-reading');

/** Prahy z Pravidel fáze 4 (plán P62) – výsledek je nemůže posunout. */
const JUDGE_NOISE = 0.02;
const START_MAX_MS = 200;
const FPS_MIN_RATIO = 0.95;
const GATES: readonly Gate[] = [
  { id: 'B1', pass: round(quick.fidelity - mainQuick.fidelity) >= -JUDGE_NOISE },
  { id: 'B2', pass: round(quick.wouldPlay - mainQuick.wouldPlay) >= -JUDGE_NOISE },
  { id: 'B3', pass: after.wouldPlay >= mainAfter.wouldPlay },
];

const timingOf = (rows: readonly TimingRow[]): TimingMedian => {
  const A = median(rows.flatMap((row) => row.A));
  const B = median(rows.flatMap((row) => row.B));
  const pairedDiff = median(rows.flatMap((row) => row.B.map((b, k) => b - row.A[k]!)));
  return { A, B, diff: B - A, pairedDiff, pass: B <= A + START_MAX_MS };
};
const timing = Object.fromEntries(Object.entries(result.timing.profiles).map(([profile, rows]) => [profile, timingOf(rows)]));
const fpsRunOf = (scenes: readonly FpsScene[]) => {
  const ratios = scenes.flatMap((scene) => {
    const A = scene.A.filter((x): x is number => x !== null);
    const B = scene.B.filter((x): x is number => x !== null);
    return A.length > 0 && B.length > 0 ? [round(median(B) / median(A))] : [];
  });
  return { scenesMeasured: ratios.length, ratioMedian: round(median(ratios)), pass: median(ratios) >= FPS_MIN_RATIO };
};
const fpsRuns = result.fps.runs.map((run) => fpsRunOf(run.scenes));
const robotPass =
  result.robot.published === result.robot.expected &&
  result.robot.rows.length === result.robot.published &&
  result.robot.rows.every((row) => row.botWins && row.idleLoses && row.replayEqual);
const OTHER_GATES: readonly Gate[] = [
  { id: 'B4', pass: timing['pixel7-cpu4']!.pass },
  { id: 'B5', pass: robotPass },
  { id: 'B6', pass: fpsRuns.every((run) => run.pass) },
];
const ALL_GATES = [...GATES, ...OTHER_GATES];
const VERDICT = ALL_GATES.every((gate) => gate.pass) ? 'připraveno k sloučení' : 'nesloučit';

/** Číslo jako v README: dvě desetinná místa, tři, když je třetí nenulové; desetinná čárka. */
const cz = (x: number): string => (Math.round(x * 1000) % 10 === 0 ? x.toFixed(2) : x.toFixed(3)).replace('.', ',');

describe('P62 sealed place set B gate (T12)', () => {
  it('opened set B once, unchanged, on the measured branch', () => {
    const opened = JSON.parse(readLf('holdout-b-opened.json')) as { sha256: string; openedAt: string; commit: string };
    expect(sha256Lf(readLf('holdout-b.json'))).toBe(P62_HOLDOUT_B_SHA256);
    expect(opened.sha256).toBe(P62_HOLDOUT_B_SHA256);
    expect(result.holdout).toMatchObject({ file: 'evals/play/p62/holdout-b.json', sha256: opened.sha256, openedAt: opened.openedAt, commit: opened.commit });
  });

  it('judged every sentence of set B on one shared sheet with main and branch rows', () => {
    const holdout = (JSON.parse(readLf('holdout-b.json')) as { sentences: { id: string }[] }).sentences.map((s) => s.id);
    expect([...result.sentences.map((row) => row.id), ...result.skipped].sort()).toEqual([...holdout].sort());
    for (const item of result.plan) {
      const kinds = item.rows.map((row) => row.kind);
      expect(kinds, item.id).toEqual(expect.arrayContaining(['main-quick', 'p62-quick']));
      const scores = result.sentences.find((row) => row.id === item.id)?.scores;
      if (scores) for (const kind of kinds) expect(scores[kind], `${item.id} ${kind}`).toBeDefined();
    }
    expect(shared).toHaveLength(result.sentences.length);
  });

  it('records after-reading as the reading game when the sheet has one, else the quick game', () => {
    for (const row of result.sentences) {
      expect(row.scores['main-after-reading'], row.id).toEqual(played(row.id, 'main'));
      expect(row.scores['p62-after-reading'], row.id).toEqual(played(row.id, 'p62'));
    }
  });

  it('records medians that the per-sentence scores give', () => {
    for (const side of ['main-quick', 'main-after-reading', 'p62-quick', 'p62-after-reading']) expect(result.medians[side], side).toEqual(sideOf(side));
  });

  it('records each gate and the verdict that the numbers give, in result-b.json and in the README', () => {
    expect(result.gates.map((gate) => [gate.id, gate.pass])).toEqual(GATES.map((gate) => [gate.id, gate.pass]));
    expect([result.timing.gate, result.robot.gate, result.fps.gate].map((gate) => [gate.id, gate.pass])).toEqual(OTHER_GATES.map((gate) => [gate.id, gate.pass]));
    expect(result.verdict).toEqual({ pass: ALL_GATES.every((gate) => gate.pass), unmet: ALL_GATES.filter((gate) => !gate.pass).map((gate) => gate.id), text: VERDICT });
    expect(section.length).toBeGreaterThan(0);
    for (const gate of ALL_GATES) expect(section, gate.id).toMatch(new RegExp(`^\\| ${gate.id} .*\\| ${gate.pass ? 'splněna' : 'nesplněna'} \\|$`, 'm'));
    expect(section).toContain(`**Verdikt: ${VERDICT}.**`);
    expect(section).not.toContain(`**Verdikt: ${VERDICT === 'nesloučit' ? 'připraveno k sloučení' : 'nesloučit'}.**`);
  });

  it('measured the start on 5 dev sentences x 3 runs per side and records the medians those runs give', () => {
    expect(Object.keys(result.timing.profiles)).toContain('pixel7-cpu4');
    for (const [profile, rows] of Object.entries(result.timing.profiles)) {
      expect(rows.map((row) => row.id), profile).toHaveLength(5);
      for (const row of rows) expect([row.A.length, row.B.length], `${profile} ${row.id}`).toEqual([result.timing.runs, result.timing.runs]);
      expect(result.timing.medians[profile], profile).toEqual(timing[profile]);
    }
  });

  it('records the Pixel 7 FPS ratio the interleaved run gives', () => {
    expect(result.fps.runs.length).toBeGreaterThan(0);
    result.fps.runs.forEach((run, index) => expect({ scenesMeasured: run.scenesMeasured, ratioMedian: run.ratioMedian, pass: run.pass }, `run ${index}`).toEqual(fpsRuns[index]));
    for (const run of fpsRuns) expect(run.scenesMeasured).toBeGreaterThan(0);
  });

  it('re-verified every game the branch published on set B', () => {
    expect(result.robot.rows).toHaveLength(result.robot.games);
    expect(result.robot.games).toBeGreaterThanOrEqual(24);
  });

  it('shows the recomputed medians, start times and FPS ratio in the README', () => {
    const rows = { 'main-quick': '`main` rychlá hra', 'main-after-reading': '`main` po čtení', 'p62-quick': 'P62 rychlá hra', 'p62-after-reading': 'P62 po čtení' };
    for (const [side, label] of Object.entries(rows)) {
      const { fidelity, wouldPlay, n } = sideOf(side);
      expect(section, side).toContain(`| ${label} | ${cz(fidelity)} | ${cz(wouldPlay)} | ${n} |`);
    }
    const labels: Readonly<Record<string, string>> = { desktop: 'desktop 1280×720', 'pixel7-cpu4': 'Pixel 7, CPU 4×' };
    const ms = (x: number): string => String(x).replace('.', ',');
    const signed = (x: number): string => (x < 0 ? `−${ms(-x)}` : `+${ms(x)}`);
    for (const [profile, { A, B, diff, pairedDiff }] of Object.entries(timing)) {
      expect(section, profile).toContain(`| ${labels[profile]} | ${ms(A)} ms | ${ms(B)} ms | ${signed(diff)} ms | ${signed(pairedDiff)} ms |`);
    }
    for (const run of fpsRuns) expect(section).toContain(`| ${run.scenesMeasured} | ${cz(run.ratioMedian)} | ${run.pass ? 'splněna' : 'nesplněna'} |`);
  });

  it('gives a per-sentence row with the judge reason in the README for every judged sentence', () => {
    for (const row of result.sentences) expect(section, row.id).toMatch(new RegExp(`^\\| ${row.id} `, 'm'));
  });
});
