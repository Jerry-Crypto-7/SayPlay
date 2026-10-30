/**
 * P64 T8-R3 krok 3: brána na druhé zapečetěné sadě přepočítaná z `result-r3.json`, ne opsaná (vzor `result.test.ts`).
 * G1 a G2 se počítají znovu ze skóre po větách s prahy z plánu P64; G3–G5 nese T8 (`result.json`) beze změny, G6
 * přeměřila T8-R2. Brána, kterou čísla nenesou, nebo verdikt, který neodpovídá branám, test shodí.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { P64_R3_HOLDOUT_SHA256 } from '../seal';

const DIR = join(process.cwd(), 'evals', 'play', 'p64');
const readLf = (name: string): string => readFileSync(join(DIR, name), 'utf8').replace(/\r\n/g, '\n');

interface Score { readonly fidelity: number; readonly wouldPlay: number; readonly reason: string }
interface Median { readonly fidelity: number; readonly wouldPlay: number; readonly n: number }
interface Gate { readonly id: string; readonly pass: boolean }
interface Games { readonly games: number; readonly saved: number; readonly chains: number; readonly publishEligible: number }
interface Result {
  readonly holdout: { readonly sha256: string; readonly openedAt: string; readonly commit: string; readonly sentences: number };
  readonly measurements: readonly { readonly name: string; readonly commit: string; readonly measuredAt: string }[];
  readonly plan: readonly { readonly id: string; readonly rows: readonly { readonly side: string; readonly kind: string }[] }[];
  readonly sentences: readonly { readonly id: string; readonly scores: Readonly<Record<string, Score>> }[];
  readonly skipped: readonly string[];
  readonly medians: Readonly<Record<string, Median>>;
  readonly gates: readonly Gate[];
  readonly verdict: { readonly pass: boolean; readonly unmet: readonly string[]; readonly text: string };
  readonly games: { readonly main: Games; readonly p64: Games };
  readonly spend: { readonly before: number; readonly r3: { readonly main: { readonly usd: number }; readonly p64: { readonly usd: number } }; readonly total: number; readonly cap: number };
}

const result = JSON.parse(readLf('result-r3.json')) as Result;
const t8 = JSON.parse(readLf('result.json')) as { gates: readonly Gate[]; spend: { total: number } };
const opened = JSON.parse(readLf('r3/holdout-opened.json')) as { sha256: string; openedAt: string; commit: string };
const readme = readLf('README.md');
const section = readme.slice(readme.indexOf('### Krok 3: nová zapečetěná sada'));

const round = (x: number): number => Math.round(x * 1000) / 1000;
function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}
const atLeast = (x: number, floor: number): boolean => Math.round(x * 1000) >= Math.round(floor * 1000);

/** Hra, kterou hráč hraje po příchodu čtení: hra ze čtení, když je na listu, jinak rychlá hra. */
function played(id: string, name: 'main' | 'p64'): Score {
  const kinds = result.plan.find((item) => item.id === id)!.rows.map((row) => row.kind);
  const scores = result.sentences.find((row) => row.id === id)!.scores;
  return (kinds.includes(`${name}-reading`) ? scores[`${name}-reading`] : scores[`${name}-quick`])!;
}
const shared = result.sentences.filter((row) => row.scores['main-quick'] && row.scores['p64-quick']).map((row) => row.id);
function sideOf(side: string): Median {
  const scores = shared.map((id) => {
    if (side === 'main-after-reading') return played(id, 'main');
    if (side === 'p64-after-reading') return played(id, 'p64');
    return result.sentences.find((row) => row.id === id)!.scores[side]!;
  });
  return { fidelity: round(median(scores.map((s) => s.fidelity))), wouldPlay: round(median(scores.map((s) => s.wouldPlay))), n: scores.length };
}
const [mainQuick, mainAfter, quick, after] = ['main-quick', 'main-after-reading', 'p64-quick', 'p64-after-reading'].map(sideOf) as [Median, Median, Median, Median];

