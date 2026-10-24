/**
 * Typy k `play-fidelity.mjs`. Skript běží holým Nodem, test je TypeScript
 * a potřebuje jeho kontrakt zapsaný.
 */

import type { ChainItem, ChecklistEntry } from '../src/play/fidelity/chain';
import type { Reading } from '../src/play/read/schema';
import type { GameSpecV1 } from '../src/play/spec';

export type { ChecklistEntry };
export type FidelityItem = ChainItem;

export declare function checkCorpus(corpus: unknown): string[];

export declare function specFidelity(
  spec: unknown,
  checklist: readonly ChecklistEntry[],
): { readonly control: string; readonly items: FidelityItem[]; readonly score: number; readonly drawnScore: number; readonly roleScore: number };

export declare interface LossCause {
  readonly why: string;
  readonly control: string;
  readonly slot: string;
  readonly sentences: number;
  readonly ids: readonly string[];
}

type CorpusSentence = { readonly id: string; readonly text: string; readonly checklist: readonly ChecklistEntry[] };

/** `read`, `drawn` a `role` jednoho žánru (P39 T2). */
export declare interface GenreStages {
  readonly sentences: number;
  readonly read: number;
  readonly drawn: number;
  readonly role: number;
}

export declare function genreOfSpec(spec: Pick<GameSpecV1, 'control' | 'controlParams'>): string;

export declare function offlineChain(sentences: readonly CorpusSentence[], draftOf?: (sentence: CorpusSentence) => GameSpecV1): {
  readonly summary: {
    readonly sentences: number;
    readonly compiled: number;
    readonly items: number;
    readonly inSpec: number;
    readonly read: number;
    readonly drawn: number;
    readonly role: number;
    readonly roleNamed: number;
  };
  readonly byGenre: Readonly<Record<string, GenreStages>>;
  readonly causes: readonly LossCause[];
  readonly sentences: readonly { readonly id: string; readonly genre: string; readonly control: string; readonly addons: readonly string[]; readonly compiled: boolean; readonly items: readonly FidelityItem[] }[];
};

export declare const READER_GATE: { readonly minGain: number; readonly maxP95Ms: number };

export declare function readerDecision(input: { readonly reader: number; readonly regex: number; readonly p95Ms: number | null }): 'draft' | 'off';

export declare function readerDraft(text: string, reading: Reading | null): GameSpecV1;

export declare function normalizeSentence(text: string): string;

export declare const COMPARE_MODELS: Record<string, { readonly source: 'primary' | 'fallback'; readonly expect: RegExp }>;

export declare const PLAY_DOOR_SLOTS: number;

export declare function buildStamp(nextDir: string, commitMs: number): string;

export declare function modelEnv(name: string, env: Record<string, string | undefined>, capUsd: number, concurrency?: number, sentences?: number): Record<string, string>;

export declare function setSize(name: string | undefined, only?: string): number;

export declare function billedFromLog(text: string): { readonly model: string; readonly usd: number }[];

export type UpgradeCause = 'door' | 'cap' | 'model';

export declare function upgradeEnds(log: string, draftId: string): UpgradeCause[];

export declare function attemptsInFlight(log: string, draftId: string): number;

export interface MeasuredSentence {
  readonly id: string;
  readonly text: string;
  readonly checklist: readonly ChecklistEntry[];
  readonly error?: string;
  readonly draft: { readonly versionId: string; readonly spec: unknown; readonly frameMs: number | null; readonly frameError: string | null };
  readonly upgrade: { readonly status: string; readonly reason: string | null; readonly ms: number };
  readonly cause: UpgradeCause | null;
  readonly ai: {
    readonly versionId: string;
    readonly spec: unknown;
    readonly published: boolean;
    readonly source: string | null;
    readonly frameMs: number | null;
    readonly frameError: string | null;
  } | null;
}

export declare function measureSentence(
  sentence: CorpusSentence,
  options: {
    readonly base: string;
    readonly openGame: (url: string) => Promise<void>;
    readonly leave: () => Promise<unknown>;
    readonly log: () => string;
    readonly fetchImpl?: typeof fetch;
    readonly now?: () => number;
    readonly wait?: (ms: number) => Promise<void>;
    readonly pollMs?: number;
    readonly timeoutMs?: number;
    readonly settleMs?: number;
  },
): Promise<MeasuredSentence>;

export interface ModelComparison {
  readonly n: number;
  readonly concurrency: number;
  readonly errors: number;
  readonly refused: { readonly door: number; readonly cap: number };
  readonly published: { readonly ok: number; readonly of: number; readonly share: number; readonly failures: Record<string, number> };
  readonly sources: { readonly authored: number; readonly cached: number };
  readonly fidelity: { readonly inSpec: number | null; readonly read: number | null; readonly drawn: number | null; readonly role: number | null };
  readonly firstPlayableFrameMs: { readonly aiP50: number | null; readonly aiP95: number | null; readonly draftP50: number | null; readonly draftP95: number | null };
  readonly cost: { readonly calls: number; readonly usd: number; readonly perSentence: number | null; readonly perPublished: number | null };
}

