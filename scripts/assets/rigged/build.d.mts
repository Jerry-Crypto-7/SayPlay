/** Typy k `build.mjs` pro TypeScript testy (konvence `scripts/build-from-tag.d.mts`). */

export declare const MAX_TRIANGLES: number;
export declare const MAX_BYTES: number;

export declare function readGlb(bytes: Buffer): { doc: any; bin: Buffer };
export declare function writeGlb(doc: any, bin: Buffer): Buffer;
