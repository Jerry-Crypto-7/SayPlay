import { describe, expect, it } from 'vitest';

import { BODY, BUTTON, NO_INPUT, bodyBase } from '../contract';
import { type ArcadeLibrary, buildWorld, instantiate, loadProgram, step } from '../kernel';
import { PLATFORM, PLATFORM_DIFFICULTIES, PLATFORM_JUMP_PEAK, type PlatformDifficulty, checkPlatformLevel, maxGap, platformControl, platformLevel, platformRules } from '../pieces/platform';
import { RULES } from '../pieces/rules';

const params = (difficulty: PlatformDifficulty, extra: Record<string, unknown> = {}) => platformLevel.params.parse({ difficulty, ...extra });
const spikes = (seed: number, difficulty: PlatformDifficulty) => platformLevel.generate(seed, params(difficulty)).bodies.filter((body) => body.role === 'hazard').length;

const library: ArcadeLibrary = { controls: { platform: platformControl }, rules: RULES, generators: {}, bots: {} };

function worldOf(seed: number, extra: Record<string, unknown> = {}) {
  const p = params('normal', extra);
  const built = buildWorld({ seed, control: { id: 'platform', params: { doubleJump: p.doubleJump } }, rules: platformRules(p), bot: { id: 'none', params: {} }, level: platformLevel.generate(seed, p) }, {
    ...library,
    bots: { none: { id: 'none', params: platformControl.params, roles: [], reactionTicks: 0, cost: () => ({ bodies: 0, rules: 0 }), decide: () => NO_INPUT } },
  });
  if (!built.ok) throw new Error(built.issues.join('; '));
  return built.world;
}

describe('plošinovka – generátor', () => {
  it('50 semínek × 3 obtížnosti splní invarianty hratelnosti', () => {
    for (const difficulty of PLATFORM_DIFFICULTIES) {
      for (let seed = 1; seed <= 50; seed += 1) {
        expect(checkPlatformLevel(platformLevel.generate(seed, params(difficulty))), `${difficulty}/${seed}`).toEqual([]);
        const full = platformLevel.generate(seed * 7919, params(difficulty, { lengthM: 250, movingPlatforms: true, checkpoints: true }));
        expect(checkPlatformLevel(full), `${difficulty}/${seed}/full`).toEqual([]);
      }
    }
  });

  it('pohyblivé plošiny a checkpointy se opravdu objeví', () => {
    const level = platformLevel.generate(3, params('normal', { lengthM: 200, movingPlatforms: true, checkpoints: true }));
    expect(level.bodies.filter((body) => body.kinematic === true).length).toBeGreaterThan(0);
    expect(level.bodies.filter((body) => body.role === 'checkpoint').length).toBeGreaterThan(0);
  });

  it('„hard“ má víc hrotů než „easy“ na každém semínku', () => {
    for (let seed = 1; seed <= 50; seed += 1) expect(spikes(seed, 'hard'), `${seed}`).toBeGreaterThan(spikes(seed, 'easy'));
  });

  it('stejné semínko = stejná úroveň, jiné semínko = jiná', () => {
    expect(platformLevel.generate(42, params('normal'))).toEqual(platformLevel.generate(42, params('normal')));
    expect(platformLevel.generate(42, params('normal'))).not.toEqual(platformLevel.generate(43, params('normal')));
  });

  it('hrot je nižší než půl skoku a mezera se vejde do skoku', () => {
    expect(PLATFORM.spikeH).toBeLessThan(PLATFORM_JUMP_PEAK / 2);
    expect(maxGap(PLATFORM.maxRise)).toBeGreaterThan(PLATFORM.playerD * 3);
  });

  it('kontrola odhalí přílišnou mezeru, vysoký schod, hrot bez místa a chybějící cíl', () => {
    const level = platformLevel.generate(1, params('easy'));
    const [player, start, second] = level.bodies.filter((body) => body.role === 'player' || body.role === 'platform') as [(typeof level.bodies)[number], (typeof level.bodies)[number], (typeof level.bodies)[number]];
    const far = start.z + start.d / 2;
    const wide = { ...second, z: far + maxGap(0) + 500 + second.d / 2, y: start.y };
    expect(checkPlatformLevel({ bodies: [player, start, wide], length: 0 }).join()).toMatch(/wider than a jump/);
    const high = { ...second, z: far + 1500 + second.d / 2, y: start.y + PLATFORM.maxRise + 200 };
    expect(checkPlatformLevel({ bodies: [player, start, high], length: 0 }).join()).toMatch(/higher than a jump/);
    const edge = { role: 'hazard' as const, kind: 'spikes', x: 0, y: start.y + start.h, z: far - 500, w: 1200, h: 500, d: 800, solid: false };
    expect(checkPlatformLevel({ bodies: [player, start, edge], length: 0 }).join()).toMatch(/no room/);
    expect(checkPlatformLevel({ bodies: [player, start], length: 0 }).join()).toMatch(/no goal/);
  });
});

describe('plošinovka – ovládání', () => {
  const P = bodyBase(0);

  it('vpravo zrychlí do nejvyšší rychlosti, bez vstupu tření zastaví', () => {
    const w = worldOf(5);
    const program = loadProgram(w, library);
    const state = instantiate(w);
    for (let t = 0; t < 20; t += 1) step(state, { buttons: 0, axis: 1000 }, program);
    expect(state[P + BODY.vz]).toBe(PLATFORM.maxRun);
    for (let t = 0; t < 20; t += 1) step(state, NO_INPUT, program);
    expect(state[P + BODY.vz]).toBe(0);
    expect(state[P + BODY.y]).toBe(PLATFORM.baseTop);
  });

  it('skok jen ze země; dvojskok jen s parametrem a jen jednou za let', () => {
    for (const doubleJump of [false, true]) {
      const w = worldOf(5, { doubleJump });
      const program = loadProgram(w, library);
      const state = instantiate(w);
      step(state, { buttons: BUTTON.TAP, axis: 0 }, program);
      for (let t = 0; t < 10; t += 1) step(state, NO_INPUT, program);
      const vyBefore = state[P + BODY.vy] as number;
      step(state, { buttons: BUTTON.TAP, axis: 0 }, program);
      const vyAfter = state[P + BODY.vy] as number;
      if (doubleJump) expect(vyAfter).toBe(PLATFORM.doubleJumpVy - 8);
      else expect(vyAfter).toBe(vyBefore - 8);
      step(state, { buttons: BUTTON.TAP, axis: 0 }, program);
      expect(state[P + BODY.vy]).toBe(vyAfter - 8);
    }
  });

  it('pád do propasti prohraje, s checkpointy vrátí zpět', () => {
    for (const checkpoints of [false, true]) {
      const w = worldOf(5, { checkpoints });
      const program = loadProgram(w, library);
      const state = instantiate(w);
      // Běh vpravo bez skoku skončí v první mezeře: prohra, nebo návrat (z klesne).
      let back = false;
      for (let t = 0; t < 400 && state[1] === 0 && !back; t += 1) {
        const z = state[P + BODY.z] as number;
        step(state, { buttons: 0, axis: 1000 }, program);
        back = (state[P + BODY.z] as number) < z;
      }
      if (checkpoints) {
        expect(back).toBe(true);
        expect(state[1]).toBe(0);
        expect(state[P + BODY.z]).toBe(0);
        expect(state[P + BODY.y]).toBe(PLATFORM.baseTop);
      } else expect(state[1]).toBe(2);
    }
  });
});
