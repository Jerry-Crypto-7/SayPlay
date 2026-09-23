import { describe, expect, it } from 'vitest';

import { reportFor } from '@/app/api/play/_report';
import { compileGame } from '@/play/compile';
import { readGameSpec } from '@/play/spec';

import steerFixture from '../__fixtures__/steer.json';
import { type ArcadeLevel, type ArcadeWorld, type BodyInit } from '../contract';
import { buildWorld } from '../kernel';
import { ARCADE_LIBRARY } from '../library';
import { STEER, STEER_DIFFICULTIES, type SteerDifficulty, steerBotRef, steerControlRef, steerRules, steerSegments, steerTrack } from '../pieces/steer';
import { steerBot } from '../pieces/steer-bot';
import { verifyArcade } from '../verify';

const params = (difficulty: SteerDifficulty, extra: Record<string, unknown> = {}) => steerTrack.params.parse({ difficulty, ...extra });

function worldOf(level: ArcadeLevel, extra: { topSpeed?: number; drift?: boolean } = {}): ArcadeWorld {
  const car = { topSpeed: extra.topSpeed ?? STEER.topSpeed, drift: extra.drift ?? false };
  const built = buildWorld({ seed: 1, control: steerControlRef(level, car), rules: steerRules(level), bot: steerBotRef(level, car), level }, ARCADE_LIBRARY);
  if (!built.ok) throw new Error(built.issues.join('; '));
  return built.world;
}

describe('řízení – robot a ověření', () => {
  it('30 semínek × 3 obtížnosti projde: robot dojede první, nečinný ne, přehrání sedí', () => {
    for (const difficulty of STEER_DIFFICULTIES) {
      for (let seed = 1; seed <= 30; seed += 1) {
        const verdict = verifyArcade(worldOf(steerTrack.generate(seed * 104_729, params(difficulty))));
        expect(verdict.failures, `${difficulty}/${seed}`).toEqual([]);
        expect(verdict.idle.outcome, `${difficulty}/${seed}`).toBe('lost');
      }
    }
  });

  it('projde i nejdelší trať, nejvyšší rychlost a smyk', () => {
    for (let seed = 1; seed <= 6; seed += 1) {
      expect(verifyArcade(worldOf(steerTrack.generate(seed, params('hard', { lengthM: 800 })))).failures, `long/${seed}`).toEqual([]);
      expect(verifyArcade(worldOf(steerTrack.generate(seed, params('hard', { topSpeed: 360 })), { topSpeed: 360 })).failures, `fast/${seed}`).toEqual([]);
      expect(verifyArcade(worldOf(steerTrack.generate(seed, params('normal', { drift: true })), { drift: true })).failures, `drift/${seed}`).toEqual([]);
    }
  });

  it('robot reaguje se zpožděním 8 tiků', () => {
    expect(steerBot.reactionTicks).toBe(8);
  });

  it('trať se zdí přes celou šířku neprojde a důvod řekne kde', () => {
    const level = steerTrack.generate(7, params('normal'));
    const first = steerSegments(level)[0]!;
    const wall: BodyInit = { role: 'obstacle', kind: 'crate', x: first.center, y: 0, z: 30_000, w: first.width + 2 * STEER.wallW, h: 1500, d: 1000, solid: true };
    const verdict = verifyArcade(worldOf({ ...level, bodies: [...level.bodies, wall] }));
    expect(verdict.publishEligible).toBe(false);
    expect(verdict.failures).toHaveLength(1);
    // Hráč stojí u přední stěny zdi (30 m − 0,5 m − půl auta); soupeři (kinematičtí) projedou a vyhrají.
    expect(verdict.failures[0]).toMatch(/^bot_wins: the bot lost at tick \d+, 29 m into the track$/);
  });

  it('fixtura závodu se zkompiluje do arkádového světa a projde ověřením', () => {
    const read = readGameSpec(steerFixture);
    if (!read.ok) throw new Error(read.issues.join('; '));
    const compiled = compileGame(read.value, 1);
    if (!compiled.ok) throw new Error(compiled.issues.join('; '));
    expect(compiled.value.arcade?.control.id).toBe('steer');
    expect(compiled.value.arcade?.bot.id).toBe('steer_bot');
    expect(compiled.value.arcade?.rules.map((rule) => rule.id)).toEqual(['pickup', 'finish', 'rival_finish']);
    const report = reportFor(compiled.value);
    expect(report.keypoints.filter((keypoint) => !keypoint.passed)).toEqual([]);
    expect(report.publishEligible).toBe(true);
    // Parametry jiného ovládání spec odmítne.
    const crossed = readGameSpec({ ...steerFixture, controlParams: { difficulty: 'hard', doubleJump: true } });
    expect(crossed.ok).toBe(false);
  });

  it('rovnou trať bez soupeřů vyhraje i nečinný hráč – ověření ji odmítne', () => {
    const level = steerTrack.generate(3, params('easy', { rivals: false }));
    // Všechny úseky na ose: žádná zatáčka.
    const straight: ArcadeLevel = { ...level, bodies: level.bodies.map((b) => (b.kind === 'tire-barrier' ? { ...b, x: Math.sign(b.x - (steerSegments(level).find((s) => b.z > s.near && b.z < s.far)?.center ?? 0)) * (11_000 / 2 + STEER.wallW / 2) } : b.role === 'goal' ? { ...b, x: 0 } : b)) };
    const verdict = verifyArcade(worldOf(straight));
    expect(verdict.idle.outcome).toBe('won');
    expect(verdict.failures.some((failure) => failure.startsWith('idle_loses:'))).toBe(true);
    expect(verdict.publishEligible).toBe(false);
  });
});
