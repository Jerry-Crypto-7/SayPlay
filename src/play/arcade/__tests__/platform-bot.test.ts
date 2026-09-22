import { describe, expect, it } from 'vitest';

import type { ArcadeLevel, ArcadeWorld, BodyInit } from '../contract';
import { buildWorld } from '../kernel';
import { ARCADE_LIBRARY } from '../library';
import { PLATFORM_DIFFICULTIES, type PlatformDifficulty, type PlatformLevelParams, maxGap, platformLevel, platformRules } from '../pieces/platform';
import { platformBot } from '../pieces/platform-bot';
import { verifyArcade } from '../verify';

const params = (difficulty: PlatformDifficulty, extra: Partial<PlatformLevelParams> = {}): PlatformLevelParams => platformLevel.params.parse({ difficulty, ...extra });

function worldOf(level: ArcadeLevel, p: PlatformLevelParams): ArcadeWorld {
  const built = buildWorld(
    { seed: 1, control: { id: 'platform', params: { doubleJump: p.doubleJump } }, rules: platformRules(p), bot: { id: 'platform_bot', params: {} }, level },
    ARCADE_LIBRARY,
  );
  if (!built.ok) throw new Error(built.issues.join('; '));
  return built.world;
}

const verify = (seed: number, p: PlatformLevelParams) => verifyArcade(worldOf(platformLevel.generate(seed, p), p));

describe('robot plošinovky a ověření', () => {
  it('robot reaguje se zpožděním 8 tiků', () => {
    expect(platformBot.reactionTicks).toBe(8);
  });

  it('30 semínek × 3 obtížnosti projde: robot vyhraje do 90 s, nečinný ne, přehrání sedí', () => {
    for (const difficulty of PLATFORM_DIFFICULTIES) {
      for (let seed = 1; seed <= 30; seed += 1) {
        const verdict = verify(seed * 104729, params(difficulty));
        expect(verdict.failures, `${difficulty}/${seed}`).toEqual([]);
        expect(verdict.bot.tick).toBeLessThanOrEqual(5400);
      }
    }
  });

  it('projdou i pohyblivé plošiny, checkpointy a nejdelší úroveň', () => {
    for (const difficulty of PLATFORM_DIFFICULTIES) {
      for (let seed = 1; seed <= 10; seed += 1) {
        const verdict = verify(seed * 7919, params(difficulty, { movingPlatforms: true, checkpoints: seed % 2 === 0, lengthM: 200 }));
        expect(verdict.failures, `${difficulty}/${seed}`).toEqual([]);
      }
    }
  });

  it('úroveň s nepřeskočitelnou mezerou neprojde a důvod řekne kde', () => {
    const p = params('easy');
    const level = platformLevel.generate(11, p);
    // Všechno za první mezerou posunout o dva skoky dál.
    const start = level.bodies[1] as BodyInit;
    const edge = start.z + start.d / 2;
    const push = 2 * maxGap(0);
    const broken: ArcadeLevel = { ...level, bodies: level.bodies.map((body, i) => (i > 1 && body.z > edge ? { ...body, z: body.z + push } : body)), length: level.length + push };
    const verdict = verifyArcade(worldOf(broken, p));
    expect(verdict.publishEligible).toBe(false);
    expect(verdict.failures).toHaveLength(1);
    expect(verdict.failures[0]).toMatch(/^bot_wins: the bot lost at tick \d+, \d+ m into the track$/);
  });

  it('úroveň, kterou vyhraje i nečinný hráč, neprojde', () => {
    const p = params('easy');
    const level = platformLevel.generate(11, p);
    // Cíl přímo na startu: hráč v něm stojí od tiku 0.
    const bodies = level.bodies.map((body) => (body.role === 'goal' ? { ...body, z: 0 } : body));
    const verdict = verifyArcade(worldOf({ ...level, bodies }, p));
    expect(verdict.publishEligible).toBe(false);
    expect(verdict.failures.join()).toMatch(/idle_loses: a player who does nothing wins/);
  });
});
