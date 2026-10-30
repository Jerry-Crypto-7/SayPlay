/**
 * Typy k `genre-route.mjs`. Skript běží holým Nodem, test je TypeScript a potřebuje jeho kontrakt zapsaný.
 */

export interface RouteRow {
  readonly best: string | null;
  readonly acceptable: readonly string[];
  /** Žánr rychlé hry. */
  readonly genre: string;
}

export interface RouteStats {
  readonly sentences: number;
  readonly none: number;
  readonly counted: number;
  readonly wrong: number;
  readonly wrongRate: number | null;
}

export interface Reach {
  readonly best: number;
  readonly acceptable: number;
  readonly share: number | null;
  readonly from: Readonly<Record<string, number>>;
}

export function isWrong(row: RouteRow): boolean;
export function routeStats(rows: readonly RouteRow[]): RouteStats;
export function reachOf(rows: readonly RouteRow[], genre: string): Reach;
