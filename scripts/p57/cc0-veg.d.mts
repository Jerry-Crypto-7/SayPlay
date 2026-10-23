/** Typy k `cc0-veg.mjs` pro TypeScript testy. */
type Query = { key: string; all: string[][]; none?: string[] };
type Candidate = { key: string; pack: string; file: string; glb?: string; refused?: string | null; score?: number | null; fit?: string; name?: string | null };
type Item = { id: string; noun: string; oldHash: string; candidates: Candidate[]; duel: { candidate: string; oldHash: string; votes: { judge: string; vote: string | null }[] } | null };
export declare const CODEX_RESERVE: number;
export declare function isVegetation(noun: string): boolean;
export declare function queryFor(noun: string): Query | null;
export declare function matchFiles(query: Query | null, models: { pack: string; file: string }[], skip?: Set<string>): { pack: string; file: string }[];
export declare function vegTargets(input: {
  judge: { models: Record<string, { score: number | null }> };
  usage: { top300: string[] };
  catalog: { assets: { assetId: string; tags: string[]; provenance: { license: string } }[] };
  report?: { models?: Record<string, { result?: string }>; cc0Veg?: { models?: Record<string, { result?: string }> } };
  kit?: { missing: { id: string; noun: string }[] };
}): { targets: { id: string; noun: string; from: 'top50' | 'kit' }[]; outside: { id: string; noun: string }[] };
export declare function bestCandidate<T extends Candidate>(candidates: T[]): T | null;
export declare function vegResult(item: Item): string;
