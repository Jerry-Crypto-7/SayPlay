/**
 * Zisk P30B na offline řetězu věrnosti (T7).
 *
 * `evals/play/p30b/after.json` páruje každou položku korpusu a `judge-10`
 * (slovní draft i zmrazené AI specy z `live.json`) před opravami – kód T1
 * s dnešním pravidlem slovesa – a po nich. Žádná položka, kterou baseline
 * kreslila, se neztratí, zisky T3 (hrdina +4) a T4 (položky +10) drží a HEAD
 * kreslí aspoň to, co soubor zapsal.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { fidelityChain, type ChecklistEntry } from '@/play/fidelity/chain';
import type { GameSpecV1 } from '@/play/spec';

type Source = 'draft' | 'ai';
type Role = 'hero' | 'item' | 'setting' | 'verb';
interface Tally {
  readonly of: number;
  readonly before: number;
  readonly after: number;
}
interface After {
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

const read = <T,>(...path: string[]): T => JSON.parse(readFileSync(join(process.cwd(), ...path), 'utf8')) as T;

const after = read<After>('evals', 'play', 'p30b', 'after.json');
const items = after.sentences.flatMap((sentence) => sentence.items.map((item) => ({ ...item, key: `${sentence.source}|${sentence.id}|${item.item}` })));

/** Kolik položek role je kreslených před a po, přes obě sady a oba zdroje. */
const sum = (role: Role, side: 'before' | 'after'): number =>
  Object.values(after.totals).reduce((total, sources) => total + sources.draft[role][side] + sources.ai[role][side], 0);

describe('P30B offline fidelity gain over the T1 baseline', () => {
  it('no item the baseline drew is lost', () => {
    expect(items.filter((item) => item.before && !item.after).map((item) => item.key)).toEqual([]);
  });

  it('the totals are the counts of the paired items', () => {
    for (const [set, sources] of Object.entries(after.totals)) {
      for (const source of ['draft', 'ai'] as const) {
        for (const [role, tally] of Object.entries(sources[source])) {
          const mine = after.sentences.filter((sentence) => sentence.set === set && sentence.source === source).flatMap((sentence) => sentence.items.filter((item) => item.role === role));
          expect({ of: mine.length, before: mine.filter((item) => item.before).length, after: mine.filter((item) => item.after).length }, `${set} ${source} ${role}`).toEqual(tally);
        }
      }
    }
  });

  it('keeps the hero gain of T3 and the item gain of T4', () => {
    expect(sum('hero', 'after')).toBeGreaterThanOrEqual(sum('hero', 'before') + 4);
    expect(sum('item', 'after')).toBeGreaterThanOrEqual(sum('item', 'before') + 10);
  });

  // Od P32B T2 jen zdroj AI: slovní draft nové hry je žánr a co z něj scéna nakreslí, rozhoduje
  // modul žánru – to pinuje P32B T6 nad skutečnými moduly; že draft položku do specu zapíše, hlídá `draft.test.ts`.
  it('HEAD still draws every AI item after.json records as drawn', () => {
    const sentences = [
      ...read<{ sentences: Sentence[] }>('evals', 'play', 'fidelity', 'corpus.json').sentences,
      ...read<{ sentences: Sentence[] }>('evals', 'play', 'fidelity', 'judge-10.json').sentences,
    ];
    const live = new Map(read<{ sentences: { id: string; spec: GameSpecV1 }[] }>('evals', 'play', 'p30b', 'live.json').sentences.map((entry) => [entry.id, entry.spec]));
    const now = new Map<string, boolean>();
    for (const sentence of sentences) {
      const spec = live.get(sentence.id);
      if (spec === undefined) continue;
      for (const item of fidelityChain(spec, sentence.checklist)) now.set(`ai|${sentence.id}|${item.item}`, item.drawn);
    }
    const ai = items.filter((item) => item.key.startsWith('ai|'));
    expect(ai.filter((item) => item.after).length).toBeGreaterThan(0);
    expect(ai.filter((item) => item.after && now.get(item.key) !== true).map((item) => item.key)).toEqual([]);
  }, 60_000);
});
