/**
 * Který vygenerovaný model jde do katalogu pod slovem z věty (P58A T7). Pěkný křeček pod štítkem
 * „gopher“ by vypadal jako hotová práce, a soudce by sysla ve hře stejně neuviděl.
 */

import { describe, expect, it } from 'vitest';

import { idOf, named, PASS, winnerOf } from '../gen-models.mjs';

describe('gen-models', () => {
  it('counts a model only when the blind judge calls it one of the accepted names, as a whole word', () => {
    expect(named('Gopher', ['gopher'])).toBe(true);
    expect(named('pine cone', ['pinecone', 'pine cone'])).toBe(true);
    expect(named('hamster', ['gopher'])).toBe(false);
    expect(named('bunny', ['bun', 'roll'])).toBe(false);
    expect(named(null, ['gopher'])).toBe(false);
  });

  it('picks the best-scored named attempt at or above the pass mark', () => {
    expect(PASS).toBe(7);
    const attempts = [
      { round: 1, score: 9, name: 'hamster' },
      { round: 1, score: 6, name: 'gopher' },
      { round: 2, score: 7, name: 'gopher' },
      { round: 2, score: 8, name: 'brown gopher' },
    ];
    expect(winnerOf(attempts, ['gopher'])).toEqual({ round: 2, score: 8, name: 'brown gopher' });
    expect(winnerOf(attempts.slice(0, 2), ['gopher'])).toBeNull();
    expect(winnerOf([{ score: null, name: 'gopher' }], ['gopher'])).toBeNull();
  });

  it('names the catalog id after the noun', () => {
    expect(idOf('expense report')).toBe('gen3d-expense-report');
  });
});
