/**
 * Typy k `submission-check.mjs`. Skript musí jít spustit holým Nodem bez build
 * kroku, takže je to `.mjs`; testy jsou TypeScript a potřebují jeho kontrakt
 * zapsaný.
 */

export declare const MANIFEST_FILE: string;
export declare const REGISTRY_FILE: string;
export declare const PLACEHOLDER: RegExp;
export declare const VIDEO_LIMIT_SECONDS: number;
export declare const DESCRIPTION_MIN_CHARS: number;
export declare const LITERAL_BYTES_LIMIT: number;
export declare const COLLECTION_ITEMS_LIMIT: number;
export declare const MONITOR_MAX_INTERVAL_SECONDS: number;
export declare const COVERAGE_UNTIL: string;
export declare const HEARTBEAT_STALE_MULTIPLE: number;

/** Nevyplněné pole manifestu: prázdné, samá mezera, nebo s prefixem `TODO:`. */
export declare function isPlaceholder(value: unknown): boolean;

/** `null` když je to nasazená adresa, jinak důvod, proč není. */
export declare function isDeployedUrl(value: unknown): string | null;

/** Délka MP4 v sekundách z boxu `mvhd`; `null`, když se box nenajde. */
export declare function mp4DurationSeconds(buffer: Buffer): number | null;

/** Lexical disclosure lint for current English source-pilot copy, not semantic review. */
export declare function descriptionContractProblems(text: string): string[];
export declare function checkDescription(context: { repo: string; manifest: Record<string, unknown> }): string | null;

/** Text bez rozdílů, které nejsou obsahem: zalomení, dvojité mezery, nbsp. */
export declare function normalizeProse(text: string): string;

/** Zlomky a desetinná čísla — holé celé číslo se sem nebere. */
export declare function distinctiveNumbers(text: string): Set<string>;

/** Próza bez markdown syntaxe. */
export declare function proseOf(markdown: string): string;

export declare function focusCategoryInDescription(text: string): string | null;

/** Souhrn literálů v modulu: bajty všech literálů a nejdelší kolekce. */
export declare function literalWeight(path: string, source: string): { bytes: number; items: number };

/** Je cesta pokrytá některou z registrovaných cest? Přesně, nebo prefixem adresáře. */
export declare function coveredByPaths(path: string, registered: readonly string[]): boolean;

/** Cesty deklarované položkami `kind: dataset`. */
export declare function datasetPaths(registry: { entries?: readonly Record<string, unknown>[] }): string[];

export declare interface CheckContext {
  readonly repo: string;
  readonly manifest: Record<string, unknown> | null;
  readonly registry: { entries?: Record<string, unknown>[] };
  readonly sources: Map<string, string>;
  readonly fetchImpl: typeof fetch;
  readonly now: number;
}

export declare interface CheckResult {
  readonly id: number;
  readonly title: string;
  readonly skipped: boolean;
  readonly detail: string | null;
}

/**
 * Kontext kontrol. `repo`, `fetchImpl` a `now` jsou parametry, aby šly kontroly
 * testovat nad dočasným stromem a bez sítě — proces sám žádnou proměnnou
 * prostředí, která by je přepsala, nečte.
 */
export declare function buildContext(options?: {
  repo?: string;
  fetchImpl?: typeof fetch;
  now?: number;
}): CheckContext;

export declare function runChecks(context: CheckContext, options?: { offline?: boolean }): Promise<CheckResult[]>;

/** `0` prošlo všechno · `1` aspoň jedna kontrola selhala · `2` aspoň jedna se přeskočila. */
export declare function main(argv?: readonly string[]): Promise<number>;
