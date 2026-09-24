/**
 * Typy k `play-fidelity.mjs`. Skript běží holým Nodem, test je TypeScript
 * a potřebuje jeho kontrakt zapsaný.
 */

import type { ChainItem, ChecklistEntry } from '../src/play/fidelity/chain';

export type { ChecklistEntry };
export type FidelityItem = ChainItem;

export declare function checkCorpus(corpus: unknown): string[];

export declare function specFidelity(
  spec: unknown,
  checklist: readonly ChecklistEntry[],
): { readonly control: string; readonly items: FidelityItem[]; readonly score: number; readonly drawnScore: number };

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
