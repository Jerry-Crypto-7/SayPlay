/** Typy k `promote-batch.mjs` pro TypeScript testy (konvence `scripts/build-from-tag.d.mts`). */

export declare const PUBLIC_DIR: string;
export declare const URL_BASE: string;
export declare const LICENSE: string;
export declare const CC0: string;
export declare const CC0_CACHE: string;
export declare function isOurs(asset: { lods: readonly { path: string }[] }): boolean;
export declare function promoteBatch(
  batch: { schema?: string; entries: readonly Record<string, unknown>[] },
  options?: { root?: string; sync?: boolean; drop?: string[] },
): Promise<{ promoted: string[]; skipped: { id: string; reason: string }[]; dropped: string[] }>;
export declare const REPLACED_DIR: string;
export declare function cc0Refusal(entry: { licence?: string; source?: { pack?: string; file?: string } }, cache?: string): string | null;
export declare function replaceModels(
  batch: { schema?: string; entries: readonly Record<string, unknown>[] },
  options?: { root?: string; sync?: boolean; replacedDir?: string; profile?: 'default' | 'hero'; origin?: 'generated' | 'cc0'; cc0Cache?: string },
): Promise<{ replaced: string[]; skipped: { id: string; reason: string }[] }>;
export declare function checkReplaced(input: {
  catalog: { assets: readonly unknown[] };
  disclosure: { entries: readonly unknown[] };
  root?: string;
}): Promise<string[]>;
