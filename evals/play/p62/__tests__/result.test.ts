/**
 * P62 T7: zapečetěná brána scény přepočítaná z `result.json`, ne opsaná. Mediány se počítají znovu ze skóre po
 * větách, „po čtení“ znovu z řádků listu (hra ze čtení, když na listu je, jinak rychlá hra) a prahy jsou tady
 * z plánu P62 (Goal, T7 AC), ne z výsledku. Každá brána musí mít v `result.json` i v README tentýž verdikt, jaký dávají
 * čísla: tvrzená brána, kterou čísla nenesou, test shodí; nesplněná brána zapsaná poctivě sadu nečervená (verdikt
 * s důvody po větách je v README). Totéž pro čas do hratelné hry, FPS na telefonu, bajty modelů první hry a robota:
 * mediány, poměry a počty znovu ze surových běhů v `timing`, `fps`, `bytes` a `robot`.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { P62_HOLDOUT_SHA256, sha256Lf } from '../seal';

const DIR = join(process.cwd(), 'evals', 'play', 'p62');
const readLf = (name: string): string => readFileSync(join(DIR, name), 'utf8').replace(/\r\n/g, '\n');

interface Score { readonly fidelity: number; readonly wouldPlay: number; readonly reason: string }
interface Median { readonly fidelity: number; readonly wouldPlay: number; readonly n: number }
interface Gate { readonly id: string; readonly pass: boolean }
interface TimingRow { readonly id: string; readonly A: readonly number[]; readonly B: readonly number[] }
interface TimingMedian { readonly A: number; readonly B: number; readonly diff: number; readonly pairedDiff: number; readonly pass: boolean }
interface FpsScene { readonly scene: string; readonly A: readonly (number | null)[]; readonly B: readonly (number | null)[] }
interface FpsRun { readonly scenes: readonly FpsScene[]; readonly scenesMeasured: number; readonly ratioMedian: number; readonly pass: boolean }
interface BytesRow { readonly id: string; readonly A: readonly number[]; readonly B: readonly number[] }
interface RobotRow { readonly file: string; readonly botWins: boolean; readonly idleLoses: boolean; readonly replayEqual: boolean; readonly matchesServer: boolean }
interface Result {
  readonly holdout: { readonly sha256: string; readonly openedAt: string; readonly commit: string };
  readonly plan: readonly { readonly id: string; readonly rows: readonly { readonly side: string; readonly kind: string }[] }[];
  readonly sentences: readonly { readonly id: string; readonly scores: Readonly<Record<string, Score>> }[];
  readonly skipped: readonly string[];
  readonly medians: Readonly<Record<string, Median>>;
  readonly gates: readonly Gate[];
  readonly verdict: { readonly pass: boolean; readonly unmet: readonly string[] };
  readonly timing: { readonly runs: number; readonly profiles: Readonly<Record<string, readonly TimingRow[]>>; readonly medians: Readonly<Record<string, TimingMedian>>; readonly gate: Gate };
  readonly fps: { readonly runs: readonly FpsRun[]; readonly gate: Gate };
  readonly bytes: { readonly runs: number; readonly rows: readonly BytesRow[]; readonly medians: { readonly A: number; readonly B: number; readonly ratio: number; readonly pass: boolean }; readonly gate: Gate };
  readonly robot: { readonly games: number; readonly published: number; readonly rows: readonly RobotRow[]; readonly gate: Gate };
}

const result = JSON.parse(readLf('result.json')) as Result;
const readme = readLf('README.md');
const section = readme.slice(readme.indexOf('## Zapečetěná brána (T7'));

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

/** Táž sada listů pro obě strany: jen věty, kde soudce dal skóre `main` i větvi. */
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