export declare function compareSummary(
  runs: Record<string, { readonly buildId: string; readonly concurrency: number; readonly results: readonly (MeasuredSentence | Pick<MeasuredSentence, 'id' | 'text' | 'checklist' | 'error'>)[]; readonly billed: readonly { readonly model: string; readonly usd: number | null }[] }>,
  buildId: string,
): Record<string, ModelComparison>;

export declare function compareVerdict(models: Record<string, ModelComparison>): { readonly valid: boolean; readonly reason: string | null; readonly exitCode: 0 | 1 };

export declare const CLIP: { readonly frames: number; readonly gapTicks: number; readonly leadTicks: number; readonly hz: number };

export declare const PACE: { readonly leadTicks: number; readonly gapTicks: number; readonly maxFrames: number };
export declare function paceTicks(endTick: number | null): number[];

export type PairSide = 'a' | 'b';
export interface PairSummary {
  readonly n: number;
  readonly aWins: number;
  readonly bWins: number;
  readonly ties: number;
  readonly bShare: number | null;
  readonly leftWinShare: number | null;
}
export interface PairVerdict {
  readonly schema: 'pairwise.v1';
  readonly a: { readonly run: string; readonly commit: string | null };
  readonly b: { readonly run: string; readonly commit: string | null };
  readonly question: 'fun' | 'match';
  readonly seed: number;
  readonly order: string;
  readonly pairs: readonly { readonly id: string; readonly left: PairSide; readonly winner: PairSide | 'tie'; readonly why: string }[];
  readonly summary: PairSummary;
}
export declare const PAIR_SEED: number;
export declare const PAIR_QUESTION: string;
export declare function matchQuestion(sentence: string): string;
export declare const PAIR_SCHEMA: Record<string, unknown>;
export declare function pairSides(seed: number, count: number): PairSide[];
export declare function pairwise(
  options: Record<string, unknown>,
  steps?: {
    readonly ask?: (sheet: string, schemaFile: string, answerFile: string, question: string) => Promise<{ readonly code: number | null; readonly stderr?: string }>;
    readonly compose?: (left: readonly string[], right: readonly string[], path: string) => Promise<void>;
  },
): Promise<PairVerdict>;

export declare const P45_BASE_COMMIT: string;
export declare const PAIR_TARGET_B: number;
export declare function funCommand(
  options: Record<string, unknown>,
  steps?: {
    readonly loadSet?: (name: string, options: { readonly openTestOnce: boolean; readonly runId: string }) => unknown;
    readonly runSentences?: (sentences: unknown, options: Record<string, unknown>) => Promise<void>;
    readonly pairwise?: (options: Record<string, unknown>) => Promise<{ readonly summary: PairSummary }>;
    readonly measure?: (set: 'panel' | 'sealed', open: boolean, out: string) => Promise<{ readonly met: boolean; readonly targets?: readonly { readonly metric: string; readonly goal: string; readonly value: number | null; readonly met: boolean }[] } & Record<string, unknown>>;
  },
): Promise<Record<string, unknown>>;

export declare function contract(checklist: readonly ChecklistEntry[], frames?: number): string;

export declare function judgeShot(
  images: readonly string[],
  checklist: readonly ChecklistEntry[],
  runDir: string,
  tag: string,
): { readonly verdict: Record<string, boolean>; readonly answers: readonly { readonly item: string; readonly visible: boolean; readonly why?: string }[] };

export declare function judge(options: { readonly run?: string; readonly clip?: boolean; readonly only?: string }): void;

export declare function loadSet(
  name: string | undefined,
  options?: { readonly only?: string; readonly openTestOnce?: boolean; readonly runId?: string | null; readonly sealDir?: string },
): (CorpusSentence & { readonly source?: string })[];

interface Tally {
  readonly hit: number;
  readonly of: number;
}

export declare function summarize(results: readonly unknown[]): {
  readonly n: number;
  readonly upgradeSuccess: { readonly ok: number; readonly of: number; readonly failures: Record<string, number> };
  readonly specFidelity: { readonly final: number | null; readonly draft: number | null; readonly ai: number | null; readonly inSpecFinal: number | null; readonly drawnFinal: number | null; readonly roleFinal: number | null; readonly roleDraft: number | null };
  readonly recognizable: Record<'final' | 'draft', { readonly items: Tally; readonly hero: Tally; readonly setting: Tally; readonly judged: number }>;
  readonly timing: { readonly draftMsP50: number | null; readonly upgradeSecondsP50: number | null; readonly upgradeSecondsP90: number | null };
};
