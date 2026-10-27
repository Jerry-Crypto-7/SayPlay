/**
 * P63 T6: zapečetěná brána hry po čtení přepočítaná z `result.json`, ne opsaná (vzor P61 T8). Mediány se počítají znovu
 * ze skóre po větách, „po čtení“ znovu z řádků listu (hra ze čtení, když na listu je, jinak rychlá hra) a prahy jsou
 * tady z plánu P63, ne z výsledku. Brána pod prahem test shodí – jedině když ji `result.json` (`verdict.unmet`) i README
 * zapisují jako nesplněnou, je to zaznamenaný verdikt a sada zůstane zelená. Tvrzená brána, kterou čísla nenesou, i
 * „nesplněná“ brána, kterou čísla nesou, test shodí.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { P63_HOLDOUT_SHA256 } from '../seal';

const DIR = join(process.cwd(), 'evals', 'play', 'p63');
const readLf = (name: string): string => readFileSync(join(DIR, name), 'utf8').replace(/\r\n/g, '\n');

interface Score { readonly fidelity: number; readonly wouldPlay: number; readonly reason: string }
interface Median { readonly fidelity: number; readonly wouldPlay: number; readonly n: number }
interface Gate { readonly id: string; readonly pass: boolean }
interface Result {
  readonly holdout: { readonly sha256: string; readonly openedAt: string; readonly commit: string; readonly sentences: number };
  readonly measurements: readonly { readonly name: string; readonly commit: string; readonly measuredAt: string }[];
  readonly plan: readonly { readonly id: string; readonly rows: readonly { readonly side: string; readonly kind: string }[] }[];
  readonly sentences: readonly { readonly id: string; readonly scores: Readonly<Record<string, Score>> }[];
  readonly skipped: readonly string[];
  readonly medians: Readonly<Record<string, Median>>;
  readonly gates: readonly Gate[];
  readonly verdict: { readonly pass: boolean; readonly unmet: readonly string[] };
  readonly spend: { readonly t6: { readonly calls: number; readonly usd: number }; readonly before: number; readonly total: number; readonly cap: number };
}

const result = JSON.parse(readLf('result.json')) as Result;
const opened = JSON.parse(readLf('holdout-opened.json')) as { sha256: string; openedAt: string; commit: string };
const readme = readLf('README.md');
const section = readme.slice(readme.indexOf('## T6: zapečetěná brána'));

const round = (x: number): number => Math.round(x * 1000) / 1000;
function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Hra, kterou hráč hraje po příchodu čtení: hra ze čtení, když je na listu, jinak rychlá hra. */
function played(id: string, name: 'main' | 'p63'): Score | undefined {
  const kinds = result.plan.find((item) => item.id === id)!.rows.map((row) => row.kind);
  const scores = result.sentences.find((row) => row.id === id)!.scores;
  return kinds.includes(`${name}-reading`) ? scores[`${name}-reading`] : scores[`${name}-quick`];
}

/** Táž sada listů pro obě strany: jen věty, kde soudce dal skóre `main` i větvi. */
const shared = result.sentences.filter((row) => row.scores['main-quick'] && row.scores['p63-quick']).map((row) => row.id);
const sideOf = (side: string): Median => {
  const scores = shared.map((id) => {
    if (side === 'main-after-reading') return played(id, 'main')!;
    if (side === 'p63-after-reading') return played(id, 'p63')!;
    return result.sentences.find((row) => row.id === id)!.scores[side]!;
  });
  return { fidelity: round(median(scores.map((s) => s.fidelity))), wouldPlay: round(median(scores.map((s) => s.wouldPlay))), n: scores.length };
};

const quick = sideOf('p63-quick');
const after = sideOf('p63-after-reading');
const mainQuick = sideOf('main-quick');
const mainAfter = sideOf('main-after-reading');

/** V tisícinách, ať 0,48 ≥ 0,50 − 0,02 neztratí plovoucí čárka. */
const atLeast = (x: number, floor: number): boolean => Math.round(x * 1000) >= Math.round(floor * 1000);

/** Prahy z plánu P63 (T6 AC „Brány“) – výsledek je nemůže posunout. */
const GATES: readonly Gate[] = [
  { id: 'G1', pass: atLeast(after.fidelity, 0.75) },
  { id: 'G2', pass: atLeast(after.fidelity, mainAfter.fidelity) },
  { id: 'G3', pass: atLeast(after.wouldPlay, 0.7) },
  { id: 'G4', pass: atLeast(after.wouldPlay, mainAfter.wouldPlay) },
  { id: 'G5', pass: atLeast(quick.fidelity, mainQuick.fidelity - 0.02) },
  { id: 'G6', pass: atLeast(quick.wouldPlay, mainQuick.wouldPlay - 0.02) },
];