/** Prahy z plánu P62 (Goal, T7 AC) – výsledek je nemůže posunout. */
const WOULD_PLAY_LEAD = 0.1;
const GATES: readonly Gate[] = [
  { id: 'G1', pass: round(quick.wouldPlay - mainQuick.wouldPlay) >= WOULD_PLAY_LEAD },
  { id: 'G2', pass: quick.fidelity >= mainQuick.fidelity },
  { id: 'G3', pass: after.wouldPlay >= mainAfter.wouldPlay },
];

/**
 * Čas do hratelné hry (G4): medián větve nejvýš o 200 ms nad `main` v každém profilu skriptu. FPS na telefonu (G5):
 * medián poměrů B/A přes scény ≥ 0,95 v každém běhu. Bajty modelů první hry na telefonu (G6): medián větve ≤ `main`
 * × 1,25. Robot (G7): každá hra větve na sadě – robot vyhraje, nečinný nevyhraje, přehrání shodné.
 */
const TIMING_MAX_MS = 200;
const FPS_MIN_RATIO = 0.95;
const BYTES_MAX_RATIO = 1.25;
const timingOf = (rows: readonly TimingRow[]): TimingMedian => {
  const A = median(rows.flatMap((row) => row.A));
  const B = median(rows.flatMap((row) => row.B));
  const pairedDiff = median(rows.flatMap((row) => row.B.map((b, k) => b - row.A[k]!)));
  return { A, B, diff: B - A, pairedDiff, pass: B <= A + TIMING_MAX_MS };
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
const bytesA = median(result.bytes.rows.flatMap((row) => row.A));
const bytesB = median(result.bytes.rows.flatMap((row) => row.B));
const bytes = { A: bytesA, B: bytesB, ratio: round(bytesB / bytesA), pass: bytesB <= bytesA * BYTES_MAX_RATIO };
const robotPass = result.robot.rows.length === result.robot.published && result.robot.rows.every((row) => row.botWins && row.idleLoses && row.replayEqual);
const OTHER_GATES: readonly Gate[] = [
  { id: 'G4', pass: Object.values(timing).every((profile) => profile.pass) },
  { id: 'G5', pass: fpsRuns.every((run) => run.pass) },
  { id: 'G6', pass: bytes.pass },
  { id: 'G7', pass: robotPass },
];
const ALL_GATES = [...GATES, ...OTHER_GATES];

/** Číslo jako v README: dvě desetinná místa, tři, když je třetí nenulové; desetinná čárka. */
const cz = (x: number): string => (Math.round(x * 1000) % 10 === 0 ? x.toFixed(2) : x.toFixed(3)).replace('.', ',');

describe('P62 sealed scene gate (T7)', () => {
  it('opened the sealed set once, unchanged, on the measured branch', () => {
    const opened = JSON.parse(readLf('holdout-opened.json')) as { sha256: string; openedAt: string; commit: string };
    expect(sha256Lf(readLf('holdout.json'))).toBe(P62_HOLDOUT_SHA256);
    expect(opened.sha256).toBe(P62_HOLDOUT_SHA256);
    expect(result.holdout).toMatchObject({ sha256: opened.sha256, openedAt: opened.openedAt, commit: opened.commit });
  });

  it('judged every sealed sentence on one shared sheet with main and branch rows', () => {
    const holdout = (JSON.parse(readLf('holdout.json')) as { sentences: { id: string }[] }).sentences.map((s) => s.id);
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

  it('records each gate verdict that the numbers give, in result.json and in the README', () => {
    expect(result.gates.map((gate) => [gate.id, gate.pass])).toEqual(GATES.map((gate) => [gate.id, gate.pass]));
    expect([result.timing.gate, result.fps.gate, result.bytes.gate, result.robot.gate].map((gate) => [gate.id, gate.pass])).toEqual(OTHER_GATES.map((gate) => [gate.id, gate.pass]));
    expect(result.verdict).toEqual({ pass: ALL_GATES.every((gate) => gate.pass), unmet: ALL_GATES.filter((gate) => !gate.pass).map((gate) => gate.id) });
    for (const gate of ALL_GATES) expect(section, gate.id).toMatch(new RegExp(`^\\| ${gate.id} .*\\| ${gate.pass ? 'splněna' : 'nesplněna'} \\|$`, 'm'));
  });

  it('measured time to playable on 5 dev sentences x 3 runs per side and records the medians those runs give', () => {
    for (const [profile, rows] of Object.entries(result.timing.profiles)) {
      expect(rows.map((row) => row.id), profile).toHaveLength(5);
      for (const row of rows) expect([row.A.length, row.B.length], `${profile} ${row.id}`).toEqual([result.timing.runs, result.timing.runs]);
      expect(result.timing.medians[profile], profile).toEqual(timing[profile]);
    }
    expect(Object.keys(result.timing.medians).sort()).toEqual(Object.keys(result.timing.profiles).sort());
  });

  it('records the phone FPS ratio each interleaved run gives', () => {
    expect(result.fps.runs.length).toBeGreaterThan(0);
    result.fps.runs.forEach((run, index) => expect({ scenesMeasured: run.scenesMeasured, ratioMedian: run.ratioMedian, pass: run.pass }, `run ${index}`).toEqual(fpsRuns[index]));
    for (const run of fpsRuns) expect(run.scenesMeasured).toBeGreaterThan(0);
  });

  it('records the model bytes of the first game on the phone that the HAR runs give', () => {
    expect(result.bytes.rows.length).toBeGreaterThan(0);
    for (const row of result.bytes.rows) expect([row.A.length, row.B.length], row.id).toEqual([result.bytes.runs, result.bytes.runs]);
    expect(result.bytes.medians).toEqual(bytes);
  });

  it('re-verified every game the branch published on the set: robot wins, idle loses, replay equal', () => {
    expect(result.robot.rows).toHaveLength(result.robot.games);
    expect(result.robot.games).toBeGreaterThanOrEqual(24);
  });

  it('shows the recomputed medians, times, FPS ratios and bytes in the README', () => {
    const rows = { 'main-quick': '`main` rychlá hra', 'main-after-reading': '`main` po čtení', 'p62-quick': 'P62 rychlá hra', 'p62-after-reading': 'P62 po čtení' };
    for (const [side, label] of Object.entries(rows)) {
      const { fidelity, wouldPlay, n } = sideOf(side);
      expect(section, side).toContain(`| ${label} | ${cz(fidelity)} | ${cz(wouldPlay)} | ${n} |`);
    }
    const labels: Readonly<Record<string, string>> = { desktop: 'desktop 1280×720', 'pixel7-cpu4': 'Pixel 7, CPU 4×' };
    const ms = (x: number): string => String(x).replace('.', ',');
    const signed = (x: number): string => (x < 0 ? `−${ms(-x)}` : `+${ms(x)}`);
    for (const [profile, { A, B, diff, pairedDiff, pass }] of Object.entries(timing)) {
      expect(section, profile).toContain(`| ${labels[profile]} | ${ms(A)} ms | ${ms(B)} ms | ${signed(diff)} ms | ${signed(pairedDiff)} ms | ${pass ? 'splněna' : 'nesplněna'} |`);
    }
    for (const run of fpsRuns) expect(section).toContain(`| ${run.scenesMeasured} | ${cz(run.ratioMedian)} | ${run.pass ? 'splněna' : 'nesplněna'} |`);
    const kib = (x: number): string => `${Math.round(x / 1024)} KiB`;
    expect(section).toContain(`| ${kib(bytes.A)} | ${kib(bytes.B)} | ${cz(bytes.ratio)} | ${bytes.pass ? 'splněna' : 'nesplněna'} |`);
  });

  it('gives per-sentence judge reasons in the README when a judged gate is unmet', () => {
    if (GATES.every((gate) => gate.pass)) return;
    expect(section).toContain('### Verdikt');
    for (const row of result.sentences) expect(section, row.id).toMatch(new RegExp(`^\\| ${row.id} `, 'm'));
  });
});
