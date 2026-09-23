import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { ARCADE_LIMITS, type ArcadeLevel, type ArcadeWorld, BODY, BUTTON, COUNTER, FLAG, HEADER, NO_INPUT, bodyBase } from '../contract';
import { type ArcadeLibrary, buildWorld, instantiate, loadProgram, replay, step } from '../kernel';
import { ARCADE_LIBRARY } from '../library';
import { SHOOTER, SHOOTER_DIFFICULTIES, type ShooterDifficulty, aimAt, aimVelocity, arrivalOf, checkShooterLevel, gunTick, shooterBotRef, shooterGun, shooterRange, shooterRules } from '../pieces/shooter';
import { shooterBot } from '../pieces/shooter-bot';
import { runBot, verifyArcade } from '../verify';

const params = (difficulty: ShooterDifficulty, extra: Record<string, unknown> = {}) => shooterRange.params.parse({ difficulty, ...extra });

const idle = { id: 'idle', params: z.object({}), roles: [], reactionTicks: 0, cost: () => ({ bodies: 0, rules: 0 }), decide: () => NO_INPUT };
const library: ArcadeLibrary = { ...ARCADE_LIBRARY, bots: { ...ARCADE_LIBRARY.bots, idle } };

function worldOf(level: ArcadeLevel, p = params('normal'), health?: number): ArcadeWorld {
  const built = buildWorld({ seed: 1, control: { id: 'shooter', params: {} }, rules: shooterRules(p, health), bot: { id: 'idle', params: {} }, level, ...(health === undefined ? {} : { health }) }, library);
  if (!built.ok) throw new Error(built.issues.join('; '));
  return built.world;
}

const counter = (state: Int32Array, name: keyof typeof COUNTER): number => state[HEADER.counters + COUNTER[name]] as number;
const aliveAt = (state: Int32Array, index: number): boolean => ((state[bodyBase(index) + BODY.flags] as number) & FLAG.alive) !== 0;

describe('střelba – generátor', () => {
  it('50 semínek × 3 obtížnosti splní invarianty hratelnosti', () => {
    for (const difficulty of SHOOTER_DIFFICULTIES) {
      for (let seed = 1; seed <= 50; seed += 1) {
        const p = params(difficulty);
        expect(checkShooterLevel(shooterRange.generate(seed, p), shooterGun(p)), `${difficulty}/${seed}`).toEqual([]);
        // Krajní parametry: malý zásobník, dlouhé přebití, víc vln – generátor vlny rozestoupí nebo ubere.
        const tight = params(difficulty, { magazine: 2, reloadS: 4, waves: 6 });
        expect(checkShooterLevel(shooterRange.generate(seed * 7919, tight), shooterGun(tight)), `${difficulty}/${seed}/tight`).toEqual([]);
      }
    }
  });

  it('„hard“ má víc terčů i nepřátel a rychlejší vlny než „easy“', () => {
    for (let seed = 1; seed <= 20; seed += 1) {
      const easy = shooterRange.generate(seed, params('easy')).bodies;
      const hard = shooterRange.generate(seed, params('hard')).bodies;
      for (const role of ['target', 'enemy'] as const) expect(hard.filter((b) => b.role === role).length).toBeGreaterThan(easy.filter((b) => b.role === role).length);
      expect(Math.abs(hard.find((b) => b.role === 'enemy')?.vz ?? 0)).toBeGreaterThan(Math.abs(easy.find((b) => b.role === 'enemy')?.vz ?? 0));
    }
  });

  it('kontrola odhalí terč mimo dostřel, mimo úhel a vlnu hustší než přebití', () => {
    const p = params('normal');
    const level = shooterRange.generate(3, p);
    const firstTarget = level.bodies.findIndex((b) => b.role === 'target');
    const far: ArcadeLevel = { ...level, bodies: level.bodies.map((b, i) => (i === firstTarget ? { ...b, z: 40 * 1000, kinematic: false, vx: 0 } : b)) };
    expect(checkShooterLevel(far, shooterGun(p)).join()).toMatch(/out of range/);
    const wide: ArcadeLevel = { ...level, bodies: level.bodies.map((b, i) => (i === firstTarget ? { ...b, x: 15_000, z: 12_000, kinematic: false, vx: 0 } : b)) };
    expect(checkShooterLevel(wide, shooterGun(p)).join()).toMatch(/outside the aim cone/);
    // Druhá vlna dorazí jen 1 s po první.
    const enemies = level.bodies.filter((b) => b.role === 'enemy');
    const firstArrive = Math.min(...enemies.map((b) => arrivalOf(b) ?? Infinity));
    const dense: ArcadeLevel = {
      ...level,
      bodies: level.bodies.map((b) => {
        const arrive = b.role === 'enemy' ? arrivalOf(b) : null;
        if (arrive === null || arrive < firstArrive + 200) return b;
        const shifted = arrive - 300;
        return { ...b, x: -(b.vx ?? 0) * shifted, z: -(b.vz ?? 0) * shifted };
      }),
    };
    expect(checkShooterLevel(dense, shooterGun(p)).join()).toMatch(/no time to shoot it and reload/);
  });

  it('nábojů je víc než cílů a pravidla nepřekročí strop těl', () => {
    for (const difficulty of SHOOTER_DIFFICULTIES) {
      const level = shooterRange.generate(11, params(difficulty, { waves: 6 }));
      const foes = level.bodies.filter((b) => b.role === 'target' || b.role === 'enemy').length;
      expect((level.counters?.ammo ?? 0) + (level.counters?.reserve ?? 0)).toBeGreaterThan(foes);
      expect(level.bodies.length + (level.spawnSlots ?? 0)).toBeLessThanOrEqual(ARCADE_LIMITS.maxBodies);
    }
  });
});

