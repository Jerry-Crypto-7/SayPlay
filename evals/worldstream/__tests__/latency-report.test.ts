/**
 * **Přeměření čekání po P21 — pin na jmenovatel, na fáze a na citaci starého čísla.**
 *
 * Artefakt `latency-p21.json` má dvě vlastnosti, které se dají zadarmo zfalšovat:
 * **chybějící věta** (report o jedné větě místo dvou vypadá líp, když ta druhá
 * byla ta pomalá) a **tiché srovnání** s měřením ze 13. 9., které šlo na jiném
 * počtu vět. Sada proto soudí artefakt, ne kód: jmenovatel je 2, každá věta
 * nese všechny čtyři fáze čekání jako číslo, každý kus kompilátoru je vlastní
 * započtené volání se spotřebou (to je orákulum T5), a staré hodnoty se citují
 * s datem, účinkem a počtem vět.
 *
 * Znovu ho naměří (jeden živý běh, viz rozpočet v plánu P21):
 *
 *     WORLDSMITH_LATENCY_CHUNKED=1 WORLDSMITH_LATENCY_CASES=2 \
 *     WORLDSMITH_LATENCY_MODELS='gpt-6-astra@medium#cli' \
 *     npx vitest run --config vitest.measure.mts evals/worldstream/live-latency.measure.ts
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const REPORT_FILE = fileURLToPath(new URL('../latency-p21.json', import.meta.url));

const PHASES = ['toMassingPreviewMs', 'toFirstChunkMs', 'toFirstObjectMs', 'toPlayableMs', 'toFullDetailMs'] as const;

interface P21Case {
  readonly id: string;
  readonly prompt: string;
  readonly phases: Record<(typeof PHASES)[number], number | null>;
  readonly chunks: { readonly longestMs: number; readonly sumMs: number; readonly byChunk: Record<string, number> } | null;
  readonly rounds: number;
  readonly authored: boolean;
  readonly certified: boolean;
  readonly failure: { readonly stage: string; readonly detail: string } | null;
  readonly baselineMs: number | null;
}

interface P21Call {
  readonly caseId: string;
  readonly stage: string | null;
  readonly chunk: string | null;
  readonly repair: boolean;
  readonly ms: number;
  readonly endedAtMs: number;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly ok: boolean;
}

interface StageStat {
  readonly n: number;
  readonly medianMs: number;
  readonly medianAnswerBytes: number;
  readonly medianOutputTokens: number | null;
}

interface Phase5Case {
  readonly id: string;
  readonly plannerMs: number | null;
  readonly plannerAnswerBytes: number | null;
  readonly plannerOutputTokens: number | null;
  readonly compilerMs: number | null;
  readonly authored: boolean;
  readonly failure: { readonly stage: string; readonly detail: string } | null;
}

/** Blok fáze 5 (P21 T21): plánovač po štíhlém `sceneSpec` (T18) a nízkém úsilí (T19). */
interface Phase5Block {
  readonly measuredAt: string;
  readonly model: string;
  readonly effort: string;
  readonly plannerEffort: string;
  readonly cases: number;
  readonly caseIds: readonly string[];
  readonly chunked: boolean;
  readonly callCap: number;
  readonly calls: number;
  readonly byStage: { readonly planner: StageStat; readonly compiler: StageStat | null };
  readonly previous: {
    readonly morning19: { readonly measuredAt: string; readonly plannerMedianMs: number; readonly plannerAnswerBytes: number; readonly plannerOutputTokens: number | null };
    readonly baseline13: { readonly measuredAt: string; readonly plannerMedianMs: number };
  };
  readonly target: { readonly plannerMs: number; readonly answerBytes: number; readonly note: string };
  readonly perCase: readonly Phase5Case[];
}

