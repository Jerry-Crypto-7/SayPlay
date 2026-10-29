/**
 * P64 T8: zapečetěná brána hry na výšku přepočítaná z `result.json`, ne opsaná (vzor P63 T6). Mediány se počítají znovu
 * ze skóre po větách, „po čtení“ znovu z řádků listu (hra ze čtení, když na listu je, jinak rychlá hra) a prahy jsou
 * tady z plánu P64, ne z výsledku. Totéž čas do hratelné hry (G3) ze surových běhů a FPS (G4) ze surových snímků.
 * Brána pod prahem test shodí – jedině když ji `result.json` (`verdict.unmet`) i README zapisují jako nesplněnou, je to
 * zaznamenaný verdikt a sada zůstane zelená. Tvrzená brána, kterou čísla nenesou, i „nesplněná“ brána, kterou čísla
 * nesou, test shodí.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { P64_HOLDOUT_SHA256 } from '../seal';

const DIR = join(process.cwd(), 'evals', 'play', 'p64');
const readLf = (name: string): string => readFileSync(join(DIR, name), 'utf8').replace(/\r\n/g, '\n');

interface Score { readonly fidelity: number; readonly wouldPlay: number; readonly reason: string }
interface Median { readonly fidelity: number; readonly wouldPlay: number; readonly n: number }
interface Gate { readonly id: string; readonly pass: boolean }
interface Paired { readonly id: string; readonly A: readonly number[]; readonly B: readonly number[] }
/** Běh času po bězích; `null` = hra nebyla hratelná do 120 s, do času se nepočítá. */
interface TimingRow { readonly id: string; readonly A: readonly (number | null)[]; readonly B: readonly (number | null)[] }
interface TimingMedian { readonly A: number; readonly B: number; readonly diff: number; readonly pairedDiff: number; readonly pass: boolean }
interface RobotCounts {
  readonly games: number;
  readonly quick: number;
  readonly reading: number;
  readonly server: { readonly publishEligible: number; readonly botWins: number; readonly idleLoses: number; readonly replayEqual: number };
  readonly offline: { readonly botWins: number; readonly idleLoses: number; readonly replayEqual: number; readonly sameHashesAsServer: number };
}
interface Result {
  readonly holdout: { readonly sha256: string; readonly openedAt: string; readonly commit: string; readonly sentences: number };
  readonly measurements: readonly { readonly name: string; readonly commit: string; readonly measuredAt: string }[];
  readonly plan: readonly { readonly id: string; readonly rows: readonly { readonly side: string; readonly kind: string }[] }[];
  readonly sentences: readonly { readonly id: string; readonly scores: Readonly<Record<string, Score>> }[];
  readonly skipped: readonly string[];
  readonly medians: Readonly<Record<string, Median>>;
  readonly timing: { readonly runs: number; readonly profiles: Readonly<Record<string, readonly TimingRow[]>>; readonly medians: Readonly<Record<string, TimingMedian>>; readonly gate: Gate };
  readonly fps: { readonly scenes: readonly Paired[]; readonly median: number; readonly gate: Gate };
  readonly robot: RobotCounts & { readonly sets: { readonly holdout: RobotCounts; readonly dev: RobotCounts } };
  readonly guards: { readonly G5: { readonly pass: boolean }; readonly G6: { readonly pass: boolean } };
  readonly gates: readonly Gate[];
  readonly verdict: { readonly pass: boolean; readonly unmet: readonly string[]; readonly text: string };
  readonly spend: { readonly t1: number; readonly t8: { readonly dev: { readonly usd: number }; readonly holdout: { readonly usd: number } }; readonly total: number; readonly cap: number };
}

const result = JSON.parse(readLf('result.json')) as Result;
const opened = JSON.parse(readLf('holdout-opened.json')) as { sha256: string; openedAt: string; commit: string };
const readme = readLf('README.md');
const section = readme.slice(readme.indexOf('### Zapečetěná sada: brány'));

