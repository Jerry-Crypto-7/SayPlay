/** Typy k `duel.mjs` pro TypeScript testy. */
export type DuelVote = 'new' | 'old' | null;
export declare const DUEL_FLOOR: number;
export declare const duelQuestion: string;
export declare const DUEL_SCHEMA: object;
export declare function isDuelAnswer(value: unknown): boolean;
export declare function oldFirst(seed: number): boolean;
export declare function duelJudges(codex: boolean): { judge: 'claude' | 'codex'; swap: boolean }[];
export declare function voteOf(answer: { better?: unknown; reason?: string } | null | undefined, oldCell: 1 | 2): DuelVote;
export declare function duelWins(score: number | null | undefined, votes: DuelVote[]): boolean;
export declare function runDuel(options: {
  key: string; oldGlb: string; newGlb: string; leaf?: string; dir: string; seed: number; takeCodex: () => boolean;
}): Promise<{ judge: 'claude' | 'codex'; oldCell: 1 | 2; vote: DuelVote; reason: string | null }[]>;
