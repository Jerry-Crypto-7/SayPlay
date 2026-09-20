/**
 * **Report živého gauntletu – pin na jmenovatel a na poctivou nulu (P22 T17).**
 *
 * Artefakt `gauntlet.json` má dvě vlastnosti, které se dají zadarmo zfalšovat.
 * **Chybějící řádek:** report o patnácti větách místo šestnácti, kde ta
 * šestnáctá nedoběhla, ukáže lepší medián i lepší podíl čitelných. **Nula
 * místo `null`:** věta, jejíž volání plánovače selhalo, by se se skóre 0
 * tvářila jako naměřená a stáhla by medián dolů, i když model nic nenapsal.
 * Sada proto soudí artefakt, ne kód: šestnáct řádků v šestnácti kategoriích
 * mimo ty čtyři vyloučené, `effort` i `plannerEffort` přiznané, volání pod
 * stropem, a každá věta bez odpovědi má `scoreSemantics: null`. Druhá polovina
 * sady soudí `gauntlet-score.ts`, které souhrn počítá – tam se nula-místo-null
 * dá vyrobit i bez živého běhu.
 *
 * Znovu naměřit (jeden živý běh, `WORLDSMITH_CALL_CAP=16`, rozpočet v plánu P22):
 *
 *     npx vitest run --config vitest.measure.mts evals/worldstream/gauntlet/gauntlet.measure.ts
 */

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { EXCLUDED_CATEGORIES, scoreAnswer, summarize, type GauntletCase } from '../gauntlet-score';

const REPORT_FILE = fileURLToPath(new URL('../gauntlet.json', import.meta.url));
const PROMPTS_FILE = fileURLToPath(new URL('../prompts.json', import.meta.url));
const ANSWERS_DIR = fileURLToPath(new URL('../gauntlet-answers', import.meta.url));

interface GauntletRun {
  readonly measuredAt: string;
  readonly model: string;
  readonly effort: string;
  readonly plannerEffort: string;
  readonly calls: number;
  readonly callCap: number;
  readonly partial: boolean;
  readonly reason: string | null;
  readonly summary: {
    readonly total: number;
    readonly readable: number;
    readonly readableShare: number;
    readonly medianPlannerMs: number | null;
    readonly medianScore: number | null;
  };
  readonly cases: readonly GauntletCase[];
}

interface GauntletReport {
  readonly seed: number;
  readonly sample: readonly { readonly id: string; readonly category: string }[];
  readonly runs: readonly GauntletRun[];
}

const { categories } = JSON.parse(readFileSync(PROMPTS_FILE, 'utf8')) as { categories: readonly string[] };
const SAMPLED = categories.filter((category) => !(EXCLUDED_CATEGORIES as readonly string[]).includes(category));

