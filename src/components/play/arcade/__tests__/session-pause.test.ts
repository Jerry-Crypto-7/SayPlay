/**
 * Pauza arkády (P27B T3): v pauze hodiny stojí a vstupy se zahodí, takže
 * záznam s pauzami uprostřed je týž jako bez nich a přehraje se na týž hash.
 */

import { describe, expect, it } from 'vitest';

import platformFixture from '@/play/arcade/__fixtures__/platform.json';
import rhythmFixture from '@/play/arcade/__fixtures__/rhythm.json';
import runnerFixture from '@/play/arcade/__fixtures__/runner.json';
import { arcadeWorldOf } from '@/play/arcade/compile';
import { AXIS_MAX, type ArcadeWorld, BUTTON } from '@/play/arcade/contract';
import { hashArcade } from '@/play/arcade/kernel';
import { readGameSpec } from '@/play/spec';

import { type ArcadeSession, TICK_MS, createArcadeSession } from '../session';

const worldOf = (raw: unknown): ArcadeWorld => {
  const spec = readGameSpec(raw);
  if (!spec.ok) throw new Error(spec.issues.join('; '));
  const built = arcadeWorldOf(spec.value, 1);
  if (!built.ok) throw new Error(built.issues.join('; '));
  return built.world;
};

// Týž scénář s pauzami i bez; `pause` vloží pauzu, ve které hráč mačká a hodiny běží.
type Step = { readonly frames: number } | { readonly press: number } | { readonly hold: number } | 'pause';

const SCRIPT: readonly Step[] = [
  { press: BUTTON.TAP },
  { frames: 12 },
  { hold: AXIS_MAX },
  { frames: 6 },
  { hold: 0 },
  'pause',
  { frames: 20 },
  { press: BUTTON.TAP },
  { frames: 3 },
  'pause',
  { press: BUTTON.LEFT },
  { frames: 17 },
  { press: BUTTON.RIGHT },
  { frames: 8 },
];

function run(session: ArcadeSession, withPauses: boolean): void {
  for (const step of SCRIPT) {
    if (step === 'pause') {
      if (!withPauses) continue;
      session.pause();
      // Co přijde v pauze, nesmí do hry ani do záznamu.
      session.press(BUTTON.TAP | BUTTON.LEFT, AXIS_MAX);
      session.hold(-AXIS_MAX);
      session.holdButtons(BUTTON.HOLD);
      for (let frame = 0; frame < 30; frame += 1) session.advance(TICK_MS);
      session.advance(5_000);
      session.resume();
    } else if ('frames' in step) for (let frame = 0; frame < step.frames; frame += 1) session.advance(TICK_MS);
    else if ('press' in step) session.press(step.press);
    else session.hold(step.hold);
  }
}

describe('arcade session pause (P27B T3)', () => {
  it.each([
    ['runner', runnerFixture, {}],
    ['platform', platformFixture, {}],
    ['rhythm', rhythmFixture, { waitForInput: true, swallowFirst: true }],
  ] as const)('a %s run paused twice records and replays exactly like one never paused', (_, fixture, options) => {
    const world = worldOf(fixture);
    const plain = createArcadeSession(world, options);
    const paused = createArcadeSession(world, options);
    run(plain, false);
    run(paused, true);
    expect(paused.snapshot().tick).toBeGreaterThan(0);
    expect(paused.snapshot().tick).toBe(plain.snapshot().tick);
    expect(paused.inputs()).toEqual(plain.inputs());
    expect(hashArcade(paused.state())).toBe(hashArcade(plain.state()));
    const replayed = createArcadeSession(world, options);
    replayed.playInputs(paused.inputs(), paused.snapshot().tick);
    expect(hashArcade(replayed.state())).toBe(hashArcade(paused.state()));
  });

  it('stops the clock, drops a press waiting for its tick and releases held input', () => {
    const session = createArcadeSession(worldOf(platformFixture));
    session.advance(TICK_MS * 4);
    session.hold(AXIS_MAX);
    session.holdButtons(BUTTON.HOLD);
    session.press(BUTTON.TAP);
    session.pause();
    expect(session.paused()).toBe(true);
    session.advance(TICK_MS * 10);
    expect(session.snapshot().tick).toBe(4);
    session.resume();
    expect(session.paused()).toBe(false);
    session.advance(TICK_MS * 3);
    expect(session.snapshot().tick).toBe(7);
    expect(session.inputs()).toEqual([]);
  });

  it('a restart leaves the pause as it was, so a hidden game does not start by itself', () => {
    const session = createArcadeSession(worldOf(runnerFixture));
    session.pause();
    session.restart();
    session.advance(TICK_MS * 5);
    expect(session.snapshot().tick).toBe(0);
  });
});
