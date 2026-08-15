/**
 * Typy k `prove-fallback-isolation.mjs`. Skript musí jít spustit holým Nodem
 * bez build kroku, takže je to `.mjs`; testy jsou TypeScript a potřebují jeho
 * kontrakt zapsaný.
 */

export declare const CORE_DIRS: string[];
export declare const PROTECTED_DIRS: string[];
export declare const FALLBACK_ROUTE: string;

export declare const SMOKE_CASES: readonly {
  readonly prompt: string;
  readonly kind: string;
  readonly who: string;
  readonly layout: string;
}[];

export declare type AnalyzerModule = {
  readonly chunk: string;
  readonly path: string;
  /** Zdrojové bajty modulu tak, jak je viděl webpack (`statSize`). */
  readonly statBytes: number;
};

export declare function importSpecifiers(source: string): string[];

export declare function resolveSpecifier(
  fromFile: string,
  specifier: string,
  universe: Set<string>,
): string | null;

export declare function buildImportGraph(
  sourceFiles: readonly string[],
  universe: Set<string>,
  read: (file: string) => string,
): Map<string, string[]>;

export declare function isUnder(path: string, dirs: readonly string[]): boolean;

export declare function coreReachSet(
  graph: Map<string, string[]>,
  seed: readonly string[],
): Set<string>;

export declare function globalMembers(source: string): string[];

export declare function expandByAmbientGlobals(
  reach: Set<string>,
  sourceFiles: readonly string[],
  read: (file: string) => string,
): Set<string>;

export declare function moduleTail(path: string): string;

export declare function analyzerModules(report: unknown[]): AnalyzerModule[];

export declare function coreModulesIn(modules: readonly AnalyzerModule[]): AnalyzerModule[];

export declare function mixedChunks(modules: readonly AnalyzerModule[]): {
  chunk: string;
  core: string[];
}[];

export declare function fallbackBytes(modules: readonly AnalyzerModule[]): {
  moduleCount: number;
  statBytes: number;
  totalStatBytes: number;
};

export declare const ENV_ALLOWLIST: string[];

export declare function scrubbedEnv(env: Record<string, string | undefined>): Record<string, string>;

/** `args` tak, jak je dostane `net.Socket.prototype.connect`. */
export declare function isLocalConnect(args: unknown[]): boolean;

export declare function testId(html: string, id: string): string | null;

export declare function listFiles(dir: string, out?: string[]): string[];

export declare function quarantineAll(
  root: string,
  quarantine: string,
  files: readonly string[],
  moved: string[],
): void;

export declare function restoreAll(
  root: string,
  quarantine: string,
  files: readonly string[],
): void;

export declare function missingAfterRestore(root: string, files: readonly string[]): string[];
