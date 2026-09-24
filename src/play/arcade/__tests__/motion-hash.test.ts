import { describe, expect, it } from 'vitest';

import { readGameSpec } from '@/play/spec';

import arenaFixture from '../__fixtures__/arena.json';
import duelFixture from '../__fixtures__/duel.json';
import flapFixture from '../__fixtures__/flap.json';
import platformFixture from '../__fixtures__/platform.json';
import rhythmFixture from '../__fixtures__/rhythm.json';
import runnerFixture from '../__fixtures__/runner.json';
import shooterFixture from '../__fixtures__/shooter.json';
import steerFixture from '../__fixtures__/steer.json';
import throwFixture from '../__fixtures__/throw.json';
import timingFixture from '../__fixtures__/timing.json';
import { arcadeWorldOf } from '../compile';
import { ARCADE_LIMITS, type ArcadeWorld, HEADER, NO_INPUT } from '../contract';
import { hashArcade, instantiate, loadProgram, outcomeOf, replay, step } from '../kernel';
import { ARCADE_LIBRARY } from '../library';
import { type Pose, posesOf } from '../motion';
import { runBot } from '../verify';

const FIXTURES = { arena: arenaFixture, duel: duelFixture, flap: flapFixture, platform: platformFixture, rhythm: rhythmFixture, runner: runnerFixture, shooter: shooterFixture, steer: steerFixture, throw: throwFixture, timing: timingFixture };

const DRAWN_BY_WORLD = new Set(['runner', 'platform', 'flap', 'steer', 'shooter', 'throw']);

function worldOf(raw: unknown): ArcadeWorld {
  const spec = readGameSpec(raw);
  if (!spec.ok) throw new Error(spec.issues.join('; '));
  const made = arcadeWorldOf(spec.value, 1);
  if (!made.ok) throw new Error(made.issues.join('; '));
  return made.world;
}

describe('pohyb modelů nesahá na stav hry (P26B T2)', () => {
  it.each(Object.entries(FIXTURES))('%s: robotův záznam s pózou v každém tiku dá týž hash i svědka', (_, fixture) => {
    const world = worldOf(fixture);
    const bot = runBot(world);
    const program = loadProgram(world, ARCADE_LIBRARY);
    const state = instantiate(world);
    const prev = state.slice();
    const memory: (Pose | null)[] = [];
    const byTick = new Map(bot.inputs.map((event) => [event.tick, event]));
    let moved = 0;
    for (let tick = 0; tick < ARCADE_LIMITS.maxTicks && outcomeOf(state) === 'running'; tick += 1) {
      prev.set(state);
      step(state, byTick.get(tick) ?? NO_INPUT, program);
      const before = state.slice();
      // Scéna volá pózu víckrát za tik (snímky mezi tiky) – tady taky.
      for (const alpha of [0, 0.5]) posesOf(state, prev, memory, tick + alpha);
      if (state.some((value, slot) => value !== before[slot])) throw new Error(`pose wrote into the state at tick ${tick}`);
      if (memory.some((pose) => pose !== null && (pose.bob !== 0 || pose.squash !== 0 || pose.lean !== 0))) moved += 1;
    }
    expect(state[HEADER.tick]).toBe(bot.tick);
    expect(hashArcade(state)).toBe(bot.hash);
    expect(replay(world, bot.inputs, ARCADE_LIBRARY).hash).toBe(bot.hash);
    // Test hlídá skutečný pohyb, ne prázdnou vrstvu – u scén, které kreslí těla přes `World` (souboj, načasování a rytmus mají vlastní).
    if (DRAWN_BY_WORLD.has(world.control.id)) expect(moved).toBeGreaterThan(0);
  });
});
