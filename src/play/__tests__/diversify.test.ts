/**
 * Rozmanitost feedu (P23-D T4, P70C T4): feed s jedním žánrem osmkrát za sebou
 * vypadá plný a přitom ukazuje jednu hru. Test drží, že v každé zarovnané
 * osmici jsou nejvýš dvě hry téhož žánru (u hry bez žánru ovládání, u starého
 * řádku archetyp) a že pořadí jinak zůstává od nejnovější.
 */

import { describe, expect, it } from 'vitest';

import { diversify, FEED_BLOCK, feedKindOf, MAX_PER_GENRE, type FeedRow } from '../version/diversify';

function row(index: number, archetype: string, genre?: string): FeedRow {
  // Vyšší index = novější hra.
  return { versionId: `v${String(index)}`, archetype, ...(genre === undefined ? {} : { genre }), createdAt: new Date(1_700_000_000_000 + index * 1000).toISOString() };
}

const kind = (r: FeedRow): string => r.genre ?? r.archetype;

function assertBlocks(rows: readonly FeedRow[]): void {
  for (let start = 0; start < rows.length; start += FEED_BLOCK) {
    const counts = new Map<string, number>();
    for (const r of rows.slice(start, start + FEED_BLOCK)) counts.set(kind(r), (counts.get(kind(r)) ?? 0) + 1);
    for (const count of counts.values()) expect(count).toBeLessThanOrEqual(MAX_PER_GENRE);
  }
}

describe('diversify', () => {
  it('keeps newest-first order when the feed is already varied', () => {
    const rows = ['chase_escape', 'collect_exit', 'delivery', 'switch_puzzle'].map((archetype, index) => row(index, archetype));
    expect(diversify(rows).map((r) => r.versionId)).toEqual(['v3', 'v2', 'v1', 'v0']);
  });

  it('never puts more than two of one kind into any block of eight', () => {
    // Deset honiček nejnovějších, pod nimi šest jiných her.
    const rows = [
      ...Array.from({ length: 6 }, (_, i) => row(i, ['collect_exit', 'delivery', 'switch_puzzle'][i % 3]!)),
      ...Array.from({ length: 10 }, (_, i) => row(100 + i, 'chase_escape')),
    ];
    const out = diversify(rows, 24);
    assertBlocks(out);
    expect(MAX_PER_GENRE).toBe(2);
    expect(out.slice(0, 2).map((r) => r.archetype)).toEqual(['chase_escape', 'chase_escape']);
    expect(out.slice(0, FEED_BLOCK).filter((r) => r.archetype === 'chase_escape')).toHaveLength(2);
    // Odložené honičky se vrátí v další osmici, ne zmizí.
    expect(out.slice(FEED_BLOCK).some((r) => r.archetype === 'chase_escape')).toBe(true);
    expect(new Set(out.map((r) => r.versionId)).size).toBe(out.length);
  });

  // P70C T4: osm her „collect_exit“ z osmi žánrů je osm různých her; čtyři žánry pod čtyřmi archetypy jsou jeden žánr.
  it('counts by genre when the row has one, not by archetype', () => {
    const genres = ['catch', 'slice', 'hole', 'merge', 'sort', 'minigolf', 'railfps', 'drawsave'];
    const varied = genres.map((genre, i) => row(i, 'collect_exit', genre));
    expect(diversify(varied).map((r) => r.versionId)).toEqual(['v7', 'v6', 'v5', 'v4', 'v3', 'v2', 'v1', 'v0']);
    const oneGenre = [
      ...['chase_escape', 'collect_exit', 'delivery', 'switch_puzzle'].map((archetype, i) => row(100 + i, archetype, 'arena')),
      ...Array.from({ length: 6 }, (_, i) => row(i, 'collect_exit', genres[i])),
    ];
    const out = diversify(oneGenre);
    assertBlocks(out);
    expect(out.slice(0, FEED_BLOCK).filter((r) => r.genre === 'arena')).toHaveLength(2);
    expect(out).toHaveLength(oneGenre.length);
  });

  it('ends the feed rather than break the rule when one kind is all that is left', () => {
    const out = diversify(Array.from({ length: 8 }, (_, i) => row(i, 'chase_escape')));
    expect(out.map((r) => r.versionId)).toEqual(['v7', 'v6']);
  });

  it('honours the limit and the empty feed', () => {
    const rows = Array.from({ length: 30 }, (_, i) => row(i, ['a', 'b', 'c', 'd'][i % 4]!));
    expect(diversify(rows, 24)).toHaveLength(24);
    expect(diversify([], 24)).toEqual([]);
  });
});

describe('feedKindOf', () => {
  it('is the genre of the spec, or its control when the spec has no genre', () => {
    expect(feedKindOf({ archetype: 'collect_exit', control: 'lanes', genre: { id: 'catch', mode: 'default', compilerVersion: 'genre.v7' } })).toBe('catch');
    // Nativní sestava (plachtění, řízení, chodec) žánr do specu nepíše.
    expect(feedKindOf({ archetype: 'hazard_crossing', control: 'glide' })).toBe('glide');
    expect(feedKindOf({ archetype: 'delivery' })).toBe('delivery');
  });
});
