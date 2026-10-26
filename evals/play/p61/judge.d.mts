/**
 * Typy k `judge.mjs`. Skript běží holým Nodem, test je TypeScript a potřebuje jeho kontrakt zapsaný.
 */

export interface Side {
  readonly kind: string;
  readonly [key: string]: unknown;
}

export interface PlannedRow extends Side {
  readonly side: string;
}

export interface PlannedSheet {
  readonly id: string;
  readonly sentence: string;
  readonly rows: readonly PlannedRow[];
}

export interface Score {
  readonly fidelity: number;
  readonly wouldPlay: number;
  readonly reason: string;
}

export interface Answer {
  readonly rows: readonly (Score & { readonly side: string })[];
}

export interface Median {
  readonly fidelity: number;
  readonly wouldPlay: number;
  readonly n: number;
}

export declare const JUDGE_SEED: number;
export declare const ANSWER_SCHEMA: Record<string, unknown>;
export declare function questionFor(sentence: string, letters: readonly string[]): string;
export declare function isAnswerFor(value: unknown, letters: readonly string[]): boolean;
export declare function planSheets(
  sentences: readonly { readonly id: string; readonly text: string; readonly sides: readonly Side[] }[],
  seed?: number,
): { readonly seed: number; readonly generator: string; readonly plan: PlannedSheet[] };
export declare function sheetLabels(rows: readonly PlannedRow[]): string[];
export declare function summarize(
  plan: readonly PlannedSheet[],
  answers: Record<string, Answer | undefined>,
  ...names: string[]
): {
  readonly medians: Record<string, Median | null>;
  readonly sentences: { readonly id: string; readonly sentence: string; readonly scores: Record<string, Score> }[];
  readonly skipped: string[];
};
