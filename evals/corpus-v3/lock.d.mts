/**
 * Typy k `lock.mjs`. Zámek musí jít spustit holým Nodem bez build kroku, takže
 * je to `.mjs`; test je TypeScript a `allowJs` je v `tsconfig.json` vypnuté.
 * Táž konvence jako u `scripts/build-from-tag.d.mts`.
 */

export declare const CORPUS_DIR: string;
export declare const PROMPTS_FILE: string;
export declare const MANIFEST_FILE: string;

export declare const EXPECTED_DISTRIBUTION: Readonly<Record<string, number>>;
export declare const EXPECTED_TOTAL: number;
export declare const HOSTILE_BUCKETS: readonly string[];
export declare const SCORE_AS_VALUES: readonly string[];
export declare const ALL_KINDS: ReadonlySet<string>;
export declare const NON_DISCRIMINATING_KINDS: ReadonlySet<string>;

export declare type Observation = {
  readonly rid: string;
  readonly kind: string;
  readonly says: string;
  readonly value?: unknown;
};

export declare type Prompt = {
  readonly id: string;
  readonly bucket: string;
  readonly lang: string;
  readonly source: string;
  readonly text: string;
  readonly scoreAs: 'FULFILLABLE' | 'ROBUST_ONLY' | 'NO_FIT_EXPECTED';
  readonly scoreAsReason?: string;
  readonly contract: { readonly mustBuild: boolean; readonly observations: Observation[] };
};

export declare type Corpus = {
  readonly corpusVersion: string;
  readonly observationKinds: Record<string, string>;
  readonly prompts: Prompt[];
};

export declare type Manifest = {
  readonly lockVersion: number;
  readonly corpusVersion: string;
  readonly algorithm: string;
  readonly files: Record<string, string>;
  readonly refrozenAt?: { readonly reason: string };
};

export declare function normalisedSha256(absolutePath: string): string;
export declare function corpusRelativePaths(dir?: string): string[];
export declare function readCorpus(dir?: string): Corpus;
export declare function readManifest(dir?: string): Manifest;
export declare function computeFileHashes(dir?: string): Record<string, string>;

/** Prázdné pole znamená, že je korpus v pořádku. Každá věta je jeden nález. */
export declare function validateCorpus(doc: unknown): string[];

/** Prázdné pole znamená, že strom sedí se zamčeným manifestem. */
export declare function verifyAgainstManifest(dir?: string): string[];
