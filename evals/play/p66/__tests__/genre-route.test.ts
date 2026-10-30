/**
 * Definice špatného žánru P66 (T1) na třech ručních větách. Podíl, který by počítal i ne-hry nebo bral `best` místo
 * `acceptable`, dá pěkné číslo a v T12 pustí krádež vět mezi žánry.
 */

import { describe, expect, it } from 'vitest';

import { isWrong, reachOf, routeStats } from '../genre-route.mjs';

/** Žánr rychlé hry (`genre`) je u první věty přijatelný, ale není `best`; u druhé mimo; třetí věta hru nemá. */
const ROWS = [
  { text: 'a frog dodges cars on a busy road', best: 'hop', acceptable: ['hop', 'runner'], genre: 'runner' },
  { text: 'a black hole swallows the cars of a busy city', best: 'hole', acceptable: ['hole', 'arena'], genre: 'shooter' },
  { text: 'explain how volcanoes erupt to a ten year old', best: 'none', acceptable: [], genre: 'arena' },
] as const;

describe('P66 wrong genre', () => {
  it('counts a quick-game genre in acceptable as right even when it is not best', () => {
    expect(isWrong(ROWS[0])).toBe(false);
  });

  it('counts a quick-game genre outside acceptable as wrong', () => {
    expect(isWrong(ROWS[1])).toBe(true);
  });

  it('does not count a sentence without a game, neither as wrong nor in the denominator', () => {
    expect(isWrong(ROWS[2])).toBe(false);
    expect(routeStats([...ROWS])).toEqual({ sentences: 3, none: 1, counted: 2, wrong: 1, wrongRate: 0.5 });
  });

  it('reach of a new genre counts best and acceptable and names the genre the sentence plays today', () => {
    expect(reachOf([...ROWS], 'hole')).toEqual({ best: 1, acceptable: 1, share: 0.333, from: { shooter: 1 } });
  });
});