describe('gauntlet.json – jeden živý běh plánovače nad vzorkem šestnácti vět', () => {
  // Chybějící artefakt je červená, ne přeskočená sada – ale sada o skóre pod ní má běžet i tak.
  const report = (existsSync(REPORT_FILE) ? JSON.parse(readFileSync(REPORT_FILE, 'utf8')) : { seed: 0, sample: [], runs: [] }) as GauntletReport;
  const run = report.runs[0] ?? { measuredAt: '', model: '', effort: '', plannerEffort: '', calls: 0, callCap: 0, partial: true, reason: null, summary: summarize([]), cases: [] };

  it('vzorek: šestnáct vět, jedna na kategorii mimo čtyři vyloučené, semínko 4021', () => {
    expect(existsSync(REPORT_FILE), 'gauntlet.json chybí – živý běh se ještě nestal').toBe(true);
    expect(report.seed).toBe(4021);
    expect(SAMPLED).toHaveLength(16);
    expect(report.sample.map((entry) => entry.category)).toEqual(SAMPLED);
    expect(Array.isArray(report.runs), 'artefakt není pole běhů – druhý běh by přepsal první').toBe(true);
    expect(report.runs.length).toBeGreaterThanOrEqual(1);
  });

  it('jmenovatel je šestnáct řádků i při částečném běhu, a souhrn s nimi sedí', () => {
    expect(run.cases).toHaveLength(16);
    expect(run.summary.total).toBe(16);
    expect(run.cases.map((entry) => entry.id)).toEqual(report.sample.map((entry) => entry.id));
    expect(new Set(run.cases.map((entry) => entry.category)).size).toBe(16);
    for (const entry of run.cases) expect(EXCLUDED_CATEGORIES, entry.id).not.toContain(entry.category);
    expect(run.summary).toEqual(summarize(run.cases));
    // Částečný běh se přiznává jménem důvodu, ne tichým chybějícím řádkem.
    if (run.partial) expect(run.reason?.length ?? 0, 'částečný běh bez důvodu').toBeGreaterThan(0);
    else expect(run.cases.every((entry) => entry.answerBytes !== null), 'věta bez odpovědi v běhu, který se hlásí jako celý').toBe(true);
  });

  it('úsilí je přiznané a volání nepřekročila strop šestnácti', () => {
    expect(run.effort.length).toBeGreaterThan(0);
    expect(run.plannerEffort.length).toBeGreaterThan(0);
    expect(run.model).toContain(`@${run.effort}`);
    expect(run.callCap).toBe(16);
    expect(run.calls).toBeLessThanOrEqual(16);
    // Čas volání nese každá věta, která k modelu došla – i ta, jejíž volání selhalo.
    expect(run.calls).toBe(run.cases.filter((entry) => entry.plannerMs !== null).length);
    expect(new Date(run.measuredAt).getTime()).toBeGreaterThan(0);
  });

  it('věta bez odpovědi plánovače má scoreSemantics null, nikdy 0; čitelná věta má skóre v ⟨0, 1⟩', () => {
    for (const entry of run.cases) {
      expect(typeof entry.massingBlocks, entry.id).toBe('number');
      if (!entry.readable) {
        expect(entry.scoreSemantics, `${entry.id}: nečitelná odpověď se tváří jako změřená`).toBeNull();
        expect(entry.fault?.length ?? 0, `${entry.id}: nečitelná odpověď bez důvodu`).toBeGreaterThan(0);
        continue;
      }
      expect(entry.plannerMs, entry.id).toBeGreaterThan(0);
      expect(entry.answerBytes, entry.id).toBeGreaterThan(0);
      expect(entry.scoreSemantics, entry.id).toBeGreaterThanOrEqual(0);
      expect(entry.scoreSemantics, entry.id).toBeLessThanOrEqual(1);
      expect(existsSync(`${ANSWERS_DIR}/${entry.id}.json`), `${entry.id}: čitelná odpověď bez uloženého znění`).toBe(true);
    }
  });
});

describe('gauntlet-score – selhané volání nikdy nedá nulu', () => {
  const failed = scoreAnswer({ id: 'x-1', category: 'x', sentence: 'A stone.', plannerMs: null, answer: undefined, fault: 'UPSTREAM_UNAVAILABLE: codex died' }, { required: [{ quote: 'stone', count: 1 }] });
  const unreadable = scoreAnswer({ id: 'x-2', category: 'y', sentence: 'A stone.', plannerMs: 10, answer: { hello: 'world' }, fault: undefined }, { required: [{ quote: 'stone', count: 1 }] });

  it('selhané i nečitelné volání nese null a důvod', () => {
    expect(failed.scoreSemantics).toBeNull();
    expect(failed.readable).toBe(false);
    expect(failed.fault).toContain('UPSTREAM_UNAVAILABLE');
    expect(unreadable.scoreSemantics).toBeNull();
    expect(unreadable.readable).toBe(false);
    expect(unreadable.answerBytes).toBeGreaterThan(0);
  });

  it('medián skóre a mediánový čas se počítají jen z toho, co doopravdy přišlo', () => {
    const scored = { ...unreadable, id: 'x-3', category: 'z', readable: true, scoreSemantics: 0.5, components: { presence: 1, counts: 0, relations: 1, forbidden: 0 }, plannerMs: 40 };
    const summary = summarize([failed, unreadable, scored]);
    expect(summary.total).toBe(3);
    expect(summary.readable).toBe(1);
    expect(summary.medianScore).toBe(0.5);
    expect(summary.medianPlannerMs).toBe(25);
    expect(summary.readableShare).toBeCloseTo(1 / 3, 3);
    expect(Object.keys(summary.failuresByCategory)).toEqual(['x', 'y']);
    expect(summarize([failed]).medianScore).toBeNull();
    expect(summarize([failed]).medianPlannerMs).toBeNull();
  });
});