describe('střelba – ovládání, zbraň a pravidla', () => {
  it('míření: osa nastaví, tlačítka posunou, osa 0 nechá; střela letí zamířeným směrem', () => {
    expect(aimVelocity(0)).toEqual({ vx: 0, vz: SHOOTER.bulletSpeed });
    const diag = aimVelocity(1000);
    expect(diag.vx).toBe(diag.vz);
    expect(Math.hypot(diag.vx, diag.vz)).toBeLessThanOrEqual(SHOOTER.bulletSpeed);
    expect(aimAt(0, 10_000)).toBe(1);
    expect(aimAt(5000, 10_000)).toBe(500);

    const w = worldOf(shooterRange.generate(1, params('easy')));
    const program = loadProgram(w, library);
    const state = instantiate(w);
    const aim = bodyBase(0) + BODY.aux0;
    step(state, { buttons: 0, axis: -300 }, program);
    expect(state[aim]).toBe(-300);
    step(state, { buttons: BUTTON.RIGHT, axis: 0 }, program);
    expect(state[aim]).toBe(-300 + SHOOTER.aimStep);
    step(state, NO_INPUT, program);
    expect(state[aim]).toBe(-300 + SHOOTER.aimStep);
    step(state, { buttons: BUTTON.TAP, axis: 400 }, program);
    // Střela je v prvním volném slotu za tělesy úrovně.
    const shot = bodyBase(state[HEADER.spawnBase] as number);
    expect(state[shot + BODY.vx]).toBe(aimVelocity(400).vx);
    expect(state[shot + BODY.vz]).toBe(aimVelocity(400).vz);
    expect(state[bodyBase(0) + BODY.z]).toBe(0);
  });

  it('zásobník: rozestup ran, po posledním náboji přebití a doplnění z rezervy', () => {
    const gunParams = { template: 1, magazine: 3, reloadTicks: 50 };
    let gun = { ammo: 3, reserve: 4, cooldown: 0 };
    const shots: number[] = [];
    for (let t = 0; t < 200; t += 1) {
      const next = gunTick(gun, true, gunParams);
      if (next.fired) shots.push(t);
      gun = next.next;
    }
    // 3 rány po 10 tikách, přebití 50, 3 rány, přebití, poslední náboj.
    expect(shots).toEqual([0, 10, 20, 70, 80, 90, 140]);
    expect(gun).toEqual({ ammo: 0, reserve: 0, cooldown: 0 });
  });

  it('zásah terče = bod a terč zmizí; všechno sestřelené = výhra', () => {
    const level: ArcadeLevel = {
      bodies: [
        { role: 'player', kind: 'shooter', x: 0, y: 0, z: 0, w: 600, h: 1700, d: 600, solid: false },
        { role: 'projectile', kind: 'bullet', x: 0, y: 0, z: 0, w: 200, h: 200, d: 200, solid: false, template: true, lifetime: 90 },
        { role: 'target', kind: 'target', x: 4000, y: 0, z: 16_000, w: 1000, h: 1500, d: 200, solid: false },
        { role: 'enemy', kind: 'enemy', x: 0, y: 0, z: 30 * 1500, w: 800, h: 1700, d: 800, solid: false, vz: -30, kinematic: true },
      ],
      length: 0,
      spawnSlots: 11,
      counters: { ammo: 5, reserve: 0 },
    };
    const w = worldOf(level);
    const program = loadProgram(w, library);
    const state = instantiate(w);
    step(state, { buttons: BUTTON.TAP, axis: aimAt(4000, 16_000) }, program);
    for (let t = 0; t < 60; t += 1) step(state, NO_INPUT, program);
    expect(counter(state, 'score')).toBe(1);
    expect(aliveAt(state, 2)).toBe(false);
    expect(counter(state, 'ammo')).toBe(4);
    expect(state[HEADER.runState]).toBe(0);
    // Nepřítel v 30 m po ose: výstřel, když je v dostřelu.
    for (let t = 0; t < 1200 && state[HEADER.runState] === 0; t += 1) {
      const z0 = state[bodyBase(3) + BODY.z] as number;
      step(state, z0 < 30_000 && t % 30 === 0 ? { buttons: BUTTON.TAP, axis: 1 } : NO_INPUT, program);
    }
    expect(state[HEADER.runState]).toBe(1);
    expect(counter(state, 'score')).toBe(2);
  });

  it('nečinný hráč prohraje, když dorazí první vlna; se životy ho vlna jen zraní', () => {
    const p = params('normal');
    const level = shooterRange.generate(5, p);
    const first = Math.min(...level.bodies.filter((b) => b.role === 'enemy').map((b) => arrivalOf(b) ?? Infinity));
    const lost = replay(worldOf(level, p), [], library);
    expect(lost.outcome).toBe('lost');
    expect(lost.tick).toBeLessThanOrEqual(first);
    expect(lost.tick).toBeGreaterThan(first - 60);

    const hurt = worldOf(level, p, 100);
    const program = loadProgram(hurt, library);
    const state = instantiate(hurt);
    for (let t = 0; t < first + 5; t += 1) step(state, NO_INPUT, program);
    expect(state[HEADER.runState]).toBe(0);
    expect(counter(state, 'health')).toBeLessThan(100);
    // Terče zůstaly, takže ani po všech vlnách nečinný hráč nevyhraje.
    expect(replay(hurt, [], library).outcome).not.toBe('won');
  });

  it('munice došla a terč zbyl → prohra až po dopadu poslední střely', () => {
    const level: ArcadeLevel = {
      bodies: [
        { role: 'player', kind: 'shooter', x: 0, y: 0, z: 0, w: 600, h: 1700, d: 600, solid: false },
        { role: 'projectile', kind: 'bullet', x: 0, y: 0, z: 0, w: 200, h: 200, d: 200, solid: false, template: true, lifetime: 90 },
        { role: 'target', kind: 'target', x: 4000, y: 0, z: 16_000, w: 1000, h: 1500, d: 200, solid: false },
        { role: 'enemy', kind: 'enemy', x: 0, y: 0, z: 30 * 3000, w: 800, h: 1700, d: 800, solid: false, vz: -30, kinematic: true },
      ],
      length: 0,
      spawnSlots: 11,
      counters: { ammo: 1, reserve: 0 },
    };
    const result = replay(worldOf(level), [{ tick: 0, buttons: BUTTON.TAP, axis: -900 }], library);
    expect(result.outcome).toBe('lost');
    // Střela žije 90 tiků; prohra přijde v tiku jejího zániku, ne při výstřelu.
    expect(result.tick).toBe(91);
  });
});