/** Prahy z plánu P64 (T8 AC „Brány“); G3–G5 z T8, G6 z přeměření T8-R2 (regrese není). */
const GATES: readonly Gate[] = [
  { id: 'G1', pass: atLeast(quick.wouldPlay, mainQuick.wouldPlay + 0.05) && atLeast(after.wouldPlay, mainAfter.wouldPlay) },
  { id: 'G2', pass: atLeast(quick.fidelity, mainQuick.fidelity - 0.02) && atLeast(after.fidelity, mainAfter.fidelity - 0.02) },
  ...['G3', 'G4', 'G5'].map((id) => ({ id, pass: t8.gates.find((gate) => gate.id === id)!.pass })),
  { id: 'G6', pass: true },
];

const cz = (x: number): string => (Math.round(x * 1000) % 10 === 0 ? x.toFixed(2) : x.toFixed(3)).replace('.', ',');

describe('P64 second sealed portrait gate (T8-R3)', () => {
  it('opened the second sealed set once, at its sealed fingerprint, before either side was shot', () => {
    expect(opened.sha256).toBe(P64_R3_HOLDOUT_SHA256);
    expect(result.holdout).toMatchObject({ sha256: P64_R3_HOLDOUT_SHA256, openedAt: opened.openedAt, commit: opened.commit, sentences: 24 });
    expect(result.measurements.map((m) => m.name).sort()).toEqual(['main', 'p64']);
    for (const m of result.measurements) expect(Date.parse(opened.openedAt), m.name).toBeLessThan(Date.parse(m.measuredAt));
  });

  it('judged every sealed sentence on one shared sheet with main and P64 rows', () => {
    const ids = (JSON.parse(readLf('r3/holdout.json')) as { sentences: { id: string }[] }).sentences.map((s) => s.id);
    expect([...result.sentences.map((row) => row.id), ...result.skipped].sort()).toEqual([...ids].sort());
    for (const item of result.plan) {
      const kinds = item.rows.map((row) => row.kind);
      expect(kinds, item.id).toEqual(expect.arrayContaining(['main-quick', 'p64-quick']));
      const scores = result.sentences.find((row) => row.id === item.id)?.scores;
      if (scores) for (const kind of kinds) expect(scores[kind], `${item.id} ${kind}`).toBeDefined();
    }
    expect(shared).toHaveLength(result.sentences.length);
  });

  it('records the medians the per-sentence scores give and shows them in the README', () => {
    const rows = { 'main-quick': '`main` rychlá hra', 'main-after-reading': '`main` po čtení', 'p64-quick': 'P64 rychlá hra', 'p64-after-reading': 'P64 po čtení' };
    for (const [side, label] of Object.entries(rows)) {
      expect(result.medians[side], side).toEqual(sideOf(side));
      const { fidelity, wouldPlay, n } = sideOf(side);
      expect(section, side).toContain(`| ${label} | ${cz(fidelity)} | ${cz(wouldPlay)} | ${n} |`);
    }
  });

  it('records the gates the thresholds give, carries G3–G5 from T8 and derives the verdict from them', () => {
    expect(result.gates.map(({ id, pass }) => ({ id, pass }))).toEqual(GATES);
    const unmet = GATES.filter((gate) => !gate.pass).map((gate) => gate.id);
    expect(result.verdict).toEqual({ pass: unmet.length === 0, unmet, text: unmet.length === 0 ? 'připraveno k sloučení' : 'nepřipraveno k sloučení' });
    for (const gate of GATES) expect(section, gate.id).toMatch(new RegExp(`^\\| ${gate.id} .+\\| ${gate.pass ? 'splněna' : 'nesplněna'} \\|$`, 'm'));
    expect(section).toContain(`**Verdikt: ${result.verdict.text}.**`);
  });

  it('saved every game both sides built, all publishable', () => {
    for (const [name, games] of Object.entries(result.games)) {
      expect(games.saved, name).toBe(games.games);
      expect(games.publishEligible, name).toBe(games.games);
      expect(games.games, name).toBeGreaterThanOrEqual(result.holdout.sentences);
    }
  });

  it('keeps the plan reading spend within its 4 USD cap and writes the total in the README', () => {
    expect(result.spend.before).toBe(t8.spend.total);
    expect(result.spend.total).toBe(round(result.spend.before + result.spend.r3.main.usd + result.spend.r3.p64.usd));
    expect(result.spend.cap).toBe(4);
    expect(result.spend.total).toBeLessThanOrEqual(4);
    expect(section).toContain(`| **Celkem P64** | **${result.spend.total.toFixed(3).replace('.', ',')}** |`);
  });
});
