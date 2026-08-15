/**
 * Typy k `build-from-tag.mjs`. Skript musí jít spustit holým Nodem bez build
 * kroku, takže je to `.mjs`; testy jsou TypeScript a potřebují jeho kontrakt
 * zapsaný. Táž konvence jako u `prove-fallback-isolation.d.mts`.
 */

export declare const TAG: string;
export declare const ALLOWLIST_FILE: string;
export declare const LOCK_FILE: string;
export declare const ARTIFACT_SKIP: string[];
export declare const POLLUTION: Record<string, string>;
export declare const GENERATED_SECRETS: Record<string, string[]>;

export declare function normalizedBytes(relPath: string, bytes: Buffer): Buffer | string;

export declare type Allowlist = {
  /** Co pipeline vědomě předává. Minimalita je tu vlastnost, o kterou jde. */
  readonly host: string[];
  /** Co přidá OS nebo toolchain a odebrat to nejde. Naměřená mez. */
  readonly platform: string[];
  readonly all: string[];
};

export declare function parseAllowlist(text: string): Allowlist;

export declare function envFrom(
  allow: readonly string[],
  source: Record<string, string | undefined>,
): Record<string, string>;

export declare function unexpectedEnvKeys(
  allow: readonly string[],
  observed: readonly string[],
): string[];

export declare function executablePaths(lsTree: string): string[];

export declare function walkFiles(root: string, dir?: string, skip?: readonly string[]): string[];

export declare function sha256(bytes: Buffer | string): string;

export declare function hashFiles(root: string, files: readonly string[]): Record<string, string>;

export declare function diffHashes(
  first: Record<string, string>,
  second: Record<string, string>,
): { onlyFirst: string[]; onlySecond: string[]; changed: string[] };
