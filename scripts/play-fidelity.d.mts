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
