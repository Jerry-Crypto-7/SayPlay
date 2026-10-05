/** Typy k `promote.mjs` pro TypeScript testy (konvence `scripts/build-from-tag.d.mts`). */

export declare const isGen3d: (asset: { lods: readonly { path: string }[] }) => boolean;
export declare function promote(options?: { root?: string }): Promise<{ promoted: number; skipped: { noun: string; reason: string }[] }>;
