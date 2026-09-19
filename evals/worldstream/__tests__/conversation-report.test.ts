/**
 * **Report brány A10 — pin na jmenovatel a na oba běhy (P21 T11, T22).**
 *
 * Artefakt `conversation.json` má dvě vlastnosti, které se dají zadarmo
 * zfalšovat. **Chybějící případ:** report o dvou větách místo tří, kde ta
 * třetí byla odmítnutá, ukáže lepší podíl přijatých i lepší medián — a obě
 * čísla jdou správným směrem, takže si toho nikdo nevšimne. **Přepsaný první
 * běh:** druhý běh, který ten z 19. 9. ráno (1 ze 4 přijato) smaže, vypadá
 * jako zlepšení, i kdyby žádné nebylo. Sada proto soudí artefakt, ne kód:
 * běhy jsou pole `runs` a první z nich zůstává; v každém běhu je jmenovatel
 * ten, který běh sám přiznává (první změřil čtyři, každý další právě tři),
 * žádný případ není bez času ani bez verdiktu, odmítnutí nese `detail`,
 * souhrn tiskne medián a podíl přijatých, a prahy z rešerše stojí v artefaktu
 * jako cíl, ne jako podmínka.
 *
 * Znovu ho naměří (jeden živý běh, rozpočet v plánu P21) a dopíše jako další běh:
 *
 *     npx vitest run --config vitest.measure.mts evals/worldstream/conversation.measure.ts
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const REPORT_FILE = fileURLToPath(new URL('../conversation.json', import.meta.url));

interface ConversationCase {
  readonly sentence: string;
  readonly piece: string;
  readonly target: string;
  readonly verdict: 'ACCEPTED' | 'REJECTED' | 'UNAVAILABLE';
  readonly reason: string | null;
  readonly ms: number;
  readonly modelMs: number | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly detail: string | null;
  readonly answerBytes?: number | null;
}

interface ConversationRun {
  readonly measuredAt: string;
  readonly plan: string;
  readonly model: string;
  readonly effort: string;
  readonly callCap: number;
  readonly answersDir?: string;
  readonly corpus: { readonly total: number; readonly measured: number; readonly remaining: readonly string[] };
  readonly summary: { readonly total: number; readonly accepted: number; readonly acceptedShare: number; readonly medianMs: number; readonly slowestMs: number };
  readonly cases: readonly ConversationCase[];
}

interface ConversationReport {
  readonly world: { readonly id: string; readonly prompt: string };
  readonly target: { readonly medianMs: number; readonly acceptedOf: readonly [number, number]; readonly note: string };
  readonly runs: readonly ConversationRun[];
}

const report = JSON.parse(readFileSync(REPORT_FILE, 'utf8')) as ConversationReport;

describe('conversation.json – živé běhy brány A10 nad jedním světem', () => {
  it('nese oba běhy: první z 19. 9. ráno (T11) zůstává, druhý (T22) stojí vedle něj', () => {
    expect(Array.isArray(report.runs), 'artefakt není pole běhů – druhý běh by přepsal první').toBe(true);
    expect(report.runs.length).toBeGreaterThanOrEqual(2);
    const [first, second] = report.runs;
    expect(first.plan).toContain('T11');
    expect(first.measuredAt).toBe('2026-09-19T08:58:49.156Z');
    expect(first.summary).toEqual({ total: 4, accepted: 1, acceptedShare: 0.25, medianMs: 29834, slowestMs: 33701 });
    expect(second.plan).toContain('T22');
    expect(second.callCap).toBe(6);
    expect(new Date(second.measuredAt).getTime()).toBeGreaterThan(new Date(first.measuredAt).getTime());
    for (const run of report.runs) expect(run.model).toContain(`@${run.effort}`);
  });

  it('jmenovatel: první běh přiznává čtyři, každý další právě tři, zbylé věty jsou pojmenované, ne ztracené', () => {
    // Běh 19. 9. 2026 ráno změřil čtyři věty místo tří (výběr „každá třetí" z deseti
    // jsou čtyři) a všechny čtyři zůstaly v artefaktu; oříznout ho na tři by
    // vyhodilo odmítnutí. Od T22 měří běh právě tři (index 0, 3, 6).
    report.runs.forEach((run, index) => {
      expect(run.cases.length, `běh ${String(index)}`).toBe(index === 0 ? 4 : 3);
      expect(run.summary.total, `běh ${String(index)}: souhrn počítá s jiným jmenovatelem než seznam případů`).toBe(run.cases.length);
      expect(run.corpus.total).toBe(10);
      expect(run.corpus.measured).toBe(run.cases.length);
      expect(run.corpus.remaining.length + run.corpus.measured).toBe(10);
      for (const entry of run.cases) expect(run.corpus.remaining, `${entry.sentence}: změřená a zároveň nezměřená`).not.toContain(entry.sentence);
      expect(new Set(run.cases.map((entry) => entry.sentence)).size).toBe(run.cases.length);
    });
  });

  it('žádný případ není bez času ani bez verdiktu, a odmítnutí nese důvod i detail', () => {
    for (const run of report.runs) {
      for (const entry of run.cases) {
        expect(['ACCEPTED', 'REJECTED', 'UNAVAILABLE'], entry.sentence).toContain(entry.verdict);
        expect(Number.isFinite(entry.ms), `${entry.sentence}: případ bez času`).toBe(true);
        expect(entry.ms).toBeGreaterThan(0);
        if (entry.verdict === 'ACCEPTED') expect(entry.reason, entry.sentence).toBeNull();
        else {
          expect(entry.reason?.length ?? 0, `${entry.sentence}: odmítnutí bez důvodu`).toBeGreaterThan(0);
          // Důvod sám nestačí: `SHAPE_INVALID` bez detailu neřekne, jaký `kind`
          // model napsal, a přesně to bylo po běhu 19. 9. 2026 neznámé (P21 T20).
          expect(entry.detail?.length ?? 0, `${entry.sentence}: odmítnutí bez detailu`).toBeGreaterThan(0);
        }
        // Od T20 se odpověď modelu ukládá vedle artefaktu a případ nese její délku;
        // starší běh (bez `answersDir`) ji nemá a nic o ní netvrdí.
        if (run.answersDir !== undefined && entry.modelMs !== null)
          expect(entry.answerBytes, `${entry.sentence}: volání bez uložené odpovědi`).toBeGreaterThan(0);
        // Věta, která došla k modelu, nese jeho čas a spotřebu; jinak by se
        // odmítnutí zadarmo (grounding) nedalo odlišit od odmítnutí za peníze.
        if (entry.modelMs !== null) {
          expect(entry.inputTokens, `${entry.sentence}: volání bez spotřeby`).not.toBeNull();
          expect(entry.outputTokens, `${entry.sentence}: volání bez spotřeby`).not.toBeNull();
          expect(entry.ms).toBeGreaterThanOrEqual(entry.modelMs);
        }
      }
    }
  });

  it('souhrn každého běhu tiskne medián a podíl přijatých a oba sedí s případy', () => {
    for (const run of report.runs) {
      const sorted = run.cases.map((entry) => entry.ms).sort((a, b) => a - b);
      expect(run.summary.medianMs).toBe(sorted[Math.floor((sorted.length - 1) / 2)]);
      const accepted = run.cases.filter((entry) => entry.verdict === 'ACCEPTED').length;
      expect(run.summary.accepted).toBe(accepted);
      expect(run.summary.acceptedShare).toBeCloseTo(accepted / run.cases.length, 2);
      expect(run.summary.slowestMs).toBe(sorted[sorted.length - 1]);
    }
  });

  it('prahy z rešerše stojí v artefaktu jako cíl, ne jako podmínka', () => {
    expect(report.target.medianMs).toBe(5_000);
    expect(report.target.acceptedOf).toEqual([2, 3]);
    expect(report.target.note).toContain('goal');
  });
});
