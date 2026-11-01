/**
 * Definice špatného žánru P68 (T2) na třech ručních větách. Podíl, který by počítal i ne-hry nebo bral `best` místo
 * `acceptable`, dá pěkné číslo a při zapojení her (T8–T12) pustí krádež vět mezi žánry.
 */

import { describe, expect, it } from 'vitest';

import { NEW_GENRES, isWrong, reachOf, routeStats } from '../genre-route.mjs';

/** Žánr rychlé hry je u první věty přijatelný, ale není `best`; u druhé mimo `acceptable`; třetí věta hru nemá. */
const ROWS = [
  { text: 'a monster truck jumps over ramps to the finish line', best: 'stunt', acceptable: ['stunt', 'voyage'], genre: 'voyage' },
  { text: 'a first-person ride on rails shooting bats in a mine', best: 'railfps', acceptable: ['railfps', 'shooter'], genre: 'runner' },
  { text: 'what is the capital of france', best: 'none', acceptable: [], genre: 'arena' },
] as const;

describe('P68 wrong genre', () => {
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

  it('measures the reach of the five P68 games, not the P66 ones', () => {
    expect(NEW_GENRES).toEqual(['stunt', 'minigolf', 'railfps', 'buildshift', 'drawsave']);
    expect(reachOf([...ROWS], 'railfps')).toEqual({ best: 1, acceptable: 1, share: 0.333, from: { runner: 1 } });
  });
});
