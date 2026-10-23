/** Typy k `judge-sheet.mjs` pro TypeScript testy (konvence `scripts/build-from-tag.d.mts`). */

export type Answer = { name: string; alternatives: string[]; recognizable: boolean; intact: boolean };
export type Verdict = 'top1' | 'top3' | 'no' | 'broken';
export type ModelRecord = { noun: string; seed: number; glb: string; lod1: string };
export type CatalogBatchEntry = { id: string; nouns: string[]; checked: { judge: string; verdict: 'pass' | 'fail' } } & Record<string, unknown>;

export declare const QUESTION: string;
export declare const ANSWER_SCHEMA: Record<string, unknown>;
export declare function matches(noun: string, guess: string): boolean;
export declare function verdictOf(names: string | string[], answer: Answer): Verdict;
export declare function catalogBatch(
  models: ModelRecord[],
  results: Record<string, { verdict?: Verdict; error?: string }>,
  viewed?: Map<string, string>,
  aliases?: Record<string, string[]>,
): Promise<{ schema: 'catalog-batch.v1'; entries: CatalogBatchEntry[] }>;
export type Judge = 'codex' | 'claude';
export declare const CLAUDE_MODEL: string;
export declare function blindQuestion(sheet: string, schemaFile: string, question?: string, judge?: Judge): { cwd: string; args: string[] };
export declare function claudeAnswer(code: number | null, stdout: string, valid?: (value: unknown) => boolean): { answer?: Answer; error?: string };
export declare function ask(
  sheet: string,
  schemaFile: string,
  answerFile: string,
  question?: string,
  judge?: Judge,
  valid?: (value: unknown) => boolean,
): Promise<{ code: number | null; seconds: number; stderr: string }>;
export type ScoredCell = { cell: number; name: string; score: number; recognisable: boolean; broken: boolean; styleFit: boolean; reason: string };
export declare const SCORE_SCHEMA: Record<string, unknown>;
export declare function scoreQuestion(count: number): string;
export declare function isScoreAnswer(value: unknown): boolean;
export declare function scoreCells(answer: unknown, count: number): (ScoredCell | null)[];
export declare function scoreSheet(sheet: string, count: number, out: string, judge: Judge, calibration?: string): Promise<{ judge: Judge; seconds: number; cells: (ScoredCell | null)[]; error?: string }>;
