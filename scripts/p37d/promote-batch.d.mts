/** Typy k `promote-batch.mjs` pro TypeScript testy (konvence `scripts/build-from-tag.d.mts`). */

export declare const PUBLIC_DIR: string;
export declare const URL_BASE: string;
export declare const LICENSE: string;
export declare function isOurs(asset: { lods: readonly { path: string }[] }): boolean;
export declare function promoteBatch(
  batch: { schema?: string; entries: readonly Record<string, unknown>[] },
  options?: { root?: string; sync?: boolean; drop?: string[] },
): Promise<{ promoted: string[]; skipped: { id: string; reason: string }[]; dropped: string[] }>;