const round = (x: number): number => Math.round(x * 1000) / 1000;
function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Hra, kterou hráč hraje po příchodu čtení: hra ze čtení, když je na listu, jinak rychlá hra. */
function played(id: string, name: 'main' | 'p64'): Score | undefined {
  const kinds = result.plan.find((item) => item.id === id)!.rows.map((row) => row.kind);
  const scores = result.sentences.find((row) => row.id === id)!.scores;
  return kinds.includes(`${name}-reading`) ? scores[`${name}-reading`] : scores[`${name}-quick`];
}

/** Táž sada listů pro obě strany: jen věty, kde soudce dal skóre `main` i větvi. */
const shared = result.sentences.filter((row) => row.scores['main-quick'] && row.scores['p64-quick']).map((row) => row.id);
const sideOf = (side: string): Median => {
  const scores = shared.map((id) => {
    if (side === 'main-after-reading') return played(id, 'main')!;
    if (side === 'p64-after-reading') return played(id, 'p64')!;
    return result.sentences.find((row) => row.id === id)!.scores[side]!;
  });
  return { fidelity: round(median(scores.map((s) => s.fidelity))), wouldPlay: round(median(scores.map((s) => s.wouldPlay))), n: scores.length };
};

const quick = sideOf('p64-quick');
const after = sideOf('p64-after-reading');
const mainQuick = sideOf('main-quick');
const mainAfter = sideOf('main-after-reading');

/** V tisícinách, ať 0,48 ≥ 0,50 − 0,02 neztratí plovoucí čárka. */
const atLeast = (x: number, floor: number): boolean => Math.round(x * 1000) >= Math.round(floor * 1000);

/** Věta → hratelná na telefonu (G3): medián větve nejvýš o 200 ms nad `main`; desktop se zapisuje bez brány. */
const TIMING_MAX_MS = 200;
const playable = (runs: readonly (number | null)[]): number[] => runs.filter((ms): ms is number => ms !== null);
const timingOf = (rows: readonly TimingRow[]): TimingMedian => {
  const A = median(rows.flatMap((row) => playable(row.A)));
  const B = median(rows.flatMap((row) => playable(row.B)));
  const pairedDiff = median(rows.flatMap((row) => row.B.flatMap((b, k) => (b === null || row.A[k] === null ? [] : [b - row.A[k]!]))));
  return { A, B, diff: B - A, pairedDiff, pass: B <= A + TIMING_MAX_MS };
};
const timing = Object.fromEntries(Object.entries(result.timing.profiles).map(([profile, rows]) => [profile, timingOf(rows)]));

/** FPS na telefonu (G4): medián poměrů B/A přes scény, poměr = medián FPS větve / medián FPS `main` ve scéně. */
const fpsMedian = round(median(result.fps.scenes.map((scene) => round(median(scene.B) / median(scene.A)))));

/** Prahy z plánu P64 (T8 AC „Brány“) – výsledek je nemůže posunout. */
const ALL_GATES: readonly Gate[] = [
  { id: 'G1', pass: atLeast(quick.wouldPlay, mainQuick.wouldPlay + 0.05) && atLeast(after.wouldPlay, mainAfter.wouldPlay) },
  { id: 'G2', pass: atLeast(quick.fidelity, mainQuick.fidelity - 0.02) && atLeast(after.fidelity, mainAfter.fidelity - 0.02) },
  { id: 'G3', pass: timing['pixel7-cpu4']!.pass },
  { id: 'G4', pass: atLeast(fpsMedian, 0.95) },
  { id: 'G5', pass: result.guards.G5.pass },
  { id: 'G6', pass: result.guards.G6.pass },
];

/** Strop čtení celého plánu P64 v USD. */
const SPEND_CAP_USD = 4;

