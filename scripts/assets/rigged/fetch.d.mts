/** Typy k `fetch.mjs` pro TypeScript testy (konvence `scripts/build-from-tag.d.mts`). */

export declare const ALLOWED_LICENSES: string[];

export declare interface RiggedSource {
  readonly id: string;
  readonly name: string;
  readonly author: string;
  readonly kind: 'github' | 'kenney' | 'skip' | string;
  readonly license: string;
  readonly page: string;
  readonly licenseUrl?: string;
  readonly files?: readonly string[];
  readonly skipReason?: string;
}

export declare interface FetchedFile {
  readonly url: string;
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
}

export declare type FetchRecord =
  | { readonly id: string; readonly name: string; readonly author: string; readonly page: string; readonly license: string; readonly licenseFile: string; readonly status: 'fetched'; readonly files: FetchedFile[]; readonly reason?: undefined }
  | { readonly id: string; readonly name: string; readonly page: string; readonly license: string; readonly status: 'skipped'; readonly reason: string; readonly licenseFile?: undefined; readonly files?: undefined };

export declare function licenseMatches(declared: string, text: string): boolean;
export declare function fetchSource(source: RiggedSource, options?: { readonly fetch?: typeof fetch; readonly cacheDir?: string }): Promise<FetchRecord>;
