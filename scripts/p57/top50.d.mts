/** Typy k `top50.mjs` pro TypeScript testy. */
export declare const HERO_PASS: number;
export declare const ROUND_ATTEMPTS: Record<1 | 2, string[]>;
export declare function heroTargets(
  judge: { models: Record<string, { score: number | null }> },
  usage: { top300: string[] },
  catalog: { assets: { assetId: string; provenance: { license: string } }[] },
): string[];
export declare function pickBest<T extends { pick?: number | null }>(candidates: T[]): T | null;
export declare function heroWins(score: number | null | undefined, old: number | null | undefined): boolean;
export declare function heroSummary(
  usage: { top300: string[] },
  judge: { models: Record<string, { score: number | null; claude?: { reason?: string }; codex?: { reason?: string } }> },
  models: Record<string, { result: string; newScore: number | null; oldOpus: number | null; reason?: string }>,
): { atLeast8: number; of: number; below: { id: string; score: number | null; reason: string }[] };
