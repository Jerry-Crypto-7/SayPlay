/**
 * P61 T8: zapečetěná brána přepočítaná z `result.json`, ne opsaná. Mediány se počítají znovu ze skóre po větách,
 * „po čtení“ znovu z řádků listu (hra ze čtení, když na listu je, jinak rychlá hra) a prahy jsou tady z plánu, ne
 * z výsledku. Každá brána musí mít v `result.json` i v README tentýž verdikt, jaký dávají čísla: tvrzená brána,
 * kterou čísla nenesou, test shodí; nesplněná brána zapsaná poctivě sadu nečervená (verdikt je v README).
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const DIR = join(process.cwd(), 'evals', 'play', 'p61');
const readLf = (name: string): string => readFileSync(join(DIR, name), 'utf8').replace(/\r\n/g, '\n');

interface Score { readonly fidelity: number; readonly wouldPlay: number; readonly reason: string }
interface Median { readonly fidelity: number; readonly wouldPlay: number; readonly n: number }
interface Gate { readonly id: string; readonly pass: boolean }
interface Result {
  readonly plan: readonly { readonly id: string; readonly rows: readonly { readonly side: string; readonly kind: string }[] }[];
  readonly sentences: readonly { readonly id: string; readonly scores: Readonly<Record<string, Score>> }[];
  readonly skipped: readonly string[];
  readonly medians: Readonly<Record<string, Median>>;
  readonly gates: readonly Gate[];
  readonly verdict: { readonly pass: boolean; readonly unmet: readonly string[] };
}

const result = JSON.parse(readLf('result.json')) as Result;
const readme = readLf('README.md');
const section = readme.slice(readme.indexOf('## T8 – zapečetěná brána'));

const round = (x: number): number => Math.round(x * 1000) / 1000;
function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Hra, kterou hráč hraje po příchodu čtení: hra ze čtení, když je na listu, jinak rychlá hra. */
function played(id: string, name: 'main' | 'p61'): Score | undefined {
  const kinds = result.plan.find((item) => item.id === id)!.rows.map((row) => row.kind);
  const scores = result.sentences.find((row) => row.id === id)!.scores;
  return kinds.includes(`${name}-reading`) ? scores[`${name}-reading`] : scores[`${name}-quick`];
}

/** Táž sada listů pro obě strany: jen věty, kde soudce dal skóre `main` i větvi. */
const shared = result.sentences.filter((row) => row.scores['main-quick'] && row.scores['p61-quick']).map((row) => row.id);
const sideOf = (side: string): Median => {
  const scores = shared.map((id) => {
    if (side === 'main-after-reading') return played(id, 'main')!;
    if (side === 'p61-after-reading') return played(id, 'p61')!;
    return result.sentences.find((row) => row.id === id)!.scores[side]!;
  });
  return { fidelity: round(median(scores.map((s) => s.fidelity))), wouldPlay: round(median(scores.map((s) => s.wouldPlay))), n: scores.length };
};

const quick = sideOf('p61-quick');
const after = sideOf('p61-after-reading');
const mainQuick = sideOf('main-quick');
const mainAfter = sideOf('main-after-reading');

/** Prahy z plánu P61 (Goal, T8 AC) – výsledek je nemůže posunout. */
const GATES: readonly { readonly id: string; readonly pass: boolean }[] = [
  { id: 'G1', pass: quick.fidelity >= 0.5 },
  { id: 'G2', pass: quick.wouldPlay >= 0.5 },
  { id: 'G3', pass: after.fidelity >= 0.75 },
  { id: 'G4', pass: after.wouldPlay >= 0.7 },
  { id: 'G5', pass: quick.fidelity > mainQuick.fidelity && quick.wouldPlay > mainQuick.wouldPlay },
  { id: 'G6', pass: after.fidelity > mainAfter.fidelity && after.wouldPlay > mainAfter.wouldPlay },
];

/** Číslo jako v README: dvě desetinná místa, tři, když je třetí nenulové; desetinná čárka. */
const cz = (x: number): string => (Math.round(x * 1000) % 10 === 0 ? x.toFixed(2) : x.toFixed(3)).replace('.', ',');

describe('P61 sealed quality gate (T8)', () => {
  it('judged every sealed sentence on one shared sheet with main and branch rows', () => {
    const holdout = (JSON.parse(readLf('holdout.json')) as { sentences: { id: string }[] }).sentences.map((s) => s.id);
    expect([...result.sentences.map((row) => row.id), ...result.skipped].sort()).toEqual([...holdout].sort());
    for (const item of result.plan) {
      const kinds = item.rows.map((row) => row.kind);
      expect(kinds, item.id).toEqual(expect.arrayContaining(['main-quick', 'p61-quick']));
      const scores = result.sentences.find((row) => row.id === item.id)?.scores;
      if (scores) for (const kind of kinds) expect(scores[kind], `${item.id} ${kind}`).toBeDefined();
    }
    expect(shared).toHaveLength(result.sentences.length);
  });

  it('records after-reading as the reading game when the sheet has one, else the quick game', () => {
    for (const row of result.sentences) {
      expect(row.scores['main-after-reading'], row.id).toEqual(played(row.id, 'main'));
      expect(row.scores['p61-after-reading'], row.id).toEqual(played(row.id, 'p61'));
    }
  });

  it('records medians that the per-sentence scores give', () => {
    for (const side of ['main-quick', 'main-after-reading', 'p61-quick', 'p61-after-reading']) expect(result.medians[side], side).toEqual(sideOf(side));
  });

  it('records each gate verdict that the numbers give, in result.json and in the README', () => {
    expect(result.gates.map((gate) => [gate.id, gate.pass])).toEqual(GATES.map((gate) => [gate.id, gate.pass]));
    expect(result.verdict).toEqual({ pass: GATES.every((gate) => gate.pass), unmet: GATES.filter((gate) => !gate.pass).map((gate) => gate.id) });
    for (const gate of GATES) expect(section, gate.id).toMatch(new RegExp(`^\\| ${gate.id} .*\\| ${gate.pass ? 'splněna' : 'nesplněna'} \\|$`, 'm'));
  });

  it('shows the recomputed medians in the README table', () => {
    const rows = { 'main-quick': '`main` rychlá hra', 'main-after-reading': '`main` po čtení', 'p61-quick': 'P61 rychlá hra', 'p61-after-reading': 'P61 po čtení' };
    for (const [side, label] of Object.entries(rows)) {
      const { fidelity, wouldPlay, n } = sideOf(side);
      expect(section, side).toContain(`| ${label} | ${cz(fidelity)} | ${cz(wouldPlay)} | ${n} |`);
    }
  });

  it('gives per-sentence judge reasons in the README when a gate is unmet', () => {
    if (GATES.every((gate) => gate.pass)) return;
    expect(section).toContain('### Verdikt');
    for (const row of result.sentences) expect(section, row.id).toMatch(new RegExp(`^\\| ${row.id} `, 'm'));
  });
});
