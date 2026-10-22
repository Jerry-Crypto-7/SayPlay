/** Typy k `size-check.mjs` pro TypeScript testy. */

export type SizeState = {
  bytes: number;
  catalog: { assets: { assetId: string; lods: { level: number; bytes: number }[]; provenance?: { replacedAt?: string } }[] };
};

export declare function sizeGate(base: SizeState, head: SizeState): { growth: number; failures: string[] };
