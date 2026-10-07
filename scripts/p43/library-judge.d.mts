/** Typy k `library-judge.mjs` pro TypeScript testy (konvence `scripts/build-from-tag.d.mts`). */

export type GridSheet = { sheet: string; cells: string[] };
export type GridIndex = { size: number; sheets: GridSheet[] };
export type CellAnswer = { cell: number; name: string; alternatives: string[]; recognizable: boolean; realSize: number };
export type SheetAnswer = { cells: CellAnswer[] };
export type Verdict = {
  sheet: string;
  cell: number;
  name: string;
  alternatives: string[];
  recognizable: boolean;
  nameFits: boolean;
  suggestedName: string | null;
  realSize: number;
};

export declare function questionFor(cells: number): string;
export declare function schemaFor(cells: number): object;
export declare function pendingSheets(index: GridIndex, verdicts: Record<string, Verdict>): GridSheet[];
export declare function verdictsOf(sheet: GridSheet, answer: SheetAnswer | null | undefined, namesOf: (assetId: string) => string[]): Record<string, Verdict> | null;
export declare function judgeSlice(options: {
  index: GridIndex;
  verdicts: Record<string, Verdict>;
  maxCalls: number;
  call: (sheet: string, cells: number) => Promise<SheetAnswer | null | undefined>;
  namesOf: (assetId: string) => string[];
  save?: () => void;
  concurrency?: number;
}): Promise<{ calls: number; failed: string[] }>;
