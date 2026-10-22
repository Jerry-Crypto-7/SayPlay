import { describe, expect, it } from 'vitest';

import { DUEL_FLOOR, duelJudges, duelWins, isDuelAnswer, oldFirst, voteOf } from '../duel.mjs';

describe('duel old × new (P57 T8r)', () => {
  it('swaps only when the new model wins both judges and scores at least 6', () => {
    expect(DUEL_FLOOR).toBe(6);
    expect(duelWins(6, ['new', 'new'])).toBe(true);
    expect(duelWins(5, ['new', 'new'])).toBe(false);
    expect(duelWins(9, ['new', 'old'])).toBe(false);
    expect(duelWins(9, ['new', null])).toBe(false);
    expect(duelWins(9, ['new'])).toBe(false);
    expect(duelWins(9, [])).toBe(false);
    expect(duelWins(null, ['new', 'new'])).toBe(false);
  });

  it('reads the vote against the cell the old model sat in', () => {
    expect(voteOf({ better: 1, reason: 'x' }, 1)).toBe('old');
    expect(voteOf({ better: 2, reason: 'x' }, 1)).toBe('new');
    expect(voteOf({ better: 1, reason: 'x' }, 2)).toBe('new');
    expect(voteOf({ better: 3, reason: 'x' }, 1)).toBeNull();
    expect(voteOf(null, 1)).toBeNull();
    expect(isDuelAnswer({ better: 2 })).toBe(true);
    expect(isDuelAnswer({ better: '2' })).toBe(false);
  });

  it('uses Opus and Codex, and Opus twice with the order swapped once Codex is spent', () => {
    expect(duelJudges(true)).toEqual([{ judge: 'claude', swap: false }, { judge: 'codex', swap: false }]);
    expect(duelJudges(false)).toEqual([{ judge: 'claude', swap: false }, { judge: 'claude', swap: true }]);
  });

  it('draws the order from the seed: the same pair always gets the same order, both orders occur', () => {
    const orders = Array.from({ length: 40 }, (_, seed) => oldFirst(seed));
    expect(Array.from({ length: 40 }, (_, seed) => oldFirst(seed))).toEqual(orders);
    expect(new Set(orders)).toEqual(new Set([true, false]));
  });
});
