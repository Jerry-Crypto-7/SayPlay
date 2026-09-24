/** Typy k `select.mjs` pro TypeScript testy (konvence `scripts/build-from-tag.d.mts`). */

export declare const MAX_SELECTED: number;

export declare function modelTokens(file: string): string[];
export declare function sentenceNouns(text: string): any;
export declare function selectModels(options: { sentences: any; known: any; models: any; max?: number }): any;
export declare function cacheModels(fetched: any): any;
export declare const MAX_BROAD: number;
export declare function selectBroad(options: { models: any; known: Set<string>; max?: number }): any;
export declare function findByLabel(selected: any[], label: string): any;