function botWorld(level: ArcadeLevel, p = params('normal')): ArcadeWorld {
  const built = buildWorld({ seed: 1, control: { id: 'shooter', params: {} }, rules: shooterRules(p), bot: shooterBotRef(p), level }, ARCADE_LIBRARY);
  if (!built.ok) throw new Error(built.issues.join('; '));
  return built.world;
}

describe('střelba – robot a ověření', () => {
  it('robot reaguje se zpožděním 8 tiků', () => {
    expect(shooterBot.reactionTicks).toBe(8);
  });

  it('30 semínek × 3 obtížnosti projde ověřením: robot vyhraje, nečinný ne, přehrání sedí', () => {
    for (const difficulty of SHOOTER_DIFFICULTIES) {
      for (let seed = 1; seed <= 30; seed += 1) {
        const p = params(difficulty);
        const verdict = verifyArcade(botWorld(shooterRange.generate(seed * 104729, p), p));
        expect(verdict.failures, `${difficulty}/${seed}`).toEqual([]);
        expect(verdict.idle.outcome, `${difficulty}/${seed}`).toBe('lost');
      }
    }
  });

  it('robot vidí svět pozdě: bez vlastní paměti výstřelů by pálil do terče, který už je zasažený', () => {
    // Jeden stojící terč, jeden nepřítel daleko: vystačí dvě rány, robot jich nesmí vypálit víc.
    const p = params('easy');
    const level: ArcadeLevel = {
      bodies: [
        { role: 'player', kind: 'shooter', x: 0, y: 0, z: 0, w: 600, h: 1700, d: 600, solid: false },
        { role: 'projectile', kind: 'bullet', x: 0, y: 0, z: 0, w: 200, h: 200, d: 200, solid: false, template: true, lifetime: 90 },
        { role: 'target', kind: 'target', x: -3000, y: 0, z: 24_000, w: 1000, h: 1500, d: 200, solid: false },
        { role: 'enemy', kind: 'enemy', x: 0, y: 0, z: 24 * 1200, w: 800, h: 1700, d: 800, solid: false, vz: -24, kinematic: true },
      ],
      length: 0,
      spawnSlots: 11,
      counters: { ammo: 8, reserve: 0 },
    };
    const run = runBot(botWorld(level, p));
    expect(run.outcome).toBe('won');
    expect(run.inputs.filter((input) => (input.buttons & BUTTON.TAP) !== 0)).toHaveLength(2);
  });

  it('terč mimo dostřel: hra neprojde a kontrola řekne proč', () => {
    const p = params('normal');
    const level = shooterRange.generate(7, p);
    const firstTarget = level.bodies.findIndex((b) => b.role === 'target');
    const far: ArcadeLevel = { ...level, bodies: level.bodies.map((b, i) => (i === firstTarget ? { ...b, x: 0, z: 45_000, kinematic: false, vx: 0 } : b)) };
    const verdict = verifyArcade(botWorld(far, p));
    expect(verdict.publishEligible).toBe(false);
    expect(verdict.failures.join()).toMatch(/bot_wins/);
    expect(checkShooterLevel(far, shooterGun(p))).toEqual([`target ${firstTarget} at 45.0 m is out of range (36.0 m)`]);
  });

  it('úroveň, kterou vyhraje i nečinný hráč, ověřením neprojde', () => {
    const p = params('easy');
    const level = shooterRange.generate(2, p);
    const empty: ArcadeLevel = { ...level, bodies: level.bodies.filter((b) => b.role !== 'target' && b.role !== 'enemy') };
    const verdict = verifyArcade(botWorld(empty, p));
    expect(verdict.idle.outcome).toBe('won');
    expect(verdict.failures.join()).toMatch(/idle_loses/);
    expect(verdict.publishEligible).toBe(false);
  });
});
