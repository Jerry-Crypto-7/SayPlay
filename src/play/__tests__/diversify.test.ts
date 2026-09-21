/**
 * Rozmanitost feedu (P23-D T4): feed s jedním archetypem osmkrát za sebou
 * vypadá plný a přitom ukazuje jednu hru. Test drží, že v každé zarovnané
 * osmici je nejvýš tři hry téhož archetypu a že pořadí jinak zůstává od nejnovější.
 */

import { describe, expect, it } from 'vitest';

import { diversify, FEED_BLOCK, MAX_PER_ARCHETYPE, type FeedRow } from '../version/diversify';

function row(index: number, archetype: string): FeedRow {
  // Vyšší index = novější hra.
  return { versionId: `v${String(index)}`, archetype, createdAt: new Date(1_700_000_000_000 + index * 1000).toISOString() };
}

function assertBlocks(rows: readonly FeedRow[]): void {
  for (let start = 0; start < rows.length; start += FEED_BLOCK) {
    const counts = new Map<string, number>();
    for (const { archetype } of rows.slice(start, start + FEED_BLOCK)) counts.set(archetype, (counts.get(archetype) ?? 0) + 1);
    for (const count of counts.values()) expect(count).toBeLessThanOrEqual(MAX_PER_ARCHETYPE);
  }
}

describe('diversify', () => {
  it('keeps newest-first order when the feed is already varied', () => {
    const rows = ['chase_escape', 'collect_exit', 'delivery', 'switch_puzzle'].map((archetype, index) => row(index, archetype));
    expect(diversify(rows).map((r) => r.versionId)).toEqual(['v3', 'v2', 'v1', 'v0']);
  });

  it('never puts more than three of one archetype into any block of eight', () => {
    // Deset honiček nejnovějších, pod nimi šest jiných her.
    const rows = [
      ...Array.from({ length: 6 }, (_, i) => row(i, ['collect_exit', 'delivery', 'switch_puzzle'][i % 3])),
      ...Array.from({ length: 10 }, (_, i) => row(100 + i, 'chase_escape')),
    ];
    const out = diversify(rows, 24);
    assertBlocks(out);
    expect(out.slice(0, 3).map((r) => r.archetype)).toEqual(['chase_escape', 'chase_escape', 'chase_escape']);
    expect(out.slice(0, FEED_BLOCK).filter((r) => r.archetype === 'chase_escape')).toHaveLength(3);
    // Odložené honičky se vrátí v další osmici, ne zmizí.
    expect(out.slice(FEED_BLOCK).some((r) => r.archetype === 'chase_escape')).toBe(true);
    expect(new Set(out.map((r) => r.versionId)).size).toBe(out.length);
  });

  it('ends the feed rather than break the rule when one archetype is all that is left', () => {
    const out = diversify(Array.from({ length: 8 }, (_, i) => row(i, 'chase_escape')));
    expect(out.map((r) => r.versionId)).toEqual(['v7', 'v6', 'v5']);
  });

  it('honours the limit and the empty feed', () => {
    const rows = Array.from({ length: 30 }, (_, i) => row(i, ['a', 'b', 'c', 'd'][i % 4]));
    expect(diversify(rows, 24)).toHaveLength(24);
    expect(diversify([], 24)).toEqual([]);
  });
});
