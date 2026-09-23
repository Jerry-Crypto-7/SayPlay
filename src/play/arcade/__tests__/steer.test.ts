import { describe, expect, it } from 'vitest';

import { type ArcadeLevel, type ArcadeWorld, BODY, BUTTON, COUNTER, HEADER, bodyBase } from '../contract';
import { buildWorld, instantiate, loadProgram, replay, step } from '../kernel';
import { ARCADE_LIBRARY } from '../library';
import { STEER, STEER_DIFFICULTIES, type SteerDifficulty, checkSteerLevel, lateralReach, steerControlRef, steerRules, steerSegments, steerTrack } from '../pieces/steer';

const params = (difficulty: SteerDifficulty, extra: Record<string, unknown> = {}) => steerTrack.params.parse({ difficulty, ...extra });

/** Svět bez robota řidiče: ovládání a pravidla stačí (robot přijde v T3). */
function worldOf(level: ArcadeLevel): ArcadeWorld {
  const built = buildWorld({ seed: 1, control: steerControlRef(level, { topSpeed: STEER.topSpeed, drift: false }), rules: steerRules(level), bot: { id: 'runner_bot', params: {} }, level }, ARCADE_LIBRARY);
  if (!built.ok) throw new Error(built.issues.join('; '));
  return built.world;
}

/** Počet zatáček: úseky s posunem, které začínají po rovném úseku. */
function bends(level: ArcadeLevel): number {
  const segments = steerSegments(level);
  let count = 0;
  for (let i = 1; i < segments.length; i += 1) {
    const shift = segments[i]!.center - segments[i - 1]!.center;
    const before = i >= 2 ? segments[i - 1]!.center - segments[i - 2]!.center : 0;
    if (shift !== 0 && before === 0) count += 1;
  }
  return count;
}

describe('řízení – generátor', () => {
  it('50 semínek × 3 obtížnosti splní invarianty hratelnosti', () => {
    for (const difficulty of STEER_DIFFICULTIES) {
      for (let seed = 1; seed <= 50; seed += 1) {
        expect(checkSteerLevel(steerTrack.generate(seed, params(difficulty))), `${difficulty}/${seed}`).toEqual([]);
        expect(checkSteerLevel(steerTrack.generate(seed * 7919, params(difficulty, { lengthM: 800 }))), `${difficulty}/${seed}/long`).toEqual([]);
        expect(checkSteerLevel(steerTrack.generate(seed * 31, params(difficulty, { lengthM: 200, topSpeed: 360 })), 360), `${difficulty}/${seed}/fast`).toEqual([]);
      }
    }
  });

  it('„hard“ má víc zatáček a užší trať než „easy“', () => {
    for (let seed = 1; seed <= 20; seed += 1) {
      const easy = steerTrack.generate(seed, params('easy'));
      const hard = steerTrack.generate(seed, params('hard'));
      expect(bends(hard), `seed ${seed}`).toBeGreaterThan(bends(easy));
      expect(steerSegments(hard)[0]!.width).toBeLessThan(steerSegments(easy)[0]!.width);
    }
  });

  it('dosah řízení na úsek zatáčky pokryje největší posun i při nejvyšší rychlosti s turbem', () => {
    // Pin: z konstant ovládání – kdyby se změnily, generátor by stavěl nesjízdné zatáčky.
    expect(lateralReach(10_000, 360)).toBe(2320);
    expect(lateralReach(10_000, 360) - STEER.clearance).toBeGreaterThanOrEqual(1900);
  });

  it('kontrola odhalí úzký průjezd, díru v mantinelech a nesjízdný posun', () => {
    const level = steerTrack.generate(3, params('normal'));
    const segments = steerSegments(level);
    const bend = segments.findIndex((s, i) => i > 0 && s.center !== segments[i - 1]!.center);
    const target = segments[bend]!;
    const moved = (dx: number): ArcadeLevel => ({
      ...level,
      bodies: level.bodies.map((b) => (b.kind === 'tire-barrier' && b.z === (target.near + target.far) / 2 ? { ...b, x: b.x + dx } : b)),
    });
    expect(checkSteerLevel(moved(Math.sign(target.center - segments[bend - 1]!.center) * 7000)).join()).toMatch(/too tight|past the barrier|can steer only/);
    expect(checkSteerLevel(moved(Math.sign(target.center - segments[bend - 1]!.center) * 2400)).join()).toMatch(/can steer only/);
    const holed: ArcadeLevel = { ...level, bodies: level.bodies.filter((b) => !(b.kind === 'tire-barrier' && b.z === (target.near + target.far) / 2)) };
    expect(checkSteerLevel(holed).join()).toMatch(/hole/);
  });
});

