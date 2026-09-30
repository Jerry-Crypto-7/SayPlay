/**
 * Výzva prvních sekund (P28C T5): nápověda ovládání zkrácená na jeden povel,
 * bez nového textu. Vstupy jsou nápovědy, které hry opravdu nesou (fixtury
 * a návrh ze slov).
 */

import { describe, expect, it } from 'vitest';

import { callToAction, touchHint } from '../FirstPrompt';

describe('callToAction', () => {
  it.each([
    ['Tap or Space to jump, swipe or arrows to change lane.', 'Tap to jump'],
    ['Drag or arrows to steer. Down or a second finger brakes.', 'Drag to steer'],
    ['Tap or Space to flap.', 'Tap to flap'],
    ['Arrows or A/D to move, Space or tap to jump.', 'Arrows to move'],
    ['Hold to power up, drag up or down to aim, let go to throw.', 'Hold to power up'],
    ['Tap right or Space to strike, tap left or Down to dodge.', 'Tap right to strike'],
    ['Tap or Space on the beat. M toggles sound.', 'Tap on the beat'],
    ['Tap a mushroom to walk to it. Tap again to pick it up.', 'Tap a mushroom'],
    ['Tap the next gate to race to it.', 'Tap the next gate'],
    ['Tap a stepping stone when the lava is calm.', 'Tap a stepping stone'],
    ['Tap the cake, pick it up, then tap the table.', 'Tap the cake'],
    ['Tap a dish to grab it, then tap the customer who ordered it.', 'Tap a dish'],
    ['Tap to walk. Stand still while the guard watches.', 'Tap to walk'],
    ['Tap where to run. Use a cart to stun the Roomba.', 'Tap where to run'],
  ])('%s → %s', (hint, expected) => {
    expect(callToAction(hint)).toBe(expected);
  });

  it('every word of the prompt is already in the hint', () => {
    const hint = 'Tap a vase to walk there, tap again to knock it off.';
    const words = new Set(hint.toLowerCase().split(/\W+/));
    for (const word of callToAction(hint).toLowerCase().split(/\W+/)) expect(words.has(word)).toBe(true);
  });

  it('an empty hint gives no prompt', () => {
    expect(callToAction('')).toBe('');
    expect(callToAction('   ')).toBe('');
  });
});

// Řádka ovládání na dotyku (P33 T12): celá nápověda, jen bez kláves; dotykové alternativy zůstávají.
describe('touchHint', () => {
  it.each([
    ['Tap or Space to jump, swipe or arrows to change lane.', 'Tap to jump, swipe to change lane.'],
    ['Drag or use A/D to steer. Tap or Enter to boost.', 'Drag or use A/D to steer. Tap to boost.'],
    ['Space or tap to flap.', 'Space or tap to flap.'],
    ['Tap a mushroom to walk to it.', 'Tap a mushroom to walk to it.'],
  ])('%s → %s', (hint, touch) => {
    expect(touchHint(hint)).toBe(touch);
  });
});
