/** Typy k `promote.mjs` pro TypeScript testy (konvence `scripts/build-from-tag.d.mts`). */

export declare const isCc0: (asset: { assetId: string }) => boolean;

export declare function cc0Tags(model: { noun: string; file: string; synonyms?: string[] }, taken: Set<string>): string[];
export declare function catalogIndex(catalog: any): { assets: any[] };
type Budget = { modelBytes: number; totalBytes: number };
export declare const BUDGET: Budget;
export declare function fitBudget<T extends { assetId: string; bytes: number; folderBytes?: number }>(items: T[], budget?: Budget): { kept: T[]; dropped: (T & { reason: string })[]; total: number };
export declare function folderBytes(dir: string): number;
export declare function checkCatalog(options: { catalog: any; disclosure: any; root?: string; budget?: Budget }): string[];
export declare function promote(options?: { root?: string; budget?: Budget }): Promise<{ promoted: number; dropped: number; files: number; totalBytes: number }>;
