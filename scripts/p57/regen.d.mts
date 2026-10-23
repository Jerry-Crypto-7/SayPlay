/** Typy k `regen.mjs` pro TypeScript testy. */
export declare const PASS: number;
export declare const MAX_SPREAD: number;
export declare function targets(judge: { below6: string[] }, usage: { top300: string[] }): string[];
export declare function oldOpusOf(model: { score: number | null; claude?: { score: number } } & Record<string, unknown>): number | null;
export declare const MAX_STRETCH: number;
export declare function fitScale(dims: number[], oldDims: number[]): [number, number, number] | null;
export declare function winnerOf<T extends { score?: number | null }>(attempts: T[], oldScore: number): T | null;
export declare function resultOf(attempts: { fit?: string; score?: number | null }[], refused: string | undefined): 'rejected-bounds' | 'kept-old';
