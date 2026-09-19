/**
 * **Report brány A10 — pin na jmenovatel (P21 T11).**
 *
 * Artefakt `conversation.json` má jednu vlastnost, kterou se dá zadarmo
 * zfalšovat: **chybějící případ.** Report o dvou větách místo tří, kde ta
 * třetí byla odmítnutá, ukáže lepší podíl přijatých i lepší medián — a obě
 * čísla jdou správným směrem, takže si toho nikdo nevšimne. Sada proto soudí
 * artefakt, ne kód: jmenovatel je 3 ze zaznamenaných deseti, žádný případ
 * není bez času ani bez verdiktu, souhrn tiskne medián a podíl přijatých, a
 * prahy z rešerše stojí v artefaktu jako cíl, ne jako podmínka.
 *
 * Znovu ho naměří (jeden živý běh, rozpočet v plánu P21):
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

interface ConversationReport {
  readonly measuredAt: string;
  readonly model: string;
  readonly effort: string;
  readonly callCap: number;
  readonly answersDir?: string;
  readonly corpus: { readonly total: number; readonly measured: number; readonly remaining: readonly string[] };
  readonly target: { readonly medianMs: number; readonly acceptedOf: readonly [number, number]; readonly note: string };
  readonly summary: { readonly total: number; readonly accepted: number; readonly acceptedShare: number; readonly medianMs: number; readonly slowestMs: number };
  readonly cases: readonly ConversationCase[];
}

const report = JSON.parse(readFileSync(REPORT_FILE, 'utf8')) as ConversationReport;

describe('conversation.json – tři věty z deseti nad jedním světem', () => {
  it('jmenovatel je aspoň 3 z deseti a zbylé věty jsou pojmenované, ne ztracené', () => {
    // Běh 19. 9. 2026 změřil čtyři věty místo tří (výběr „každá třetí" z deseti
    // jsou čtyři) a všechny čtyři zůstaly v artefaktu; oříznout ho na tři by
    // vyhodilo odmítnutí. Pin proto drží: nic se neztratilo a jmenovatel je
    // ten, který artefakt sám přiznává.
    expect(report.cases.length).toBeGreaterThanOrEqual(3);
    expect(report.summary.total, 'souhrn počítá s jiným jmenovatelem než seznam případů').toBe(report.cases.length);
    expect(report.corpus.total).toBe(10);
    expect(report.corpus.measured).toBe(report.cases.length);
    expect(report.corpus.remaining.length + report.corpus.measured).toBe(10);
    for (const entry of report.cases) expect(report.corpus.remaining, `${entry.sentence}: změřená a zároveň nezměřená`).not.toContain(entry.sentence);
    expect(new Set(report.cases.map((entry) => entry.sentence)).size).toBe(report.cases.length);
    expect(report.effort.length).toBeGreaterThan(0);
    expect(report.model).toContain(`@${report.effort}`);
  });

  it('žádný případ není bez času ani bez verdiktu, a odmítnutí nese důvod', () => {
    for (const entry of report.cases) {
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
      if (report.answersDir !== undefined && entry.modelMs !== null)
        expect(entry.answerBytes, `${entry.sentence}: volání bez uložené odpovědi`).toBeGreaterThan(0);
      // Věta, která došla k modelu, nese jeho čas a spotřebu; jinak by se
      // odmítnutí zadarmo (grounding) nedalo odlišit od odmítnutí za peníze.
      if (entry.modelMs !== null) {
        expect(entry.inputTokens, `${entry.sentence}: volání bez spotřeby`).not.toBeNull();
        expect(entry.outputTokens, `${entry.sentence}: volání bez spotřeby`).not.toBeNull();
        expect(entry.ms).toBeGreaterThanOrEqual(entry.modelMs);
      }
    }
  });

  it('souhrn tiskne medián a podíl přijatých a oba sedí s případy', () => {
    const sorted = report.cases.map((entry) => entry.ms).sort((a, b) => a - b);
    expect(report.summary.medianMs).toBe(sorted[Math.floor((sorted.length - 1) / 2)]);
    const accepted = report.cases.filter((entry) => entry.verdict === 'ACCEPTED').length;
    expect(report.summary.accepted).toBe(accepted);
    expect(report.summary.acceptedShare).toBeCloseTo(accepted / report.cases.length, 2);
    expect(report.summary.slowestMs).toBe(sorted[sorted.length - 1]);
  });

  it('prahy z rešerše stojí v artefaktu jako cíl, ne jako podmínka', () => {
    expect(report.target.medianMs).toBe(5_000);
    expect(report.target.acceptedOf).toEqual([2, 3]);
    expect(report.target.note).toContain('goal');
  });
});
