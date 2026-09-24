/** Typy k `fetch.mjs` pro TypeScript testy (konvence `scripts/build-from-tag.d.mts`). */

export declare const DEFAULT_CACHE: string;

export declare function licenseProblem(pack: { license: string }): string | null;
export declare function licenseTextProblem(pack: { license: string }, text: string): string | null;
export declare function objToGlb(objFile: string): Promise<string>;
export declare function fetchPacks(options: {
  packs: any[];
  cacheDir?: string;
  fetchImpl?: (url: string) => Promise<Response>;
  log?: (line: string) => void;
}): Promise<any>;
