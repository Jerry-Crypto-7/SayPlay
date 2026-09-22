import { describe, expect, it } from 'vitest';

import { type ArcadeLevel, type ArcadeWorld, BODY, BUTTON, bodyBase } from '../contract';
import { buildWorld, instantiate, loadProgram, replay, step } from '../kernel';
import { ARCADE_LIBRARY } from '../library';
import { FLAP, FLAP_DIFFICULTIES, type FlapDifficulty, checkFlapLevel, flapGaps, flapRules, flapTrack } from '../pieces/flap';
import { flapBot } from '../pieces/flap-bot';
import { verifyArcade } from '../verify';

const params = (difficulty: FlapDifficulty, extra: Record<string, unknown> = {}) => flapTrack.params.parse({ difficulty, ...extra });

function worldOf(level: ArcadeLevel): ArcadeWorld {
  const built = buildWorld({ seed: 1, control: { id: 'flap', params: {} }, rules: flapRules(), bot: { id: 'flap_bot', params: {} }, level }, ARCADE_LIBRARY);
  if (!built.ok) throw new Error(built.issues.join('; '));
  return built.world;
}

describe('poletování – generátor', () => {
  it('50 semínek × 3 obtížnosti splní invarianty hratelnosti', () => {
    for (const difficulty of FLAP_DIFFICULTIES) {
      for (let seed = 1; seed <= 50; seed += 1) {
        expect(checkFlapLevel(flapTrack.generate(seed, params(difficulty))), `${difficulty}/${seed}`).toEqual([]);
        expect(checkFlapLevel(flapTrack.generate(seed * 7919, params(difficulty, { lengthM: 250 }))), `${difficulty}/${seed}/long`).toEqual([]);
      }
    }
  });

  it('„hard“ má užší mezery a víc trubek než „easy“', () => {
    for (let seed = 1; seed <= 20; seed += 1) {
      const easy = flapGaps(flapTrack.generate(seed, params('easy')));
      const hard = flapGaps(flapTrack.generate(seed, params('hard')));
      expect(hard.length).toBeGreaterThan(easy.length);
      expect(Math.max(...hard.map((g) => g.top - g.bottom))).toBeLessThan(Math.min(...easy.map((g) => g.top - g.bottom)));
    }
  });

  it('kontrola odhalí úzkou mezeru a skok výšky', () => {
    const level = flapTrack.generate(4, params('normal'));
    const [first] = flapGaps(level);
    const narrowed: ArcadeLevel = { ...level, bodies: level.bodies.map((b) => (b.role === 'obstacle' && b.z === first!.z && b.y > 0 ? { ...b, y: first!.bottom + FLAP.size + 100 } : b)) };
    expect(checkFlapLevel(narrowed).join()).toMatch(/too tight/);
    const shifted: ArcadeLevel = { ...level, bodies: level.bodies.map((b) => (b.role === 'obstacle' && b.z === first!.z ? (b.y === 0 ? { ...b, h: b.h + 4000 } : { ...b, y: b.y + 4000 }) : b)) };
    expect(checkFlapLevel(shifted).join()).toMatch(/too far to follow/);
  });
});

describe('poletování – ovládání a robot', () => {
  it('ťuk vzlétne, bez ťuku hráč spadne na zem a prohraje', () => {
    const w = worldOf(flapTrack.generate(1, params('normal')));
    const program = loadProgram(w, ARCADE_LIBRARY);
    const state = instantiate(w);
    const y = bodyBase(0) + BODY.y;
    step(state, { buttons: BUTTON.TAP, axis: 0 }, program);
    expect(state[y]).toBe(FLAP.startY + FLAP.flapVy - 8);
    expect(state[bodyBase(0) + BODY.z]).toBe(FLAP.speed);
    expect(replay(w, [], ARCADE_LIBRARY).outcome).toBe('lost');
  });

  it('strop nepustí hráče přes trubky', () => {
    const w = worldOf(flapTrack.generate(1, params('normal')));
    const program = loadProgram(w, ARCADE_LIBRARY);
    const state = instantiate(w);
    let highest = 0;
    for (let t = 0; t < 100; t += 1) {
      step(state, { buttons: BUTTON.TAP, axis: 0 }, program);
      highest = Math.max(highest, state[bodyBase(0) + BODY.y] as number);
    }
    expect(highest).toBeLessThanOrEqual(FLAP.ceiling - FLAP.size);
  });

  it('robot reaguje se zpožděním 8 tiků', () => {
    expect(flapBot.reactionTicks).toBe(8);
  });

  it('30 semínek × 3 obtížnosti projde ověřením', () => {
    for (const difficulty of FLAP_DIFFICULTIES) {
      for (let seed = 1; seed <= 30; seed += 1) {
        const verdict = verifyArcade(worldOf(flapTrack.generate(seed * 104729, params(difficulty))));
        expect(verdict.failures, `${difficulty}/${seed}`).toEqual([]);
      }
    }
  });

  it('zúžená mezera neprojde', () => {
    const level = flapTrack.generate(9, params('easy'));
    const gaps = flapGaps(level);
    const third = gaps[2]!;
    // Mezera nižší než hráč: proletět nejde.
    const narrowed: ArcadeLevel = { ...level, bodies: level.bodies.map((b) => (b.role === 'obstacle' && b.z === third.z && b.y > 0 ? { ...b, y: third.bottom + FLAP.size - 200 } : b)) };
    const verdict = verifyArcade(worldOf(narrowed));
    expect(verdict.publishEligible).toBe(false);
    expect(verdict.failures[0]).toMatch(/^bot_wins: the bot lost/);  });
});
