/**
 * **Skóre a souhrn jednoho běhu gauntletu (P22 T17).**
 *
 * Odděleno od `gauntlet.measure.ts`, aby se pravidlo „selhané volání je
 * `null`, nikdy 0" dalo pinnout bez živého běhu: soubor `.measure.ts` nejde
 * importovat do testu, protože by spustil měření. Čtení odpovědi je totéž,
 * kterým prochází produkt (`readPlannerEmission` s povinným `sceneSpec`),
 * skóre totéž, kterým T2 soudí archiv (`scoreSemantics`).
 */

import { readPlannerEmission } from '@/model/worldstream-intent';
import { scoreSemantics, type SemanticOracle } from '@/scene/requirements';

/** Kategorie, kde se svět neslibuje (`word-massing.measure.ts`) nebo je správná odpověď odmítnutí (`oracles.json`). */
export const EXCLUDED_CATEGORIES = ['contradictory', 'unsupported', 'safety', 'abstract'] as const;

export interface GauntletAnswer {
  readonly id: string;
  readonly category: string;
  readonly sentence: string;
  /** Čas volání plánovače, i když selhalo; `null`, když se věta k modelu nedostala. */
  readonly plannerMs: number | null;
  /** Co model napsal; `undefined`, když odpověď nepřišla. */
  readonly answer: unknown;
  /** Důvod, proč odpověď nepřišla; `undefined`, když přišla. */
  readonly fault: string | undefined;
}

export interface GauntletCase {
  readonly id: string;
  readonly category: string;
  readonly sentence: string;
  readonly plannerMs: number | null;
  readonly answerBytes: number | null;
  /** Odpověď prošla `readPlannerEmission` se `sceneSpec`. */
  readonly readable: boolean;
  readonly fault?: string;
  /** `null` = nic k měření (volání selhalo nebo odpověď nejde přečíst) – nikdy 0. */
  readonly scoreSemantics: number | null;
  readonly components: { presence: number; counts: number; relations: number; forbidden: number } | null;
  readonly failures: readonly string[];
  /** Kolik bloků dá věta bez modelu (`wordMassing`, T4); doplňuje měření. */
  readonly massingBlocks: number;
}

export interface GauntletSummary {
  readonly total: number;
  readonly readable: number;
  readonly readableShare: number;
  readonly medianPlannerMs: number | null;
  readonly medianScore: number | null;
  readonly medianComponents: { presence: number; counts: number; relations: number; forbidden: number } | null;
  /** Kategorie → důvod, jen u vět bez skóre. */
  readonly failuresByCategory: Record<string, string>;
  readonly semanticFailuresByKind: { presence: number; counts: number; relations: number; forbidden: number };
}

const round = (value: number): number => Math.round(value * 1000) / 1000;

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

export function scoreAnswer(answer: GauntletAnswer, oracle: SemanticOracle, massingBlocks = 0): GauntletCase {
  const base = { id: answer.id, category: answer.category, sentence: answer.sentence, plannerMs: answer.plannerMs, massingBlocks };
  if (answer.answer === undefined)
    return { ...base, answerBytes: null, readable: false, fault: answer.fault ?? 'no answer', scoreSemantics: null, components: null, failures: [] };

  const answerBytes = Buffer.byteLength(JSON.stringify(answer.answer));
  const read = readPlannerEmission(answer.answer, { prompt: answer.sentence, requireSceneSpec: true });
  if (!read.ok || read.value.sceneSpec === undefined) {
    const fault = read.ok ? 'WRONG_SHAPE: sceneSpec missing' : `${read.reason}: ${read.detail}`;
    return { ...base, answerBytes, readable: false, fault, scoreSemantics: null, components: null, failures: [] };
  }

  const score = scoreSemantics(read.value.sceneSpec, oracle);
  return {
    ...base,
    answerBytes,
    readable: true,
    scoreSemantics: round(score.score),
    components: { presence: round(score.presence), counts: round(score.counts), relations: round(score.relations), forbidden: round(score.forbidden) },
    failures: score.failures,
  };
}

export function summarize(cases: readonly GauntletCase[]): GauntletSummary {
  const scored = cases.filter((entry) => entry.scoreSemantics !== null);
  const timed = cases.flatMap((entry) => (entry.plannerMs === null ? [] : [entry.plannerMs]));
  const failuresByCategory: Record<string, string> = {};
  for (const entry of cases) if (entry.scoreSemantics === null) failuresByCategory[entry.category] = entry.fault ?? 'no answer';

  const semanticFailuresByKind = { presence: 0, counts: 0, relations: 0, forbidden: 0 };
  for (const entry of cases) for (const failure of entry.failures) {
    if (failure.startsWith('Missing requirement')) semanticFailuresByKind.presence += 1;
    else if (failure.startsWith('Expected')) semanticFailuresByKind.counts += 1;
    else if (failure.startsWith('Missing relation')) semanticFailuresByKind.relations += 1;
    else semanticFailuresByKind.forbidden += 1;
  }
  const component = (pick: (entry: GauntletCase) => number): number => round(median(scored.map(pick)) ?? 0);
  const medianMs = median(timed);

  return {
    total: cases.length,
    readable: scored.length,
    readableShare: cases.length === 0 ? 0 : round(scored.length / cases.length),
    medianPlannerMs: medianMs === null ? null : Math.round(medianMs),
    medianScore: scored.length === 0 ? null : round(median(scored.map((entry) => entry.scoreSemantics!))!),
    medianComponents: scored.length === 0 ? null : {
      presence: component((entry) => entry.components!.presence),
      counts: component((entry) => entry.components!.counts),
      relations: component((entry) => entry.components!.relations),
      forbidden: component((entry) => entry.components!.forbidden),
    },
    failuresByCategory,
    semanticFailuresByKind,
  };
}
