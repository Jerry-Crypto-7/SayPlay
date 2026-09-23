/**
 * Relace arkády (P25A T6): hodiny jen pohánějí tiky, záznam hráče přehraný
 * jádrem dá týž hash a robot ověřovače hru v prohlížeči dohraje.
 */

import { describe, expect, it } from 'vitest';

import flapFixture from '@/play/arcade/__fixtures__/flap.json';
import platformFixture from '@/play/arcade/__fixtures__/platform.json';
import fixture from '@/play/arcade/__fixtures__/runner.json';
import shooterFixture from '@/play/arcade/__fixtures__/shooter.json';
import throwFixture from '@/play/arcade/__fixtures__/throw.json';
import timingFixture from '@/play/arcade/__fixtures__/timing.json';
import { arcadeWorldOf } from '@/play/arcade/compile';
import { AXIS_MAX, BODY, BUTTON, HEADER, bodyBase } from '@/play/arcade/contract';
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

describe('arcade session – platform and flap (P25C)', () => {
  const worldOf = (raw: unknown) => {
    const spec = readGameSpec(raw);
    if (!spec.ok) throw new Error(spec.issues.join('; '));
    const built = arcadeWorldOf(spec.value, 1);
    if (!built.ok) throw new Error(built.issues.join('; '));
    return built.world;
  };

  it('a held axis lands in every tick it is held and replays to the same hash', () => {
    const platform = worldOf(platformFixture);
    const session = createArcadeSession(platform);
    session.hold(AXIS_MAX);
    session.advance(TICK_MS * 3);
    session.press(BUTTON.TAP);
    session.advance(TICK_MS);
    session.hold(0);
    session.advance(TICK_MS * 5);
    expect(session.inputs()).toEqual([
      { tick: 0, buttons: 0, axis: AXIS_MAX },
      { tick: 1, buttons: 0, axis: AXIS_MAX },
      { tick: 2, buttons: 0, axis: AXIS_MAX },
      { tick: 3, buttons: BUTTON.TAP, axis: AXIS_MAX },
    ]);
    expect(session.snapshot().tick).toBe(9);
    // Hráč je dál než nečinný – osa opravdu dojela do jádra.
    const idle = createArcadeSession(platform);
    idle.advance(TICK_MS * 9);
    const z = (s: typeof session): number => s.state()[bodyBase(s.state()[HEADER.player] as number) + BODY.z] as number;
    expect(z(session)).toBeGreaterThan(z(idle));
    expect(replay(platform, session.inputs(), ARCADE_LIBRARY, 9).hash).toBe(hashArcade(session.state()));
  });

  it('a flap session waits for the first tap, which lands on tick 0 and replays the same', () => {
    const flap = worldOf(flapFixture);
    const session = createArcadeSession(flap, { waitForInput: true });
    session.advance(1000);
    session.advance(1000);
    expect(session.snapshot()).toMatchObject({ tick: 0, runState: 'running' });
    session.press(BUTTON.TAP);
    session.advance(TICK_MS * 5);
    expect(session.inputs()).toEqual([{ tick: 0, buttons: BUTTON.TAP, axis: 0 }]);
    expect(replay(flap, session.inputs(), ARCADE_LIBRARY, 5).hash).toBe(hashArcade(session.state()));
    session.restart();
    session.advance(1000);
    expect(session.snapshot().tick).toBe(0);
  });

  it('a click carries its aim into the tick even when the pointer lifts before the tick lands', () => {
    const range = worldOf(shooterFixture);
    const session = createArcadeSession(range);
    session.hold(-600);
    session.press(BUTTON.TAP, -600);
    session.hold(0);
    session.advance(TICK_MS * 2);
    expect(session.inputs()).toEqual([{ tick: 0, buttons: BUTTON.TAP, axis: -600 }]);
    expect(session.state()[bodyBase(session.state()[HEADER.player] as number) + BODY.aux0]).toBe(-600);
  });

  it('held buttons charge a throw in every tick, the release throws once and replays the same', () => {
    const field = worldOf(throwFixture);
    const session = createArcadeSession(field);
    const shots = session.snapshot().shots;
    session.holdButtons(BUTTON.HOLD);
    session.hold(400);
    for (let t = 0; t < 20; t += 1) session.advance(TICK_MS);
    session.holdButtons(0);
    session.hold(0);
    session.press(BUTTON.TAP);
    session.advance(TICK_MS * 3);
    expect(session.inputs()).toHaveLength(21);
    expect(session.inputs()[19]).toEqual({ tick: 19, buttons: BUTTON.HOLD, axis: 400 });
    expect(session.inputs()[20]).toEqual({ tick: 20, buttons: BUTTON.TAP, axis: 0 });
    expect(session.snapshot().shots).toBe(shots - 1);
    expect(replay(field, session.inputs(), ARCADE_LIBRARY, 23).hash).toBe(hashArcade(session.state()));
    session.restart();
    session.advance(TICK_MS * 3);
    expect(session.inputs()).toEqual([]);
  });

  it('a timing session swallows the starting tap, so the game does not open on a miss', () => {
    const timing = worldOf(timingFixture);
    const session = createArcadeSession(timing, { waitForInput: true, swallowFirst: true });
    session.advance(1000);
    expect(session.snapshot().tick).toBe(0);
    session.press(BUTTON.TAP);
    session.advance(TICK_MS * 5);
    expect(session.snapshot()).toMatchObject({ tick: 5, runState: 'running' });
    expect(session.inputs()).toEqual([]);
    session.press(BUTTON.TAP);
    session.advance(TICK_MS);
    expect(session.inputs()).toEqual([{ tick: 5, buttons: BUTTON.TAP, axis: 0 }]);
  });

  it.each([
    ['platform', platformFixture],
    ['flap', flapFixture],
    ['shooter', shooterFixture],
    ['throw', throwFixture],
  ] as const)('the %s verifier bot wins in the browser session (axis included)', (_, fixture) => {
    const session = createArcadeSession(worldOf(fixture));
    expect(session.playInputs(session.botInputs(), 90 * 60).runState).toBe('won');
  });
});
