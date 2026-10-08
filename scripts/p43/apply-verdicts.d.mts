/** Typy k `apply-verdicts.mjs` pro TypeScript testy (konvence `library-judge.d.mts`). */

import type { Verdict } from './library-judge.mjs';

export type CatalogAsset = { assetId: string; label: string; tags: string[] };
export type Catalog<A extends CatalogAsset = CatalogAsset> = { assets: A[] } & Record<string, unknown>;

export declare const SEEN: 'seen:';
export declare const UNRECOGNISABLE: 'qa:unrecognisable';
export declare function fitsCatalog(asset: CatalogAsset, verdict: Verdict): boolean;
export declare function applyVerdicts<A extends CatalogAsset>(
  catalog: Catalog<A>,
  verdicts: Record<string, Verdict>,
): { catalog: Catalog<A>; seen: { assetId: string; label: string; seen: string }[]; unrecognisable: string[] };
