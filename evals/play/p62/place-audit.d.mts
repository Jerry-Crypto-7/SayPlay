/**
 * Typy k `place-audit.mjs`. Skript běží holým Nodem, test je TypeScript a potřebuje jeho kontrakt zapsaný.
 */

export type PlaceClass = 'compound' | 'overridden' | 'foreign-interior' | 'unknown-place' | 'other';

/** Ruční štítek věty: místo, jak ho věta jmenuje (`null` = žádné), a sady, ve kterých by ho divák poznal. */
export interface PlaceLabel {
  readonly id: string;
  readonly place: string | null;
  readonly ok: readonly string[];
}

export interface OpenSentence {
  readonly id: string;
  readonly text: string;
  readonly sets: readonly string[];
}

export interface PlaceRow {
  readonly id: string;
  readonly text: string;
  readonly place: string | null;
  readonly ok: readonly string[];
  readonly drawn: string;
  readonly verdict: 'right' | 'wrong' | 'no-place';
  readonly class?: PlaceClass;
  readonly themeLook?: string | null;
  readonly chain?: boolean;
  readonly genre?: string | null;
}

export interface PlaceSummary {
  readonly sentences: number;
  readonly namedPlace: number;
  readonly right: number;
  readonly wrong: number;
  readonly classes: Readonly<Record<PlaceClass, number>>;
}

export function placeAuditSets(): string[];
export function openSentences(): OpenSentence[];
export function placeClass(label: PlaceLabel, drawn: string, text?: string): PlaceClass | null;
export function placeRow(sentence: { readonly id: string; readonly text: string }, label: PlaceLabel, drawn: string): PlaceRow;
export function summarizePlaces(rows: readonly PlaceRow[]): PlaceSummary;
export function labelsById(): Map<string, PlaceLabel>;
