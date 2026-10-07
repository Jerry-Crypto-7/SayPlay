/**
 * Věrnost po přepojení na žánry (P32B T6).
 *
 * `evals/play/p32/fidelity-b.json` (skript `scripts/p32/fidelity-b.mjs`) páruje
 * každou položku korpusu a `judge-10` se stavem P30B (`p30b/after.json`):
 * slovní draft nové hry je od P32B T2 žánr, AI specy jsou zmrazené. Ztráta
 * u věty, která dřív hrála legacy ovládání, je přípustná jen vysvětlená ve
 * `fidelity-b.md`; HEAD pak kreslí aspoň to, co soubor zapsal.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { draftGameSpecWithMeta } from '@/play/draft';
import { matchesWitness } from '@/play/arcade/witness';
import { extractIntent } from '@/play/intent/extract';
import { fidelityChain, type ChecklistEntry } from '@/play/fidelity/chain';
import type { GameSpecV1 } from '@/play/spec';

type Source = 'draft' | 'ai';
type Role = 'hero' | 'item' | 'setting' | 'verb';
interface Tally {
  readonly of: number;
  readonly before: number;
  readonly after: number;
}
interface FidelityB {
  readonly totals: Record<string, Record<Source, Record<Role, Tally>>>;
  readonly sentences: readonly {
    readonly set: string;
    readonly source: Source;
    readonly id: string;
    readonly items: readonly { readonly item: string; readonly role: Role; readonly before: boolean; readonly after: boolean }[];
  }[];
}
interface Sentence {
  readonly id: string;
  readonly text: string;
  readonly checklist: readonly ChecklistEntry[];
}

const read = (...path: string[]): string => readFileSync(join(process.cwd(), ...path), 'utf8');
const json = <T,>(...path: string[]): T => JSON.parse(read(...path)) as T;

const result = json<FidelityB>('evals', 'play', 'p32', 'fidelity-b.json');
const notes = read('evals', 'play', 'p32', 'fidelity-b.md');
const items = result.sentences.flatMap((sentence) => sentence.items.map((item) => ({ ...item, id: sentence.id, key: `${sentence.source}|${sentence.id}|${item.item}` })));

/** Kolik položek role je kreslených před a po, přes obě sady a oba zdroje. */
const sum = (role: Role, side: 'before' | 'after'): number =>
  Object.values(result.totals).reduce((total, sources) => total + sources.draft[role][side] + sources.ai[role][side], 0);

describe('P32B offline fidelity after the genre rewire', () => {
  it('the totals are the counts of the paired items', () => {
    for (const [set, sources] of Object.entries(result.totals)) {
      for (const source of ['draft', 'ai'] as const) {
        for (const [role, tally] of Object.entries(sources[source])) {
          const mine = result.sentences.filter((sentence) => sentence.set === set && sentence.source === source).flatMap((sentence) => sentence.items.filter((item) => item.role === role));
          expect({ of: mine.length, before: mine.filter((item) => item.before).length, after: mine.filter((item) => item.after).length }, `${set} ${source} ${role}`).toEqual(tally);
        }
      }
    }
  });

  it('starts from the P30B counts and keeps the hero', () => {
    expect([sum('hero', 'before'), sum('item', 'before'), sum('verb', 'before')]).toEqual([39, 67, 61]);
    expect(sum('hero', 'after')).toBeGreaterThanOrEqual(sum('hero', 'before'));
  });

  it('explains every item it lost, sentence by sentence, in fidelity-b.md', () => {
    const lost = [...new Set(items.filter((item) => item.before && !item.after).map((item) => item.id))];
    expect(lost.length).toBeGreaterThan(0);
    expect(lost.filter((id) => !new RegExp(`^\\| \`${id}\` \\|`, 'm').test(notes))).toEqual([]);
  });

  it('loses nothing on the frozen AI specs', () => {
    expect(items.filter((item) => item.key.startsWith('ai|') && item.before && !item.after).map((item) => item.key)).toEqual([]);
  });

  it('keeps the recorded nouns and either plays or explicitly admits each old verb claim', () => {
    const sentences = [...json<{ sentences: Sentence[] }>('evals', 'play', 'fidelity', 'corpus.json').sentences, ...json<{ sentences: Sentence[] }>('evals', 'play', 'fidelity', 'judge-10.json').sentences];
    const live = new Map(json<{ sentences: { id: string; spec: GameSpecV1 }[] }>('evals', 'play', 'p30b', 'live.json').sentences.map((entry) => [entry.id, entry.spec]));
    const now = new Map<string, boolean>();
    const admitted = new Set<string>();
    for (const sentence of sentences) {
      const draft = draftGameSpecWithMeta(sentence.text);
      const intent = extractIntent(sentence.text);
      for (const item of fidelityChain(draft.spec, sentence.checklist)) {
        const key = `draft|${sentence.id}|${item.item}`;
        // Native motion may be outside the frozen legacy control whitelist.
        // Accept only a real witness for the sentence's exact action triple.
        const played = item.slot === 'verb' && intent.items.some(triple => triple.verb === item.item && draft.composition?.witnesses.some(witness => matchesWitness(triple, witness)));
        now.set(key, item.drawn || played);
        // Legacy control labels counted defence as shooting. P41 may honestly
        // admit an unsupported verb; it may never silently lose a noun or verb.
        if (item.slot === 'verb' && draft.composition?.unmet.some(triple => triple.verb === item.item)) admitted.add(key);
      }
      const spec = live.get(sentence.id);
      if (spec !== undefined) for (const item of fidelityChain(spec, sentence.checklist)) now.set(`ai|${sentence.id}|${item.item}`, item.drawn);
    }
    expect(items.filter((item) => item.after).length).toBe(['hero', 'item', 'setting', 'verb'].reduce((total, role) => total + sum(role as Role, 'after'), 0));
    expect(items.filter((item) => item.after && now.get(item.key) !== true && !admitted.has(item.key)).map((item) => item.key)).toEqual([]);
  }, 120_000);
});
