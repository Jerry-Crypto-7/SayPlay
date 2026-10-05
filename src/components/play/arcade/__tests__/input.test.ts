/**
 * Dotyk běžce (P36C T1): skok je ťuk (puštění do `TAP_MS` bez tahu) nebo tah
 * nahoru; tah do strany je jen pruh, tah dolů jen skluz – ani jeden neskočí.
 * Zrušený dotyk (`pointercancel`) nic nedokončí.
 */

import { describe, expect, it } from 'vitest';

import fixture from '@/play/arcade/__fixtures__/runner.json';
import { arcadeWorldOf } from '@/play/arcade/compile';
import { BUTTON } from '@/play/arcade/contract';
import { readGameSpec } from '@/play/spec';

import { touchHint } from '../../FirstPrompt';
import { SWIPE_PX, TAP_MS, runnerGesture } from '../input';
import { TICK_MS, createArcadeSession } from '../session';

const world = (() => {
  const spec = readGameSpec(fixture);
  if (!spec.ok) throw new Error(spec.issues.join('; '));
  const built = arcadeWorldOf(spec.value, 1);
  if (!built.ok) throw new Error(built.issues.join('; '));
  return built.world;
})();

const at = (clientX: number, clientY: number, timeStamp = 0) => ({ clientX, clientY, timeStamp });

describe('runner touch gesture', () => {
  it('a tap jumps when the finger lifts, not when it lands', () => {
    const session = createArcadeSession(world);
    const gesture = runnerGesture(session);
    gesture.down(at(100, 100, 0));
    session.advance(TICK_MS);
    expect(session.inputs()).toEqual([]);
    gesture.up(at(102, 101, 80));
    session.advance(TICK_MS);
    expect(session.inputs()).toEqual([{ tick: 1, buttons: BUTTON.TAP, axis: 0 }]);
  });

  it('a sideways drag changes lane once and never jumps', () => {
    const session = createArcadeSession(world);
    const gesture = runnerGesture(session);
    gesture.down(at(100, 100, 0));
    session.advance(TICK_MS);
    gesture.move(at(80, 102, 16));
    gesture.move(at(60, 104, 32));
    session.advance(TICK_MS);
    gesture.move(at(20, 104, 48));
    gesture.up(at(10, 104, 60));
    session.advance(TICK_MS);
    expect(session.inputs()).toEqual([{ tick: 1, buttons: BUTTON.LEFT, axis: 0 }]);
  });

  it('a drag down slides without jumping', () => {
    const session = createArcadeSession(world);
    const gesture = runnerGesture(session);
    gesture.down(at(100, 100, 0));
    gesture.move(at(102, 150, 30));
    gesture.up(at(102, 160, 50));
    session.advance(TICK_MS);
    expect(session.inputs()).toEqual([{ tick: 0, buttons: BUTTON.DOWN, axis: 0 }]);
  });

  it('a drag up jumps as soon as it crosses the threshold, before the finger lifts', () => {
    const session = createArcadeSession(world);
    const gesture = runnerGesture(session);
    gesture.down(at(100, 100, 0));
    gesture.move(at(101, 100 - SWIPE_PX - 1, 24));
    session.advance(TICK_MS);
    gesture.up(at(101, 40, 60));
    session.advance(TICK_MS);
    expect(session.inputs()).toEqual([{ tick: 0, buttons: BUTTON.TAP, axis: 0 }]);
  });

  it('a long press that never moved is not a tap', () => {
    const session = createArcadeSession(world);
    const gesture = runnerGesture(session);
    gesture.down(at(100, 100, 0));
    gesture.up(at(100, 100, TAP_MS + 1));
    session.advance(TICK_MS);
    expect(session.inputs()).toEqual([]);
  });

  it('a cancelled touch ends the gesture without a jump', () => {
    const session = createArcadeSession(world);
    const gesture = runnerGesture(session);
    gesture.down(at(100, 100, 0));
    gesture.cancel();
    gesture.move(at(200, 100, 20));
    gesture.up(at(200, 100, 40));
    session.advance(TICK_MS);
    expect(session.inputs()).toEqual([]);
  });

  it('the runner touch hint says what the gestures do', () => {
    expect(touchHint(fixture.tutorial.controlsHint)).toBe('Tap to jump, swipe to change lane.');
  });
});
