/** Typy k `missing-nouns.mjs` pro TypeScript testy (konvence `scripts/build-from-tag.d.mts`). */

export type NounRow = { noun: string; category: string | null; sentences: number; sources: string[]; examples: string[] };
export type Bins = { covered: NounRow[]; undrawable: NounRow[]; missing: NounRow[]; settings: NounRow[]; unclassified: NounRow[] };
export type ChecklistItem = { item: string; slot: string; match?: string[] };
export type Sentence = { id: string; text: string; checklist?: ChecklistItem[] };
export type Inputs = {
  sets: { name: string; sentences: Sentence[] }[];
  common: { tiers: Record<string, string[]>; abstract: string[] };
  notNouns: Set<string>;
  covered: Set<string>;
};

export declare const SETS: readonly { name: string; file: string; optional?: boolean }[];
export declare function wordsOf(text: string): string[];
export declare function normal(phrase: string): string;
export declare function parseNotNouns(text: string): Set<string>;
export declare function coveredVocabulary(sources: { index: unknown; playEntries: unknown; rigged: unknown[] }): Set<string>;
export declare function sentencesOf(data: unknown): Sentence[];
export declare function missingNouns(inputs: Inputs): Bins & { sentences: number };
export declare function loadInputs(root?: string): Inputs;
export declare function writeReport(out?: string, inputs?: Inputs): Record<'missing' | 'undrawable' | 'settings' | 'unclassified' | 'covered', number>;
