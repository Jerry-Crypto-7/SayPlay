/**
 * Rejd kláves (P36C T3): šipka vytočí řízení za ~0,25 s, ne naráz, a puštění
 * ho stejně vrátí. Do záznamu jde plynulá osa jako u tahu prstem, takže
 * přehrání záznamu dá týž běh.
 */

import { describe, expect, it } from 'vitest';

import steerFixture from '@/play/arcade/__fixtures__/steer.json';
import { arcadeWorldOf } from '@/play/arcade/compile';
import { ARCADE_HZ, AXIS_MAX, type ArcadeWorld } from '@/play/arcade/contract';
import { hashArcade, replay } from '@/play/arcade/kernel';
import { ARCADE_LIBRARY } from '@/play/arcade/library';
import { readGameSpec } from '@/play/spec';

import { TICK_MS, createArcadeSession } from '../../session';
import { KEY_RAMP_PER_TICK, keySteer, rampToward } from '../key-steer';

const world = ((): ArcadeWorld => {
  const spec = readGameSpec(steerFixture);
  if (!spec.ok) throw new Error(spec.issues.join('; '));
  const built = arcadeWorldOf(spec.value, 1);
  if (!built.ok) throw new Error(built.issues.join('; '));
  return built.world;
})();

/** Relace závodu s rejdem kláves zapojeným jako v `useSteerInput`. */
function steered() {
  const session = createArcadeSession(world);
  const keys = keySteer(session, () => session.hold(keys.axis()));
  return { session, keys };
}

const axes = (session: ReturnType<typeof createArcadeSession>): number[] => session.inputs().map((event) => event.axis);

describe('key steering ramp', () => {
  it('a step moves toward the target and never past it', () => {
    expect(rampToward(0, AXIS_MAX, 1)).toBe(KEY_RAMP_PER_TICK);
    expect(rampToward(0, -AXIS_MAX, 2)).toBe(-2 * KEY_RAMP_PER_TICK);
    expect(rampToward(AXIS_MAX - 10, AXIS_MAX, 1)).toBe(AXIS_MAX);
    expect(rampToward(KEY_RAMP_PER_TICK - 5, 0, 1)).toBe(0);
    expect(rampToward(300, 300, 4)).toBe(300);
  });

  it('a held arrow reaches full lock in about a quarter second, one step a tick', () => {
    const { session, keys } = steered();
    keys.aim(AXIS_MAX);
    for (let t = 0; t < 30; t += 1) session.advance(TICK_MS);
    const recorded = axes(session);
    expect(recorded[0]).toBe(KEY_RAMP_PER_TICK);
    expect(recorded[1]).toBe(2 * KEY_RAMP_PER_TICK);
    const full = recorded.indexOf(AXIS_MAX);
    // ~0,25 s = 15 tiků při 60 Hz; ne naráz (tik 0) a ne líně (přes 0,3 s).
    expect(full).toBeGreaterThanOrEqual(Math.round(ARCADE_HZ * 0.2));
    expect(full).toBeLessThanOrEqual(Math.round(ARCADE_HZ * 0.3));
    for (let i = 1; i <= full; i += 1) expect(recorded[i]! - recorded[i - 1]!).toBeGreaterThan(0);
  });

  it('letting go returns the wheel gradually, and the ramp is the same at 30 fps', () => {
    const { session, keys } = steered();
    keys.aim(-AXIS_MAX);
    for (let t = 0; t < 30; t += 1) session.advance(TICK_MS);
    keys.aim(0);
    for (let t = 0; t < 30; t += 1) session.advance(TICK_MS);
    const back = axes(session).slice(30);
    expect(back[0]).toBe(-AXIS_MAX + KEY_RAMP_PER_TICK);
    expect(back.length).toBeGreaterThan(10);
    expect(back.every((axis) => axis < 0)).toBe(true);

    const slow = steered();
    slow.keys.aim(AXIS_MAX);
    for (let t = 0; t < 15; t += 1) slow.session.advance(TICK_MS * 2);
    const at30 = axes(slow.session);
    // Dva tiky na snímek: osa drží snímek a skočí o dva kroky – na plný dojede stejně rychle.
    expect(at30.indexOf(AXIS_MAX)).toBeLessThanOrEqual(Math.round(ARCADE_HZ * 0.3));
  });

  it('a restart starts the wheel from the middle again', () => {
    const { session, keys } = steered();
    keys.aim(AXIS_MAX);
    for (let t = 0; t < 20; t += 1) session.advance(TICK_MS);
    session.restart();
    expect(keys.axis()).toBe(0);
  });

  it('the recorded ramp replays to the same hash', () => {
    const { session, keys } = steered();
    keys.aim(AXIS_MAX);
    for (let t = 0; t < 40; t += 1) session.advance(TICK_MS);
    keys.aim(-AXIS_MAX);
    for (let t = 0; t < 40; t += 1) session.advance(TICK_MS);
    const ticks = session.snapshot().tick;
    expect(replay(world, session.inputs(), ARCADE_LIBRARY, ticks).hash).toBe(hashArcade(session.state()));
  });
});
