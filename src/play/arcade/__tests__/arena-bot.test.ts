import { describe, expect, it } from 'vitest';

import { type ArcadeLevel, type ArcadeWorld } from '../contract';
import { buildWorld } from '../kernel';
import { ARCADE_LIBRARY } from '../library';
import { ARENA, ARENA_DENSITIES, type ArenaDensity, arenaBotRef, arenaControlRef, arenaLevel, arenaRules } from '../pieces/arena';
import { arenaBot } from '../pieces/arena-bot';
import { verifyArcade } from '../verify';

const params = (density: ArenaDensity, extra: Record<string, unknown> = {}) => arenaLevel.params.parse({ density, ...extra });

function worldOf(level: ArcadeLevel, goal: 'grow' | 'survive' = 'grow', health?: number): ArcadeWorld {
  const built = buildWorld(
    { seed: 1, control: arenaControlRef(), rules: arenaRules(level, { goal, seconds: 40 }, health), bot: arenaBotRef(), level, ...(health === undefined ? {} : { health }) },
    ARCADE_LIBRARY,
  );
  if (!built.ok) throw new Error(built.issues.join('; '));
  return built.world;
}

describe('aréna – robot a ověření', () => {
  it('30 semínek × 3 hustoty projde: robot vyroste, nečinného sní, přehrání sedí', () => {
    for (const density of ARENA_DENSITIES) {
      for (let seed = 1; seed <= 30; seed += 1) {
        const verdict = verifyArcade(worldOf(arenaLevel.generate(seed * 104_729, params(density))));
        expect(verdict.failures, `${density}/${seed}`).toEqual([]);
        expect(verdict.idle.outcome, `${density}/${seed}`).toBe('lost');
      }
    }
  });

  it('projde i cíl přežít a hra se životy', () => {
    for (let seed = 1; seed <= 10; seed += 1) {
      expect(verifyArcade(worldOf(arenaLevel.generate(seed, params('dense')), 'survive')).failures, `survive/${seed}`).toEqual([]);
      expect(verifyArcade(worldOf(arenaLevel.generate(seed, params('normal')), 'grow', 3)).failures, `lives/${seed}`).toEqual([]);
    }
  });

  it('robot reaguje se zpožděním 8 tiků', () => {
    expect(arenaBot.reactionTicks).toBe(8);
  });

  it('aréna bez větších buněk na přežití vyhraje i nečinný hráč – ověření ji odmítne', () => {
    const level = arenaLevel.generate(3, params('normal'));
    const tame: ArcadeLevel = { ...level, bodies: level.bodies.filter((b) => !(b.role === 'enemy' && b.w > ARENA.startSize)) };
    const verdict = verifyArcade(worldOf(tame, 'survive'));
    expect(verdict.idle.outcome).toBe('won');
    expect(verdict.failures.some((failure) => failure.startsWith('idle_loses:'))).toBe(true);
    expect(verdict.publishEligible).toBe(false);
  });

  it('hráč od začátku nejmenší a bez potravy neprojde', () => {
    const level = arenaLevel.generate(7, params('normal'));
    const starved: ArcadeLevel = { ...level, bodies: level.bodies.filter((b) => b.role !== 'collectible').map((b) => (b.role === 'enemy' ? { ...b, w: Math.max(b.w, ARENA.startSize + 200), d: Math.max(b.d, ARENA.startSize + 200) } : b)) };
    const verdict = verifyArcade(worldOf(starved));
    expect(verdict.publishEligible).toBe(false);
    expect(verdict.failures.join()).toMatch(/^bot_wins: the bot lost at tick \d+/);
  });
});
