/** Typy k `judge-library.mjs` pro TypeScript testy. */
import type { ScoredCell } from '../p37d/judge-sheet.mjs';

export type Judge = 'codex' | 'claude';
export declare const CODEX_DAILY_CAP: number;
export declare const COUNTER: string;
export declare const AGREE_WITHIN: number;
export declare function judgesFor(n: number): Judge[];
export declare function takeCodexCall(file: string, day: string, cap?: number): boolean;
export declare function judgeIds(usage: { top300: string[]; sample100: string[] }): string[];
export declare function cellsBack(sheet: { sheet: string; cells: string[] }, scored: (ScoredCell | null)[]): Record<string, (ScoredCell & { sheet: string }) | null>;
export declare function mergeAttempts(first: (ScoredCell | null)[], second: (ScoredCell | null)[]): (ScoredCell | null)[];
export declare function summarize(
  usage: { top300: string[]; sample100: string[] },
  plan: { sheets: { sheet: string; cells: string[] }[] },
  scores: Record<string, Record<string, { cells: (ScoredCell | null)[] }>>,
): {
  judged: number;
  nulls: string[];
  agreement: { cells: number; within: number; share: number | null; meanDiff: number | null };
  below6: string[];
  top50Below8: string[];
  models: Record<string, { rank: number; group: string; score: number | null } & Record<string, unknown>>;
};
