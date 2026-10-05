/** Typy k `qa-astra.mjs` pro TypeScript testy (konvence `scripts/build-from-tag.d.mts`). */

export interface Prices { inUsdPerMtok: number; outUsdPerMtok: number }
export interface Usage { prompt_tokens: number; completion_tokens: number }

export declare const MAX_INPUT_TOKENS: number;
export declare const MAX_OUTPUT_TOKENS: number;
export declare const VERDICT_SCHEMA: { required: string[] };
export declare function assertNotTrainingDir(dir: string): void;
export declare function priceOf(usage: Usage, prices: Prices): number;
export declare function worstCaseUsd(prices: Prices): number;
export declare function parseVerdict(text: string): Record<string, unknown> | null;
export declare function runQa(options: {
  assets: any[];
  sheetFor: (asset: any) => Uint8Array;
  outDir: string;
  capUsd: number;
  limit?: number;
  prices: Prices;
  model: string;
  call: (body: any) => Promise<any>;
  now?: () => string;
}): Promise<{ done: number; invalid: number; stoppedByCap: boolean; spentUsd: number }>;
