/**
 * Typy k `lock.mjs`. Zámek musí jít spustit holým Nodem bez build kroku, takže
 * je to `.mjs`; test je TypeScript a `allowJs` je v `tsconfig.json` vypnuté.
 * Táž konvence jako u `evals/corpus-v3/lock.d.mts`.
 */

export declare const CORPUS_DIR: string;
export declare const CREATE_FILE: string;
export declare const REFINE_FILE: string;
export declare const MANIFEST_FILE: string;
export declare const FROZEN_FILES: readonly string[];

export declare const CREATE_DISTRIBUTION: Readonly<Record<string, number>>;
export declare const REFINE_DISTRIBUTION: Readonly<Record<string, number>>;
export declare const CREATE_TOTAL: number;
export declare const REFINE_TOTAL: number;
export declare const SCOPE_AXES: readonly string[];
export declare const FORBIDDEN_VOCABULARY: readonly string[];

export declare type CreateCase = {
  id: string;
  category: string;
  prompt: string;
  spatialThesis: string;
  heroObjects: string[];
  visibleBeat: string;
  forbiddenSubstitutions: string[];
  mustName: string[];
};

export declare type RefineCase = {
  id: string;
  createId: string;
  kind: string;
  prompt: string;
  targetObject: string | null;
  candidates?: string[];
  scope: string[];
  mustNotChange: string[];
};

export declare type Corpus = {
  create: CreateCase[];
  refine: RefineCase[];
  parseProblems: string[];
};

export declare type Manifest = {
  readonly lockVersion: number;
  readonly corpusVersion: string;
  readonly algorithm: string;
  readonly files: Record<string, string>;
  readonly refrozenAt?: { readonly reason: string };
};

export declare function normalisedSha256(absolutePath: string): string;
export declare function jsonlRelativePaths(dir?: string): string[];
export declare function readCorpus(dir?: string): Corpus;
export declare function readManifest(dir?: string): Manifest;
export declare function computeFileHashes(dir?: string): Record<string, string>;

/** Prázdné pole znamená, že je korpus v pořádku. Každá věta je jeden nález. */
export declare function validateCorpus(corpus: unknown): string[];

/** Prázdné pole znamená, že strom sedí se zamčeným manifestem. */
export declare function verifyAgainstManifest(dir?: string): string[];
