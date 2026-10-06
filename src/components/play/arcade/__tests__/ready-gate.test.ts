/**
 * Hra čeká na první dotek (P33 T11): bez vstupu hodiny stojí, první vstup
 * padne do tiku 0, restart znovu čeká a ukázka robota nečeká.
 */

import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { describe, expect, it, vi } from 'vitest';

import fixture from '@/play/arcade/__fixtures__/runner.json';
import { arcadeWorldOf } from '@/play/arcade/compile';
import { BUTTON } from '@/play/arcade/contract';
import { readGameSpec } from '@/play/spec';

import { FirstPrompt, controlLines, desktopKeys } from '../../FirstPrompt';
import { holdUntilTouch, wakesGame } from '../ready-gate';
import { TICK_MS, createArcadeSession } from '../session';

const world = (() => {
  const spec = readGameSpec(fixture);
  if (!spec.ok) throw new Error(spec.issues.join('; '));
  const built = arcadeWorldOf(spec.value, 1);
  if (!built.ok) throw new Error(built.issues.join('; '));
  return built.world;
})();

/** `seconds` simulovaného času po snímcích 60 Hz, jak ho posílá plátno. */
function wait(session: { advance(ms: number): number }, seconds: number): void {
  for (let ms = 0; ms < seconds * 1000; ms += TICK_MS) session.advance(TICK_MS);
}

describe('ready gate', () => {
  it('ten seconds without input leave the runner on tick 0, still running', () => {
    const session = holdUntilTouch(createArcadeSession(world));
    wait(session, 10);
    expect(session.snapshot().tick).toBe(0);
    expect(session.snapshot().runState).toBe('running');
    expect(session.inputs()).toEqual([]);
    expect(session.waiting()).toBe(true);
  });

  it('the first input lands on tick 0 and the clock runs from there', () => {
    const session = holdUntilTouch(createArcadeSession(world));
    wait(session, 2);
    session.begin();
    session.press(BUTTON.TAP);
    wait(session, 1);
    expect(session.inputs()[0]).toMatchObject({ tick: 0, buttons: BUTTON.TAP });
    expect(session.snapshot().tick).toBeGreaterThan(50);
  });

  it('a touch that maps to no input still starts the game', () => {
    const session = holdUntilTouch(createArcadeSession(world));
    session.begin();
    wait(session, 1);
    expect(session.snapshot().tick).toBeGreaterThan(50);
    expect(session.inputs()).toEqual([]);
  });

  it('Play again waits for the next touch', () => {
    const session = holdUntilTouch(createArcadeSession(world));
    session.begin();
    wait(session, 1);
    session.restart();
    wait(session, 10);
    expect(session.snapshot().tick).toBe(0);
    expect(session.waiting()).toBe(true);
  });

  it('the robot demo plays without a touch', () => {
    const session = holdUntilTouch(createArcadeSession(world));
    session.startDemo();
    wait(session, 1);
    expect(session.snapshot().tick).toBeGreaterThan(50);
  });

  it('only a real key wakes the game, never Tab, Escape, a modifier or typing', () => {
    // Node nemá DOM: `isTyping` pozná pole formuláře podle `HTMLElement` a `closest`.
    class Element {
      readonly isContentEditable = false;
      constructor(private readonly field: boolean) {}
      closest(): object | null {
        return this.field ? {} : null;
      }
    }
    vi.stubGlobal('HTMLElement', Element);
    const key = (value: string, extra: Partial<Parameters<typeof wakesGame>[0]> = {}) =>
      wakesGame({ key: value, repeat: false, altKey: false, ctrlKey: false, metaKey: false, target: new Element(false) as unknown as EventTarget, ...extra });
    expect(key('a', { target: new Element(true) as unknown as EventTarget })).toBe(false);
    expect(key(' ')).toBe(true);
    expect(key('ArrowLeft')).toBe(true);
    expect(key('Tab')).toBe(false);
    expect(key('Escape')).toBe(false);
    expect(key('Shift')).toBe(false);
    expect(key('c', { ctrlKey: true })).toBe(false);
    expect(key(' ', { repeat: true })).toBe(false);
    vi.unstubAllGlobals();
  });
});

describe('ready prompt', () => {
  it('says tap to start, the one command and the desktop key', () => {
    const html = renderToStaticMarkup(createElement(FirstPrompt, { controlsHint: 'Tap or Space to jump, swipe or arrows to change lane.' }));
    expect(html).toContain('Tap to start');
    expect(html).toContain('Tap to jump');
    expect(html).toContain('Space');
  });

  // P39 T10: plošinovka se střelbou ukáže skok i střelbu, ne jen „Arrows to move“.
  it('lists every control of the hint under the first command', () => {
    const platformShoot = 'Arrows or A/D to move, Space or tap to jump. F or Fire to shoot.';
    expect(controlLines(platformShoot)).toEqual(['Space to jump', 'F to shoot']);
    const html = renderToStaticMarkup(createElement(FirstPrompt, { controlsHint: platformShoot }));
    expect(html).toContain('Arrows to move');
    expect(html).toContain('Space to jump');
    expect(html).toContain('F to shoot');
    // Rada, která nic neovládá, na kartu nepatří; směr tahu „up or down“ zůstane celý.
    expect(controlLines('Drag or arrows to move, Attack or J to strike. Step aside when it winds up.')).toEqual(['Attack or J to strike']);
    expect(controlLines('Hold to power up, drag up or down to aim, let go to throw.')).toEqual(['Drag up or down to aim', 'Let go to throw']);
    expect(controlLines('Tap the lane, or D F J K, on the beat. M toggles sound.')).toEqual([]);
    // Prst: zóny plošinovky říkají běh a skok, střelbu doplní nápověda hry bez klávesy.
    expect(controlLines('Hold left to run, tap right to jump.', platformShoot)).toEqual(['Tap right to jump', 'Fire to shoot']);
  });

  it('names the key the hint offers next to touch', () => {
    expect(desktopKeys('Tap or Space to jump, swipe or arrows to change lane.')).toBe('or press Space');
    expect(desktopKeys('Drag or arrows to steer. Down or a second finger brakes.')).toBe('or use the arrow keys');
    expect(desktopKeys('Tap right or Space to strike, tap left or Down to dodge.')).toBe('or press Space');
    expect(desktopKeys('Tap an egg to walk to it. Tap again to pick it up.')).toBeNull();
  });
});
