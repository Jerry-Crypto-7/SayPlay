/**
 * Robot „za ruku“ (P36C T4): když ruka stiskne přesně, co robot chce, běh je
 * týž jako `runBot` (stejný hash); když jen přibližně jako prst (plošinovka
 * zná jen plný běh), robot to dorovná a hru dohraje.
 */

import { describe, expect, it } from 'vitest';

import platformFixture from '@/play/arcade/__fixtures__/platform.json';
import runnerFixture from '@/play/arcade/__fixtures__/runner.json';
import { arcadeWorldOf } from '@/play/arcade/compile';
import { AXIS_MAX, type ArcadeInput, type ArcadeWorld } from '@/play/arcade/contract';
import { hashArcade } from '@/play/arcade/kernel';
import { runBot } from '@/play/arcade/verify';
import { readGameSpec } from '@/play/spec';

import { botHand } from '../bot-hand';
import { createArcadeSession } from '../session';

const worldOf = (raw: unknown): ArcadeWorld => {
  const spec = readGameSpec(raw);
  if (!spec.ok) throw new Error(spec.issues.join('; '));
  const built = arcadeWorldOf(spec.value, 1);
  if (!built.ok) throw new Error(built.issues.join('; '));
  return built.world;
};

function play(world: ArcadeWorld, finger: (wanted: ArcadeInput) => ArcadeInput) {
  const session = createArcadeSession(world);
  const hand = botHand(session);
  while (session.snapshot().runState === 'running' && session.snapshot().tick < 20_000) {
    const input = finger(hand.decide());
    session.hold(input.axis);
    session.holdButtons(0);
    session.press(input.buttons);
    hand.step();
  }
  return session;
}

describe('bot by hand', () => {
  it.each([
    ['runner', runnerFixture],
    ['platform', platformFixture],
  ])('%s: pressing exactly what the bot wants is the verifier run, hash for hash', (_, fixture) => {
    const world = worldOf(fixture);
    const witness = runBot(world);
    const session = play(world, (wanted) => wanted);
    expect(session.snapshot().runState).toBe(witness.outcome);
    expect(hashArcade(session.state())).toBe(witness.hash);
  });

  it('platform: a thumb that only knows full run left, full run right or nothing still wins', () => {
    const world = worldOf(platformFixture);
    const thumb = (wanted: ArcadeInput): ArcadeInput => ({
      buttons: wanted.buttons,
      axis: Math.abs(wanted.axis) < AXIS_MAX / 4 ? 0 : Math.sign(wanted.axis) * AXIS_MAX,
    });
    expect(play(world, thumb).snapshot().runState).toBe('won');
  });
});
