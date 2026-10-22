/**
 * Typy k `visible.mjs`. Skript běží holým Nodem, test je TypeScript a potřebuje jeho kontrakt zapsaný.
 */

export declare const PLAY_TICKS: number;

export declare function nounsOf(sentence: { readonly hero: string | null; readonly foe: string | null; readonly item: string | null }): string[];

export declare function questionOf(nouns: readonly string[]): string;

export declare const SCHEMA: Record<string, unknown>;

export interface NounVerdict { readonly noun: string; readonly visible: boolean; readonly seenAs: string | null }

export declare function verdictOf(
  nouns: readonly string[],
  answer: { readonly scene?: string; readonly nouns?: readonly { readonly noun: string; readonly visible: boolean; readonly seenAs: string }[] } | null,
): { readonly all: boolean; readonly nouns: NounVerdict[] };