describe('řízení – ovládání', () => {
  it('plyn je automatický, osa vpravo = +x, bez vstupu boční rychlost dojede', () => {
    const w = worldOf(steerTrack.generate(1, params('normal')));
    const program = loadProgram(w, ARCADE_LIBRARY);
    const state = instantiate(w);
    const p = bodyBase(0);
    step(state, { buttons: 0, axis: 1000 }, program);
    expect(state[p + BODY.vz]).toBe(STEER.accel);
    expect(state[p + BODY.vx]).toBe(STEER.steerRate);
    for (let i = 0; i < 20; i += 1) step(state, { buttons: 0, axis: 1000 }, program);
    expect(state[p + BODY.vx]).toBe(STEER.latMax);
    step(state, { buttons: 0, axis: 0 }, program);
    expect(state[p + BODY.vx]).toBe(STEER.latMax - STEER.grip);
    const vz = state[p + BODY.vz] as number;
    step(state, { buttons: BUTTON.DOWN, axis: 0 }, program);
    expect(state[p + BODY.vz]).toBe(vz - STEER.brake);
  });

  it('se smykem boční rychlost dojíždí pomaleji', () => {
    const level = steerTrack.generate(1, params('normal'));
    const built = buildWorld({ seed: 1, control: { id: 'steer', params: { drift: true } }, rules: steerRules(level), bot: { id: 'runner_bot', params: {} }, level }, ARCADE_LIBRARY);
    if (!built.ok) throw new Error(built.issues.join());
    const program = loadProgram(built.world, ARCADE_LIBRARY);
    const state = instantiate(built.world);
    for (let i = 0; i < 12; i += 1) step(state, { buttons: BUTTON.RIGHT, axis: 0 }, program);
    step(state, { buttons: 0, axis: 0 }, program);
    expect(state[bodyBase(0) + BODY.vx]).toBe(STEER.latMax - STEER.driftGrip);
  });

  it('kdo neřídí, narazí do mantinelu a soupeř ho porazí', () => {
    for (const difficulty of STEER_DIFFICULTIES) {
      const w = worldOf(steerTrack.generate(5, params(difficulty)));
      expect(replay(w, [], ARCADE_LIBRARY).outcome, difficulty).toBe('lost');
    }
  });

  it('bez soupeřů nečinný hráč stojí u mantinelu a nevyhraje', () => {
    const level = steerTrack.generate(5, params('normal', { rivals: false }));
    const w = worldOf(level);
    const idle = replay(w, [], ARCADE_LIBRARY);
    expect(idle.outcome).toBe('running');
    const state = instantiate(w);
    const program = loadProgram(w, ARCADE_LIBRARY);
    for (let i = 0; i < 1500; i += 1) step(state, { buttons: 0, axis: 0 }, program);
    // Stojí čelem v mantinelu první zatáčky.
    expect(state[bodyBase(0) + BODY.vz]).toBeLessThanOrEqual(STEER.accel);
  });

  it('sebrané turbo zvedne nejvyšší rychlost a po čase ji vrátí', () => {
    const w = worldOf(steerTrack.generate(1, params('normal')));
    const program = loadProgram(w, ARCADE_LIBRARY);
    const state = instantiate(w);
    const p = bodyBase(0);
    for (let i = 0; i < 100; i += 1) step(state, { buttons: 0, axis: 0 }, program);
    expect(state[p + BODY.vz]).toBe(STEER.topSpeed);
    state[HEADER.counters + COUNTER.score] = 1;
    for (let i = 0; i < 30; i += 1) step(state, { buttons: 0, axis: 0 }, program);
    expect(state[p + BODY.vz]).toBe(STEER.topSpeed + STEER.boost);
  });

  it('soupeři jedou po trati a drží se mezi mantinely', () => {
    const level = steerTrack.generate(2, params('hard'));
    const w = worldOf(level);
    const program = loadProgram(w, ARCADE_LIBRARY);
    const state = instantiate(w);
    const segments = steerSegments(level);
    const rivals = level.bodies.flatMap((b, i) => (b.role === 'enemy' ? [i] : []));
    expect(rivals.length).toBe(4);
    // Hráč stojí (brzdí), soupeři jedou; hlídat je, dokud nedojedou.
    for (let t = 0; t < 2400 && state[HEADER.runState] === 0; t += 1) {
      step(state, { buttons: BUTTON.DOWN, axis: 0 }, program);
      for (const i of rivals) {
        const x = state[bodyBase(i) + BODY.x] as number;
        const z = state[bodyBase(i) + BODY.z] as number;
        const here = segments.find((s) => z >= s.near && z < s.far)!;
        expect(Math.abs(x - here.center) * 2, `rival ${i} at ${z}`).toBeLessThan(here.width);
      }
    }
    expect(state[HEADER.runState]).toBe(2);
  });
});
