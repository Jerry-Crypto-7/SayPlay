/**
 * Výzva prvních sekund (P28C T5): nápověda ovládání zkrácená na jeden povel,
 * bez nového textu. Vstupy jsou nápovědy, které hry opravdu nesou (fixtury
 * a návrh ze slov).
 */

import { describe, expect, it } from 'vitest';

import { DUEL_ZONES, PLATFORM_ZONES, ZONE_HINTS, zoneAt } from '../arcade/touch-zones';
import { callToAction, desktopKeys, startLine, touchHint } from '../FirstPrompt';

describe('startLine (P70C T2)', () => {
  it('says tap on touch, click or Space on desktop only where Space is the first command', () => {
    expect(startLine(true, null)).toBe('Tap to start');
    expect(startLine(false, desktopKeys('Tap or Space to jump.'))).toBe('Click or press Space');
    // Klouzání Space nebere: karta ho neslíbí.
    expect(startLine(false, desktopKeys('Arrows or drag to steer.'))).toBe('Click to start');
    expect(startLine(false, 'or press the number on a card')).toBe('Click to start');
  });
});

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

// Řádka ovládání na dotyku (P33 T12, P36C T2): celá nápověda, jen bez kláves na kterékoli straně
// „or“; souvětí jen o klávesách vypadne. Dřív zůstávalo „Space or tap“ a „use A/D“ – na telefonu šum.
describe('touchHint', () => {
  it.each([
    ['Tap or Space to jump, swipe or arrows to change lane.', 'Tap to jump, swipe to change lane.'],
    ['Drag or use A/D to steer. Tap or Enter to boost.', 'Drag to steer. Tap to boost.'],
    ['Space or tap to flap.', 'Tap to flap.'],
    ['Tap a mushroom to walk to it.', 'Tap a mushroom to walk to it.'],
    ['Arrows or A/D to move, Space or tap to jump.', 'Tap to jump.'],
    ['Arrows or drag to tilt. Up, Space or a second finger fires the engine.', 'Drag to tilt. A second finger fires the engine.'],
    ['Drag or arrows to steer. Down or a second finger brakes.', 'Drag to steer. A second finger brakes.'],
    ['Drag or arrows to move, Attack or J to strike. Step aside when it winds up.', 'Drag to move, Attack to strike. Step aside when it winds up.'],
    ['Tap right or Space to strike, tap left or Down to dodge.', 'Tap right to strike, tap left to dodge.'],
    ['Drag or arrows to move, hold Use when it is ready.', 'Drag to move, hold Use when it is ready.'],
    ['Hold to power up, drag up or down to aim, let go to throw.', 'Hold to power up, drag up or down to aim, let go to throw.'],
    // P70C: věty registru, kde na telefonu zůstávaly klávesy (minigolf, rytmus, honička, chůze).
    ['Drag back from the ball and let go. Keys: arrows aim, hold Space.', 'Drag back from the ball and let go.'],
    ['Tap the lane, or D F J K, on the beat. M toggles sound.', 'Tap the lane on the beat.'],
    ['Move with arrows or WASD, or drag to chase.', 'Drag to chase.'],
    ['Drag in any direction, or use arrows or WASD to walk.', 'Drag in any direction to walk.'],
    ['Arrows or A/D to move, Space or tap to jump. F or Fire to shoot.', 'Tap to jump. Fire to shoot.'],
  ])('%s → %s', (hint, touch) => {
    expect(touchHint(hint)).toBe(touch);
  });
});

// Výzva na startu podle vstupu (P36C T2): na telefonu povel gesty, na desktopu jako dřív
// s klávesami. „Arrows to move“ se na telefonu neukáže – plošinovka dostane zóny (`ZONE_HINTS`).
describe('first prompt per input', () => {
  const GENRE_HINTS: readonly (readonly [control: string, hint: string, touch: string, keys: string])[] = [
    ['runner', 'Tap or Space to jump, swipe or arrows to change lane.', 'Tap to jump', 'Tap to jump'],
    ['platform', 'Arrows or A/D to move, Space or tap to jump.', 'Hold left to run', 'Arrows to move'],
    ['move_free', 'Drag or arrows to move.', 'Drag to move', 'Drag to move'],
    ['move_free', 'Drag or arrows to move, hold Use next to a target.', 'Drag to move', 'Drag to move'],
    ['steer', 'Arrows or drag to tilt. Up, Space or a second finger fires the engine.', 'Drag to tilt', 'Arrows to tilt'],
    ['steer', 'Drag or arrows to steer. Down or a second finger brakes.', 'Drag to steer', 'Drag to steer'],
    ['duel', 'Tap right or Space to strike, tap left or Down to dodge.', 'Tap right to strike', 'Tap right to strike'],
  ];

  it.each(GENRE_HINTS)('%s: %s', (control, hint, touch, keys) => {
    expect(callToAction(ZONE_HINTS[control] ?? touchHint(hint))).toBe(touch);
    expect(callToAction(hint)).toBe(keys);
  });

  it('no touch hint names a key', () => {
    for (const [control, hint] of GENRE_HINTS) {
      expect(ZONE_HINTS[control] ?? touchHint(hint)).not.toMatch(/\b(?:arrows|space|a\/d|enter|up,)\b/i);
    }
  });
});

describe('touch zones', () => {
  it('split the screen where the input hooks always did', () => {
    expect([0, 0.24, 0.25, 0.49, 0.5, 0.99, 1].map((at) => zoneAt(PLATFORM_ZONES, at))).toEqual([0, 0, 1, 1, 2, 2, 2]);
    expect([0, 0.49, 0.5, 1].map((at) => zoneAt(DUEL_ZONES, at))).toEqual([0, 0, 1, 1]);
  });
});
