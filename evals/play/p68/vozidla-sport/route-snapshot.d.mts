/** Typy k `route-snapshot.mjs` (skript běží holým Nodem, test je TypeScript). */

export interface RouteRow {
  readonly id: string;
  readonly text: string;
  readonly genre: string;
  readonly mode: string;
}

export interface RouteChange {
  readonly id: string;
  readonly text: string;
  readonly before: string;
  /** `null` = věta ve srovnání chybí. */
  readonly after: string | null;
}

type Classify = (sentence: string, reading: null) => { readonly ranked: readonly { readonly genre: string; readonly mode: string }[] };

export declare function routeRows(classifyGenre: Classify, sentences: readonly { readonly id: string; readonly text: string }[]): RouteRow[];
export declare function routeChanges(before: readonly RouteRow[], after: readonly RouteRow[]): RouteChange[];
