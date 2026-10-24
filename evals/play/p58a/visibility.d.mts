/**
 * Typy k `visibility.mjs`. Skript běží holým Nodem, test je TypeScript a potřebuje jeho kontrakt zapsaný.
 */

import type { NounVerdict } from '../p56a/visible.mjs';

export interface VisibilityRow {
  readonly set: string;
  readonly id: string;
  readonly judge: string;
  readonly all: boolean;
  readonly nouns: (NounVerdict & { readonly role: 'hero' | 'other' })[];
  readonly [key: string]: unknown;
}

export declare function rowsOf(dir: string, setPath: string): VisibilityRow[];

export declare function tally(rows: readonly VisibilityRow[]): {
  readonly sentences: number;
  readonly allSeen: number;
  readonly nouns: number;
  readonly nounsSeen: number;
  readonly hero: number;
  readonly heroSeen: number;
  readonly other: number;
  readonly otherSeen: number;
  readonly judges: Record<string, number>;
};
