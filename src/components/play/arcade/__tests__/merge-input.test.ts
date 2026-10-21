/**
 * Vstup slučování (P54C T11): pust prstu míří jen tam, kam dávkovač dojede, a pust klávesou padne, jakmile je
 * předmět připravený, ať dávkovač mezitím jede kamkoli. Jinak pust visí a předmět časem spadne sám jako kámen.
 */

import { describe, expect, it } from 'vitest';

import { dropNow, spotOf } from '../genres/merge/merge-input';

const EDGES = [0.2, 0.8] as const;
const REACH = 300;

describe('merge input', () => {
  it('a finger inside the reach maps linearly, one past the edges aims at the edge', () => {
    expect(spotOf(0.5, EDGES, REACH)).toBe(0);
    expect(spotOf(0.2, EDGES, REACH)).toBe(-REACH);
    expect(spotOf(0.8, EDGES, REACH)).toBe(REACH);
    expect(spotOf(0.05, EDGES, REACH)).toBe(-REACH);
    expect(spotOf(1, EDGES, REACH)).toBe(REACH);
  });

  it('a finger drop past the edge fires once the dropper reaches the edge', () => {
    const pending = spotOf(0.98, EDGES, REACH);
    expect(dropNow(pending, REACH, 0)).toBe(true);
  });

  it('a finger drop waits for the reload and for the dropper to be over its spot', () => {
    expect(dropNow(100, 100, 3)).toBe(false);
    expect(dropNow(100, 0, 0)).toBe(false);
    expect(dropNow(100, 85, 0)).toBe(true);
  });

  it('a key drop fires wherever the dropper is once the item is ready', () => {
    expect(dropNow('here', -250, 2)).toBe(false);
    expect(dropNow('here', -250, 0)).toBe(true);
    expect(dropNow('here', 250, 0)).toBe(true);
  });

  it('nothing pending never drops', () => {
    expect(dropNow(null, 0, 0)).toBe(false);
  });
});
