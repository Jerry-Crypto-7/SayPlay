/**
 * Položky z věty mají na scéně svůj model, ne zástupce (P30B T4).
 *
 * Mapa ztrát T1 (`evals/play/p30b/losses.json`) je baseline: slovní draft i
 * zmrazené AI specy (`live.json`) přes řetěz věrnosti na HEAD. Položka, kterou
 * baseline kreslil, kreslená zůstává, a kreslených položek (draft + ai, korpus
 * + judge-10) je aspoň o deset víc. Zisk jde z knihovny a vykreslení: závod,
 * rytmus a načasování kreslí popisek svých těl, soupeř souboje je postava
 * s nejbližší kategorií, auto soupeře je „traffic“ a kropítko má vlastní model.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import runner from '../arcade/__fixtures__/runner.json';
import { propModels } from '../arcade/models';
import { draftGameSpec } from '../draft';
import { fidelityChain, type ChecklistEntry } from '../fidelity/chain';
import type { GameSpecV1 } from '../spec';

interface Sentence {
  readonly id: string;
  readonly text: string;
  readonly checklist: readonly ChecklistEntry[];
}
interface Row {
  readonly source: 'draft' | 'ai';
  readonly id: string;
  readonly item: string;
  readonly role: string;
  readonly drawn: boolean;
}

const read = <T,>(...path: string[]): T => JSON.parse(readFileSync(join(process.cwd(), ...path), 'utf8')) as T;

const sentences = [
  ...read<{ sentences: Sentence[] }>('evals', 'play', 'fidelity', 'corpus.json').sentences,
  ...read<{ sentences: Sentence[] }>('evals', 'play', 'fidelity', 'judge-10.json').sentences,
];
const live = new Map(read<{ sentences: { id: string; spec: GameSpecV1 }[] }>('evals', 'play', 'p30b', 'live.json').sentences.map((entry) => [entry.id, entry.spec]));
const baseline = read<{ rows: Row[] }>('evals', 'play', 'p30b', 'losses.json').rows.filter((row) => row.role === 'item');

const key = (row: Pick<Row, 'source' | 'id' | 'item'>): string => `${row.source}|${row.id}|${row.item}`;

/** Položky (vedlejší role a cokoli z věty) obou zdrojů na HEAD, klíčované jako řádky baseline. */
function itemsNow(): Map<string, boolean> {
  const out = new Map<string, boolean>();
  for (const sentence of sentences) {
    const sources: [Row['source'], GameSpecV1 | undefined][] = [
      ['draft', draftGameSpec(sentence.text)],
      ['ai', live.get(sentence.id)],
    ];
    for (const [source, spec] of sources) {
      if (spec === undefined) continue;
      for (const item of fidelityChain(spec, sentence.checklist)) {
        if (item.slot === 'role' || item.slot === 'any') out.set(key({ source, id: sentence.id, item: item.item }), item.drawn);
      }
    }
  }
  return out;
}

describe('the items from the sentence are drawn with their own model', () => {
  const now = itemsNow();

  it('no item the baseline drew is lost', () => {
    const lost = baseline.filter((row) => row.drawn && now.get(key(row)) !== true).map(key);
    expect(lost).toEqual([]);
  });

  it('draws the items the loss map found without a model or unread by the control', () => {
    const found = [
      'draft|s006|sprinkler',
      'ai|s006|sprinkler',
      'draft|s056|traffic',
      'ai|s056|traffic',
      'draft|h05|kangaroo',
      'ai|h05|kangaroo',
      'ai|s058|crocodile',
      'ai|s144|lily pad',
      'ai|s099|pancake',
    ];
    expect(found.filter((row) => now.get(row) !== true)).toEqual([]);
  });

  it('draws at least ten more items than the baseline, draft and ai together', () => {
    const before = baseline.filter((row) => row.drawn).length;
    const after = baseline.filter((row) => now.get(key(row)) === true).length;
    expect(after).toBeGreaterThanOrEqual(before + 10);
  });
});

describe('a sentence item gets its model, not a stand-in', () => {
  const withLabel = (label: string): GameSpecV1 => {
    const spec = JSON.parse(JSON.stringify(runner)) as GameSpecV1;
    spec.roles = spec.roles.map((role) => (role.id === 'obstacle' ? { ...role, label } : role));
    return spec;
  };

  it('sprinklers are sprinklers, not a fire hydrant', () => {
    expect(propModels(withLabel('sprinklers'))).toEqual({ obstacle: 'sprinkler' });
  });

  it('a thing the catalog does not have stays the kernel obstacle', () => {
    expect(propModels(withLabel('deadlines'))).toEqual({});
  });
});
