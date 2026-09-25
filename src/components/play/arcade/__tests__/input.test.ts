/**
 * Dotyk běžce (P28B T4): skok padne v tiku stisku, ne až po puštění; tah do
 * strany pak změní pruh, tah dolů je skluz a zrušený dotyk nic nedokončí.
 */

import { describe, expect, it } from 'vitest';

import fixture from '@/play/arcade/__fixtures__/runner.json';
import { arcadeWorldOf } from '@/play/arcade/compile';
import { BUTTON } from '@/play/arcade/contract';
import { readGameSpec } from '@/play/spec';

import { runnerGesture } from '../input';
import { TICK_MS, createArcadeSession } from '../session';

const world = (() => {
  const spec = readGameSpec(fixture);
  if (!spec.ok) throw new Error(spec.issues.join('; '));
  const built = arcadeWorldOf(spec.value, 1);
  if (!built.ok) throw new Error(built.issues.join('; '));
  return built.world;
})();

const at = (clientX: number, clientY: number) => ({ clientX, clientY });

describe('runner touch gesture', () => {
  it('jumps in the tick the finger lands, before it lifts', () => {
    const session = createArcadeSession(world);
    const gesture = runnerGesture(session);
    gesture.down(at(100, 100));
    session.advance(TICK_MS);
    expect(session.inputs()).toEqual([{ tick: 0, buttons: BUTTON.TAP, axis: 0 }]);
    gesture.end();
    session.advance(TICK_MS);
    expect(session.inputs()).toHaveLength(1);
  });

  it('a sideways drag changes lane once; a drag down slides', () => {
    const session = createArcadeSession(world);
    const gesture = runnerGesture(session);
    gesture.down(at(100, 100));
    session.advance(TICK_MS);
    gesture.move(at(80, 102));
    gesture.move(at(60, 104));
    session.advance(TICK_MS);
    gesture.move(at(20, 104));
    session.advance(TICK_MS);
    gesture.end();
    gesture.down(at(100, 100));
    gesture.move(at(102, 150));
    session.advance(TICK_MS);
    expect(session.inputs()).toEqual([
      { tick: 0, buttons: BUTTON.TAP, axis: 0 },
      { tick: 1, buttons: BUTTON.LEFT, axis: 0 },
      { tick: 3, buttons: BUTTON.TAP | BUTTON.DOWN, axis: 0 },
    ]);
  });

  it('a cancelled touch ends the gesture', () => {
    const session = createArcadeSession(world);
    const gesture = runnerGesture(session);
    gesture.down(at(100, 100));
    gesture.end();
    gesture.move(at(200, 100));
    session.advance(TICK_MS);
    expect(session.inputs()).toEqual([{ tick: 0, buttons: BUTTON.TAP, axis: 0 }]);
  });
});
