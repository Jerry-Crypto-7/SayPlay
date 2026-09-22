import { describe, expect, it } from 'vitest';

import { type ArcadeLevel, type ArcadeObservation, type ArcadeWorld, type BodyInit, HEADER } from '../contract';
import { type ArcadeLibrary, buildWorld } from '../kernel';
import { ARCADE_LIBRARY } from '../library';
import { RUNNER_DENSITIES, type RunnerSpeed, runnerTrack } from '../pieces/runner';
import { runnerBot } from '../pieces/runner-bot';
import { arcadeReport, verifyArcade } from '../verify';

function worldOf(level: ArcadeLevel, speed: RunnerSpeed = 'normal', library: ArcadeLibrary = ARCADE_LIBRARY): ArcadeWorld {
  const built = buildWorld(
    {
      seed: 1,
      control: { id: 'runner', params: { speed } },
      rules: [
        { id: 'hit', params: { role: 'obstacle', effect: 'lose' } },
        { id: 'pickup', params: {} },
        { id: 'finish', params: {} },
      ],
      bot: { id: 'runner_bot', params: {} },
      level,
    },
    library,
  );
  if (!built.ok) throw new Error(built.issues.join('; '));
  return built.world;
}

const track = (seed: number, density: (typeof RUNNER_DENSITIES)[number], speed: RunnerSpeed = 'normal', lengthM = 250) =>
  runnerTrack.generate(seed, runnerTrack.params.parse({ density, speed, lengthM }));

describe('verifyArcade', () => {
  it('30 semínek × 3 hustoty projde: robot vyhraje, nečinný ne, přehrání sedí', () => {
    for (const density of RUNNER_DENSITIES) {
      for (let seed = 1; seed <= 30; seed += 1) {
        const verdict = verifyArcade(worldOf(track(seed * 104729, density)));
        expect(verdict.failures, `${density}/${seed}`).toEqual([]);
        expect(verdict.publishEligible).toBe(true);
        expect(verdict.bot.tick).toBeLessThanOrEqual(5400);
      }
    }
  });

  it('projde i pomalá a rychlá trať s nejvyšší hustotou a délkou', () => {
    for (const speed of ['slow', 'fast'] as const) {
      for (let seed = 1; seed <= 10; seed += 1) {
        expect(verifyArcade(worldOf(track(seed, 'high', speed, 500), speed)).failures, `${speed}/${seed}`).toEqual([]);
      }
    }
  });

  it('zeď přes všechny tři pruhy neprojde a důvod řekne kde', () => {
    const level = track(7, 'low');
    const wall = (x: number): BodyInit => ({ role: 'obstacle', kind: 'crate', x, y: 0, z: 60_000, w: 1900, h: 3000, d: 600, solid: true });
    const broken: ArcadeLevel = { ...level, bodies: [...level.bodies.filter((body) => body.role !== 'obstacle' || Math.abs(body.z - 60_000) > 12_000), wall(-2000), wall(0), wall(2000)] };
    const verdict = verifyArcade(worldOf(broken));
    expect(verdict.publishEligible).toBe(false);
    expect(verdict.failures).toHaveLength(1);
    expect(verdict.failures[0]).toMatch(/^bot_wins: the bot lost at tick \d+, 60 m into the track$/);
  });

  it('trať bez překážek neprojde: nečinný hráč by vyhrál', () => {
    const level = track(3, 'low');
    const empty: ArcadeLevel = { ...level, bodies: level.bodies.filter((body) => body.role !== 'obstacle') };
    const verdict = verifyArcade(worldOf(empty));
    expect(verdict.bot.outcome).toBe('won');
    expect(verdict.publishEligible).toBe(false);
    expect(verdict.failures.join()).toMatch(/idle_loses: a player who does nothing wins/);
  });

  it('robot vidí stav přesně 8 tiků starý', () => {
    const seen: { readonly now: number; readonly observed: number; readonly stateTick: number }[] = [];
    let now = 0;
    const spy = {
      ...runnerBot,
      decide: (observation: ArcadeObservation, params: Record<string, never>) => {
        seen.push({ now, observed: observation.tick, stateTick: observation.state[HEADER.tick] as number });
        now += 1;
        return runnerBot.decide(observation, params);
      },
    };
    const library: ArcadeLibrary = { ...ARCADE_LIBRARY, bots: { runner_bot: spy } };
    const verdict = verifyArcade(worldOf(track(11, 'normal'), 'normal', library), library);
    expect(runnerBot.reactionTicks).toBe(8);
    expect(verdict.bot.outcome).toBe('won');
    for (const entry of seen.slice(8)) {
      expect(entry.now - entry.observed).toBe(8);
      expect(entry.stateTick).toBe(entry.observed);
    }
  });

  it('ovládání se skrytým stavem mimo pole neprojde: přehrání se rozejdou', () => {
    // Paměť mimo stav: každý běh zapíše do skóre, kolikátý je.
    let runs = 0;
    const leaky = { ...ARCADE_LIBRARY.controls.runner!, step: (...args: Parameters<(typeof ARCADE_LIBRARY.controls)['runner']['step']>) => {
      if (args[0][HEADER.tick] === 0) runs += 1;
      ARCADE_LIBRARY.controls.runner!.step(...args);
      args[0][HEADER.counters] = runs;
    } };
    const library: ArcadeLibrary = { ...ARCADE_LIBRARY, controls: { runner: leaky } };
    const verdict = verifyArcade(worldOf(track(2, 'low'), 'normal', library), library);
    expect(verdict.replayEqual).toBe(false);
    expect(verdict.failures.join()).toMatch(/replay_equal/);
  });

  it('report má tvar QualityReport a nese důvod neúspěchu v keypointu', () => {
    const world = worldOf(track(5, 'normal'));
    const passed = arcadeReport(verifyArcade(world), world, { specHash: 'spec', worldHash: 'world' });
    expect(passed.publishEligible).toBe(true);
    expect(passed.keypoints.map((keypoint) => keypoint.assertionId)).toEqual(['bot_wins', 'idle_loses', 'replay_equal', 'within_limits']);
    expect(passed.witness.certified).toBe(true);

    const level = track(5, 'normal');
    const empty = worldOf({ ...level, bodies: level.bodies.filter((body) => body.role !== 'obstacle') });
    const failed = arcadeReport(verifyArcade(empty), empty, { specHash: 'spec', worldHash: 'world' });
    expect(failed.publishEligible).toBe(false);
    expect(failed.keypoints.find((keypoint) => !keypoint.passed)?.assertionId).toBe('idle_loses');
  });
});
