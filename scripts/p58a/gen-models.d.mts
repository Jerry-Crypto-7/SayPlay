/** Typy k `gen-models.mjs` pro TypeScript test (konvence `why-unseen.d.mts`). */

export interface Attempt { readonly score?: number | null; readonly name?: string | null }

export declare const PASS: number;
export declare function idOf(noun: string): string;
export declare function named(name: string | null | undefined, names: readonly string[]): boolean;
export declare function winnerOf<A extends Attempt>(attempts: readonly A[], names: readonly string[]): A | null;