interface P21Report {
  readonly measuredAt: string;
  readonly model: string;
  readonly effort: string;
  readonly cases: number;
  readonly caseIds: readonly string[];
  readonly chunked: boolean;
  readonly callCap: number;
  readonly phase5?: Phase5Block;
  readonly baseline: {
    readonly measuredAt: string;
    readonly file: string;
    readonly model: string;
    readonly effort: string;
    readonly cases: number;
    readonly caseMedianMs: number;
    readonly caseP95Ms: number;
    readonly compilerMedianMs: number;
    readonly note: string;
  };
  readonly perCase: readonly P21Case[];
  readonly calls: readonly P21Call[];
}

const report = JSON.parse(readFileSync(REPORT_FILE, 'utf8')) as P21Report;

describe('latency-p21.json – dvě věty po P21 vedle měření ze 13. 9.', () => {
  it('jmenovatel je 2 a žádná věta nechybí', () => {
    expect(report.cases).toBe(2);
    expect(report.caseIds).toHaveLength(2);
    expect(report.perCase.map((entry) => entry.id)).toEqual(report.caseIds);
    expect(new Set(report.caseIds).size).toBe(2);
    expect(report.chunked).toBe(true);
    expect(report.effort.length).toBeGreaterThan(0);
    expect(report.model).toContain(`@${report.effort}`);
  });

  it('každá věta nese čas do plného detailu a hotová věta všechny čtyři fáze jako číslo v pořadí', () => {
    for (const entry of report.perCase) {
      expect(Number.isFinite(entry.phases.toFullDetailMs), `${entry.id}: věta bez celkového času`).toBe(true);
      if (entry.failure !== null) {
        expect(entry.failure.detail.length, `${entry.id}: selhání bez důvodu`).toBeGreaterThan(0);
        continue;
      }
      const values = PHASES.map((phase) => entry.phases[phase]);
      for (const [index, value] of values.entries())
        expect(Number.isFinite(value), `${entry.id}: fáze ${PHASES[index]} bez čísla`).toBe(true);
      for (let index = 1; index < values.length; index += 1)
        expect(values[index], `${entry.id}: ${PHASES[index]} dřív než ${PHASES[index - 1]}`).toBeGreaterThanOrEqual(values[index - 1] as number);
      expect(entry.chunks, `${entry.id}: hotový svět bez kusů`).not.toBeNull();
    }
  });

  it('každý kus kompilátoru je vlastní započtené volání se spotřebou (orákulum T5)', () => {
    for (const entry of report.perCase) {
      const calls = report.calls.filter((call) => call.caseId === entry.id);
      const planner = calls.filter((call) => call.stage === 'planner');
      expect(planner, `${entry.id}: plánovač není jedno volání`).toHaveLength(1);
      if (entry.failure?.stage === 'planner' || entry.failure?.stage === 'unavailable') continue;
      const chunks = calls.filter((call) => call.chunk !== null && !call.repair);
      expect(chunks.map((call) => call.chunk).sort(), `${entry.id}: kusy nejsou tři samostatná volání`).toEqual(['architecture', 'objects', 'rules']);
      for (const call of calls) {
        expect(call.inputTokens, `${entry.id} ${call.stage}/${call.chunk}: volání bez spotřeby`).not.toBeNull();
        expect(call.outputTokens, `${entry.id} ${call.stage}/${call.chunk}: volání bez spotřeby`).not.toBeNull();
        expect(Number.isFinite(call.endedAtMs), `${entry.id} ${call.stage}/${call.chunk}: volání bez času konce`).toBe(true);
      }
      // Souběh: svět trval zhruba nejdelší kus, ne jejich součet.
      expect(entry.chunks?.longestMs).toBeLessThan(entry.chunks?.sumMs ?? 0);
    }
  });

  it('staré hodnoty se citují s datem, účinkem a počtem vět, ne jako holé číslo', () => {
    expect(report.baseline.measuredAt.startsWith('2026-09-13')).toBe(true);
    expect(report.baseline.file).toBe('evals/worldstream/latency-report.json');
    expect(report.baseline.cases).toBe(5);
    expect(report.baseline.effort.length).toBeGreaterThan(0);
    expect(report.baseline.note).toContain('2026-09-13');
    expect(report.baseline.note).toContain(`@${report.baseline.effort}`);
    expect(report.baseline.note).toContain('5');
    for (const key of ['caseMedianMs', 'caseP95Ms', 'compilerMedianMs'] as const)
      expect(Number.isFinite(report.baseline[key]), `baseline bez ${key}`).toBe(true);
    // Věta, kterou 13. 9. měřilo, nese své staré číslo vedle nového; ostatní poctivě null.
    for (const entry of report.perCase)
      if (entry.baselineMs !== null) expect(Number.isFinite(entry.baselineMs), entry.id).toBe(true);
  });
});

