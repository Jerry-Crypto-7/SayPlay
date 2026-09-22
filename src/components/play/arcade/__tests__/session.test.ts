/**
 * Relace arkády (P25A T6): hodiny jen pohánějí tiky, záznam hráče přehraný
 * jádrem dá týž hash a robot ověřovače hru v prohlížeči dohraje.
 */

import { describe, expect, it } from 'vitest';

import fixture from '@/play/arcade/__fixtures__/runner.json';
import { arcadeWorldOf } from '@/play/arcade/compile';
import { BUTTON } from '@/play/arcade/contract';
import { hashArcade, replay } from '@/play/arcade/kernel';
import { ARCADE_LIBRARY } from '@/play/arcade/library';
import { readGameSpec } from '@/play/spec';

import { TICK_MS, createArcadeSession } from '../session';

const world = (() => {
  const spec = readGameSpec(fixture);
  if (!spec.ok) throw new Error(spec.issues.join('; '));
  const built = arcadeWorldOf(spec.value, 1);
  if (!built.ok) throw new Error(built.issues.join('; '));
  return built.world;
})();

describe('arcade session', () => {
  it('turns wall-clock time into whole ticks and drops a stalled frame', () => {
    const session = createArcadeSession(world);
    expect(session.advance(TICK_MS * 2.5)).toBeCloseTo(0.5, 5);
    expect(session.snapshot().tick).toBe(2);
    session.advance(10_000);
    expect(session.snapshot().tick).toBe(2 + Math.floor((250 + TICK_MS * 0.5) / TICK_MS));
  });

  it('records inputs on the tick they land and the kernel replays them to the same hash', () => {
    const session = createArcadeSession(world);
    const frames = (count: number): void => {
      for (let frame = 0; frame < count; frame += 1) session.advance(TICK_MS);
    };
    frames(30);
    session.press(BUTTON.TAP);
    frames(40);
    session.press(BUTTON.LEFT);
    frames(20);
    expect(session.inputs()).toEqual([
      { tick: 30, buttons: BUTTON.TAP, axis: 0 },
      { tick: 70, buttons: BUTTON.LEFT, axis: 0 },
    ]);
    const tick = session.snapshot().tick;
    expect(replay(world, session.inputs(), ARCADE_LIBRARY, tick).hash).toBe(hashArcade(session.state()));
  });

  it('plays the verifier bot to a win and restarts clean', () => {
    const session = createArcadeSession(world);
    const end = session.playInputs(session.botInputs(), 90 * 60);
    expect(end.runState).toBe('won');
    expect(end.progress).toBe(100);
    session.restart();
    expect(session.snapshot()).toMatchObject({ tick: 0, runState: 'running', progress: 0 });
    expect(session.inputs()).toEqual([]);
  });
});
