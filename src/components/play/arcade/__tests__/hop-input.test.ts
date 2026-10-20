/**
 * Vstup přeskákání (P54C T9): krátký dotek je ťuk (skok vpřed), tah od `SWIPE_PX` je skok tím směrem –
 * doprava na plátně je `RIGHT` (sloupec +1, scéna zrcadlí x jádra), nahoru vpřed, dolů zpět. Klávesy totéž.
 */

import { describe, expect, it } from 'vitest';

import { BUTTON } from '@/play/arcade/contract';

import { SWIPE_PX, keyButton, swipeButton } from '../genres/hop/hop-input';

describe('hop input', () => {
  it('a short touch is a tap, a swipe hops its way by the larger axis', () => {
    expect(swipeButton(0, 0)).toBe(0);
    expect(swipeButton(SWIPE_PX - 1, 0)).toBe(0);
    expect(swipeButton(SWIPE_PX, 0)).toBe(BUTTON.RIGHT);
    expect(swipeButton(-40, 10)).toBe(BUTTON.LEFT);
    expect(swipeButton(10, -40)).toBe(BUTTON.UP);
    expect(swipeButton(-10, 40)).toBe(BUTTON.DOWN);
  });

  it('arrows and WASD hop their way, space hops forward, other keys are not the game’s', () => {
    expect(['ArrowUp', 'w', 'W'].map(keyButton)).toEqual([BUTTON.UP, BUTTON.UP, BUTTON.UP]);
    expect(['ArrowDown', 's'].map(keyButton)).toEqual([BUTTON.DOWN, BUTTON.DOWN]);
    expect(['ArrowLeft', 'a'].map(keyButton)).toEqual([BUTTON.LEFT, BUTTON.LEFT]);
    expect(['ArrowRight', 'd'].map(keyButton)).toEqual([BUTTON.RIGHT, BUTTON.RIGHT]);
    expect(keyButton(' ')).toBe(BUTTON.TAP);
    expect(['Enter', 'q', 'Tab'].map(keyButton)).toEqual([0, 0, 0]);
  });
});