// ⚠ Dočasné: `skipIf` odstranit, jakmile T21 živě doběhne a blok `phase5` v artefaktu je.
// Do té doby by pin na `toBeDefined` držel celou sadu červenou kvůli běhu, který ještě nebyl.
describe.skipIf(report.phase5 === undefined)('latency-p21.json › phase5 – plánovač po štíhlém sceneSpec a nízkém úsilí (T21)', () => {
  const phase5 = report.phase5;

  it('blok existuje, má obě věty a jede jedním voláním kompilátoru, ne po kusech', () => {
    expect(phase5, 'phase5 chybí – T21 ještě neběželo').toBeDefined();
    if (phase5 === undefined) return;
    expect(phase5.cases).toBe(2);
    expect(phase5.caseIds).toHaveLength(2);
    expect(phase5.perCase.map((entry) => entry.id)).toEqual(phase5.caseIds);
    expect(phase5.chunked).toBe(false);
    expect(phase5.callCap).toBeLessThanOrEqual(10);
    expect(phase5.calls).toBeLessThanOrEqual(phase5.callCap);
    expect(phase5.model).toContain(`@${phase5.effort}`);
    expect(phase5.plannerEffort).toBe('low');
  });

  it('každá věta nese plánovačský čas jako číslo, i když svět selhal později (nález revize 19. 9.)', () => {
    if (phase5 === undefined) return;
    for (const entry of phase5.perCase) {
      if (entry.failure?.stage === 'unavailable') continue;
      expect(Number.isFinite(entry.plannerMs), `${entry.id}: plánovač bez času`).toBe(true);
      expect(entry.plannerAnswerBytes, `${entry.id}: plánovač bez délky odpovědi`).toBeGreaterThan(0);
      if (entry.failure !== null) expect(entry.failure.detail.length, `${entry.id}: selhání bez důvodu`).toBeGreaterThan(0);
      // Svět, který došel ke kompilátoru, nese i jeho čas.
      if (entry.failure === null || !['planner', 'unavailable'].includes(entry.failure.stage))
        expect(Number.isFinite(entry.compilerMs), `${entry.id}: kompilátor bez času`).toBe(true);
    }
    expect(phase5.byStage.planner.n).toBe(phase5.perCase.filter((entry) => entry.plannerMs !== null).length);
  });

  it('stará čísla stojí vedle nového s datem, a cíl stojí jako cíl', () => {
    if (phase5 === undefined) return;
    expect(phase5.previous.morning19.measuredAt.startsWith('2026-09-19')).toBe(true);
    expect(phase5.previous.morning19.plannerMedianMs).toBe(75025);
    expect(phase5.previous.morning19.plannerAnswerBytes).toBe(6794);
    expect(phase5.previous.baseline13.measuredAt.startsWith('2026-09-13')).toBe(true);
    expect(phase5.previous.baseline13.plannerMedianMs).toBe(16696);
    expect(phase5.target).toMatchObject({ plannerMs: 30_000, answerBytes: 4_000 });
    expect(phase5.target.note).toContain('goal');
  });
});