/** Strop čtení celého plánu P63 v USD. */
const SPEND_CAP_USD = 4;

/** Číslo jako v README: dvě desetinná místa, tři, když je třetí nenulové; desetinná čárka. */
const cz = (x: number): string => (Math.round(x * 1000) % 10 === 0 ? x.toFixed(2) : x.toFixed(3)).replace('.', ',');

describe('P63 sealed reading gate (T6)', () => {
  it('opened the sealed set once, at its sealed fingerprint, before the branch was shot', () => {
    expect(opened.sha256).toBe(P63_HOLDOUT_SHA256);
    expect(result.holdout).toMatchObject({ sha256: P63_HOLDOUT_SHA256, openedAt: opened.openedAt, commit: opened.commit, sentences: 24 });
    const branch = result.measurements.find((m) => m.name === 'p63')!;
    expect(branch.commit).toBe(opened.commit);
    expect(Date.parse(opened.openedAt)).toBeLessThan(Date.parse(branch.measuredAt));
  });

  it('judged every sealed sentence on one shared sheet with main and P63 rows', () => {
    const holdout = (JSON.parse(readLf('holdout.json')) as { sentences: { id: string }[] }).sentences.map((s) => s.id);
    expect([...result.sentences.map((row) => row.id), ...result.skipped].sort()).toEqual([...holdout].sort());
    for (const item of result.plan) {
      const kinds = item.rows.map((row) => row.kind);
      expect(kinds, item.id).toEqual(expect.arrayContaining(['main-quick', 'p63-quick']));
      const scores = result.sentences.find((row) => row.id === item.id)?.scores;
      if (scores) for (const kind of kinds) expect(scores[kind], `${item.id} ${kind}`).toBeDefined();
    }
    expect(shared).toHaveLength(result.sentences.length);
  });

  it('records after-reading as the reading game when the sheet has one, else the quick game', () => {
    for (const row of result.sentences) {
      expect(row.scores['main-after-reading'], row.id).toEqual(played(row.id, 'main'));
      expect(row.scores['p63-after-reading'], row.id).toEqual(played(row.id, 'p63'));
    }
  });

  it('records medians that the per-sentence scores give', () => {
    for (const side of ['main-quick', 'main-after-reading', 'p63-quick', 'p63-after-reading']) expect(result.medians[side], side).toEqual(sideOf(side));
  });

  for (const gate of GATES) {
    it(`${gate.id} holds at its plan threshold, or is a recorded unmet verdict`, () => {
      const recordedUnmet = result.verdict.unmet.includes(gate.id);
      expect(gate.pass, `${gate.id} ${recordedUnmet ? 'recorded unmet but the numbers meet it' : 'is below its threshold'}`).toBe(!recordedUnmet);
      expect(section, gate.id).toMatch(new RegExp(`^\\| ${gate.id} .*\\| ${gate.pass ? 'splněna' : 'nesplněna'} \\|$`, 'm'));
    });
  }

  it('records the gate verdicts the numbers give in result.json', () => {
    expect(result.gates.map((gate) => [gate.id, gate.pass])).toEqual(GATES.map((gate) => [gate.id, gate.pass]));
    expect(result.verdict).toEqual({ pass: GATES.every((gate) => gate.pass), unmet: GATES.filter((gate) => !gate.pass).map((gate) => gate.id) });
  });

  it('shows the recomputed medians in the README table', () => {
    const rows = { 'main-quick': '`main` rychlá hra', 'main-after-reading': '`main` po čtení', 'p63-quick': 'P63 rychlá hra', 'p63-after-reading': 'P63 po čtení' };
    for (const [side, label] of Object.entries(rows)) {
      const { fidelity, wouldPlay, n } = sideOf(side);
      expect(section, side).toContain(`| ${label} | ${cz(fidelity)} | ${cz(wouldPlay)} | ${n} |`);
    }
  });

  it('gives a per-sentence verdict with reasons in the README when a gate is unmet', () => {
    if (GATES.every((gate) => gate.pass)) return;
    expect(section).toContain('### Verdikt');
    for (const row of result.sentences) expect(section, row.id).toMatch(new RegExp(`^\\| ${row.id} .+\\|.+\\|$`, 'm'));
  });

  it('keeps the plan reading spend within its cap and writes the total in the README', () => {
    expect(result.spend.cap).toBe(SPEND_CAP_USD);
    expect(result.spend.total).toBe(round(result.spend.before + result.spend.t6.usd));
    expect(result.spend.total).toBeLessThanOrEqual(SPEND_CAP_USD);
    expect(readme).toContain(`| **Celkem** | **${result.spend.total.toFixed(3).replace('.', ',')}** |`);
  });
});