/** Číslo jako v README: dvě desetinná místa, tři, když je třetí nenulové; desetinná čárka. */
const cz = (x: number): string => (Math.round(x * 1000) % 10 === 0 ? x.toFixed(2) : x.toFixed(3)).replace('.', ',');

describe('P64 sealed portrait gate (T8)', () => {
  it('opened the sealed set once, at its sealed fingerprint, before the branch was shot', () => {
    expect(opened.sha256).toBe(P64_HOLDOUT_SHA256);
    expect(result.holdout).toMatchObject({ sha256: P64_HOLDOUT_SHA256, openedAt: opened.openedAt, commit: opened.commit, sentences: 24 });
    const branch = result.measurements.find((m) => m.name === 'p64')!;
    expect(branch.commit).toBe(opened.commit);
    expect(Date.parse(opened.openedAt)).toBeLessThan(Date.parse(branch.measuredAt));
  });

  it('judged every sealed sentence on one shared sheet with main and P64 rows', () => {
    const holdout = (JSON.parse(readLf('holdout.json')) as { sentences: { id: string }[] }).sentences.map((s) => s.id);
    expect([...result.sentences.map((row) => row.id), ...result.skipped].sort()).toEqual([...holdout].sort());
    for (const item of result.plan) {
      const kinds = item.rows.map((row) => row.kind);
      expect(kinds, item.id).toEqual(expect.arrayContaining(['main-quick', 'p64-quick']));
      const scores = result.sentences.find((row) => row.id === item.id)?.scores;
      if (scores) for (const kind of kinds) expect(scores[kind], `${item.id} ${kind}`).toBeDefined();
    }
    expect(shared).toHaveLength(result.sentences.length);
  });

  it('records medians that the per-sentence scores give', () => {
    for (const side of ['main-quick', 'main-after-reading', 'p64-quick', 'p64-after-reading']) expect(result.medians[side], side).toEqual(sideOf(side));
  });

  for (const gate of ALL_GATES) {
    it(`${gate.id} holds at its plan threshold, or is a recorded unmet verdict`, () => {
      const recordedUnmet = result.verdict.unmet.includes(gate.id);
      expect(gate.pass, `${gate.id} ${recordedUnmet ? 'recorded unmet but the numbers meet it' : 'is below its threshold'}`).toBe(!recordedUnmet);
      expect(section, gate.id).toMatch(new RegExp(`^\\| ${gate.id} .*\\| ${gate.pass ? 'splněna' : 'nesplněna'} \\|$`, 'm'));
    });
  }

  it('records the gate verdicts the numbers give in result.json', () => {
    expect(result.gates.map((gate) => [gate.id, gate.pass])).toEqual(ALL_GATES.map((gate) => [gate.id, gate.pass]));
    const pass = ALL_GATES.every((gate) => gate.pass);
    expect(result.verdict).toEqual({ pass, unmet: ALL_GATES.filter((gate) => !gate.pass).map((gate) => gate.id), text: pass ? 'připraveno k sloučení' : 'nepřipraveno k sloučení' });
    expect(section).toContain(`**Verdikt: ${result.verdict.text}.**`);
  });

  it('measured time to playable on 5 dev sentences x 3 runs per side (a failed run is null) and records the medians those runs give', () => {
    expect(Object.keys(result.timing.profiles).sort()).toEqual(['desktop', 'pixel7-cpu4']);
    for (const [profile, rows] of Object.entries(result.timing.profiles)) {
      expect(rows.map((row) => row.id), profile).toHaveLength(5);
      for (const row of rows) expect([row.A.length, row.B.length], `${profile} ${row.id}`).toEqual([result.timing.runs, result.timing.runs]);
      expect(result.timing.medians[profile], profile).toEqual(timing[profile]);
    }
    expect(result.timing.runs).toBe(3);
    expect(result.timing.gate).toEqual({ id: 'G3', pass: timing['pixel7-cpu4']!.pass });
  });

  it('shows the recomputed time-to-playable medians in the README', () => {
    const labels: Readonly<Record<string, string>> = { 'pixel7-cpu4': 'Pixel 7, CPU 4×', desktop: 'desktop 1280×720' };
    const signed = (x: number): string => (x < 0 ? `−${String(-x)}` : `+${String(x)}`);
    for (const [profile, { A, B, diff, pairedDiff, pass }] of Object.entries(timing)) {
      const verdict = profile === 'pixel7-cpu4' ? (pass ? 'splněna' : 'nesplněna') : 'bez brány';
      expect(section, profile).toContain(`| ${labels[profile]} | ${A} ms | ${B} ms | ${signed(diff)} ms | ${signed(pairedDiff)} ms | ${verdict} |`);
    }
  });

  it('recomputes the phone FPS ratio from the raw runs of every scene', () => {
    expect(result.fps.scenes.length).toBeGreaterThanOrEqual(5);
    for (const scene of result.fps.scenes) expect([scene.A.length, scene.B.length], scene.id).toEqual([3, 3]);
    expect(result.fps.median).toBe(fpsMedian);
    expect(result.fps.gate).toEqual({ id: 'G4', pass: atLeast(fpsMedian, 0.95) });
    expect(section).toContain(`| Medián B/A | ${cz(fpsMedian)} |`);
  });

  it('ran robot, idle player and replay on every game the sheets judged, and all of them hold', () => {
    const { holdout, dev } = result.robot.sets;
    expect(holdout.quick).toBe(result.holdout.sentences);
    expect(holdout.reading).toBe(result.plan.filter((item) => item.rows.some((row) => row.kind === 'p64-reading')).length);
    expect(dev.quick).toBe(12);
    for (const [name, counts] of Object.entries({ all: result.robot, holdout, dev })) {
      expect(counts.games, name).toBe(counts.quick + counts.reading);
      expect(counts.server, name).toEqual({ publishEligible: counts.games, botWins: counts.games, idleLoses: counts.games, replayEqual: counts.games });
      expect(counts.offline, name).toEqual({ botWins: counts.games, idleLoses: counts.games, replayEqual: counts.games, sameHashesAsServer: counts.games });
    }
    expect(result.robot.games).toBe(holdout.games + dev.games);
    expect(section).toContain(`| Celkem | ${result.robot.games} | ${result.robot.offline.botWins} | ${result.robot.offline.idleLoses} | ${result.robot.offline.replayEqual} |`);
  });

  it('shows the recomputed medians in the README table', () => {
    const rows = { 'main-quick': '`main` rychlá hra', 'main-after-reading': '`main` po čtení', 'p64-quick': 'P64 rychlá hra', 'p64-after-reading': 'P64 po čtení' };
    for (const [side, label] of Object.entries(rows)) {
      const { fidelity, wouldPlay, n } = sideOf(side);
      expect(section, side).toContain(`| ${label} | ${cz(fidelity)} | ${cz(wouldPlay)} | ${n} |`);
    }
  });

  it('gives a per-sentence verdict with reasons in the README when a gate is unmet', () => {
    if (ALL_GATES.every((gate) => gate.pass)) return;
    expect(section).toContain('### Verdikt po větách');
    for (const row of result.sentences) expect(section, row.id).toMatch(new RegExp(`^\\| ${row.id} .+\\|.+\\|$`, 'm'));
  });

  it('keeps the plan reading spend within its cap and writes the total in the README', () => {
    expect(result.spend.cap).toBe(SPEND_CAP_USD);
    expect(result.spend.total).toBe(round(result.spend.t1 + result.spend.t8.dev.usd + result.spend.t8.holdout.usd));
    expect(result.spend.total).toBeLessThanOrEqual(SPEND_CAP_USD);
    expect(readme).toContain(`| **Celkem** | **${result.spend.total.toFixed(3).replace('.', ',')}** |`);
  });
});
