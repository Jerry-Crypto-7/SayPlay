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
): { readonly control: string; readonly items: FidelityItem[]; readonly score: number; readonly drawnScore: number };

export declare interface LossCause {
  readonly why: string;
  readonly control: string;
  readonly slot: string;
  readonly sentences: number;
  readonly ids: readonly string[];
}

type CorpusSentence = { readonly id: string; readonly text: string; readonly checklist: readonly ChecklistEntry[] };

export declare function offlineChain(sentences: readonly CorpusSentence[], draftOf?: (sentence: CorpusSentence) => GameSpecV1): {
  readonly summary: { readonly sentences: number; readonly compiled: number; readonly items: number; readonly inSpec: number; readonly read: number; readonly drawn: number };
  readonly causes: readonly LossCause[];
  readonly sentences: readonly { readonly id: string; readonly control: string; readonly addons: readonly string[]; readonly compiled: boolean; readonly items: readonly FidelityItem[] }[];
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
  readonly fidelity: { readonly inSpec: number | null; readonly read: number | null; readonly drawn: number | null };
  readonly firstPlayableFrameMs: { readonly aiP50: number | null; readonly aiP95: number | null; readonly draftP50: number | null; readonly draftP95: number | null };
  readonly cost: { readonly calls: number; readonly usd: number; readonly perSentence: number | null; readonly perPublished: number | null };
}

export declare function compareSummary(
  runs: Record<string, { readonly buildId: string; readonly concurrency: number; readonly results: readonly (MeasuredSentence | Pick<MeasuredSentence, 'id' | 'text' | 'checklist' | 'error'>)[]; readonly billed: readonly { readonly model: string; readonly usd: number | null }[] }>,
): Record<string, ModelComparison>;

export declare function compareVerdict(models: Record<string, ModelComparison>): { readonly valid: boolean; readonly reason: string | null; readonly exitCode: 0 | 1 };

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
  readonly specFidelity: { readonly final: number | null; readonly draft: number | null; readonly ai: number | null; readonly inSpecFinal: number | null; readonly drawnFinal: number | null };
  readonly recognizable: Record<'final' | 'draft', { readonly items: Tally; readonly hero: Tally; readonly setting: Tally; readonly judged: number }>;
  readonly timing: { readonly draftMsP50: number | null; readonly upgradeSecondsP50: number | null; readonly upgradeSecondsP90: number | null };
};
