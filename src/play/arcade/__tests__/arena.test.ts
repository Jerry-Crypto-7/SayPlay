import { describe, expect, it } from 'vitest';

import { type ArcadeLevel, type ArcadeWorld, BODY, COUNTER, FLAG, HEADER, bodyBase } from '../contract';
import { buildWorld, instantiate, loadProgram, replay, step } from '../kernel';
import { ARCADE_LIBRARY } from '../library';
import { ARENA, ARENA_DENSITIES, type ArenaDensity, DIRECTIONS, arenaAxis, arenaControlRef, arenaLevel, arenaRules, checkArenaLevel, directionOfAxis, sizeOf } from '../pieces/arena';

const params = (density: ArenaDensity, extra: Record<string, unknown> = {}) => arenaLevel.params.parse({ density, ...extra });

/** Svět bez robota arény (přijde v T5): ovládání a pravidla stačí. */
function worldOf(level: ArcadeLevel, goal: 'grow' | 'survive' = 'grow', health?: number): ArcadeWorld {
  const built = buildWorld(
    { seed: 1, control: arenaControlRef(), rules: arenaRules(level, { goal, seconds: 40 }, health), bot: { id: 'runner_bot', params: {} }, level, ...(health === undefined ? {} : { health }) },
    ARCADE_LIBRARY,
  );
  if (!built.ok) throw new Error(built.issues.join('; '));
  return built.world;
}

const alive = (state: Int32Array, i: number): boolean => ((state[bodyBase(i) + BODY.flags] as number) & FLAG.alive) !== 0;

describe('aréna – generátor', () => {
  it('50 semínek × 3 hustoty splní invarianty hratelnosti', () => {
    for (const density of ARENA_DENSITIES) {
      for (let seed = 1; seed <= 50; seed += 1) {
        expect(checkArenaLevel(arenaLevel.generate(seed * 7919, params(density))), `${density}/${seed}`).toEqual([]);
      }
    }
  });

  it('hustší aréna má víc potravy i větších buněk', () => {
    const count = (level: ArcadeLevel, role: string) => level.bodies.filter((b) => b.role === role).length;
    const sparse = arenaLevel.generate(3, params('sparse'));
    const dense = arenaLevel.generate(3, params('dense'));
    expect(count(dense, 'collectible')).toBeGreaterThan(count(sparse, 'collectible'));
    expect(count(dense, 'enemy')).toBeGreaterThan(count(sparse, 'enemy'));
  });

  it('kontrola odhalí větší buňku u startu a arénu bez potravy', () => {
    const level = arenaLevel.generate(5, params('normal'));
    const hunter = level.bodies.findIndex((b) => b.role === 'enemy' && b.w > ARENA.startSize);
    const close: ArcadeLevel = { ...level, bodies: level.bodies.map((b, i) => (i === hunter ? { ...b, x: 3000, z: 0 } : b)) };
    expect(checkArenaLevel(close).join()).toMatch(/growing past the first hunter/);
    const starved: ArcadeLevel = { ...level, bodies: level.bodies.filter((b) => b.role !== 'collectible') };
    expect(checkArenaLevel(starved).join()).toMatch(/only 0 points of food/);
  });
});

describe('aréna – ovládání a pravidla', () => {
  it('osa nese směr: tah po +x jede po +x, osa 0 stojí', () => {
    expect(directionOfAxis(0)).toBe(-1);
    for (let k = 0; k < 32; k += 1) expect(directionOfAxis(arenaAxis(DIRECTIONS[k]!.dx, DIRECTIONS[k]!.dz)), `dir ${k}`).toBe(k);
    const w = worldOf(arenaLevel.generate(1, params('normal')));
    const program = loadProgram(w, ARCADE_LIBRARY);
    const state = instantiate(w);
    const p = bodyBase(0);
    for (let i = 0; i < 10; i += 1) step(state, { buttons: 0, axis: arenaAxis(1, 0) }, program);
    expect(state[p + BODY.vx]).toBe(ARENA.speed);
    expect(state[p + BODY.vz]).toBe(0);
    for (let i = 0; i < 10; i += 1) step(state, { buttons: 0, axis: 0 }, program);
    expect(state[p + BODY.vx]).toBe(0);
    expect(state[p + BODY.y]).toBe(0);
  });

  it('snědená potrava přidá bod, zmizí a hráč vyroste; stěna arény ho zastaví', () => {
    const w = worldOf(arenaLevel.generate(2, params('normal')));
    const program = loadProgram(w, ARCADE_LIBRARY);
    const state = instantiate(w);
    const p = bodyBase(0);
    const food = 1;
    const target = { x: state[bodyBase(food) + BODY.x] as number, z: state[bodyBase(food) + BODY.z] as number };
    for (let t = 0; t < 200 && alive(state, food); t += 1) step(state, { buttons: 0, axis: arenaAxis(target.x - (state[p + BODY.x] as number), target.z - (state[p + BODY.z] as number)) }, program);
    expect(alive(state, food)).toBe(false);
    expect(state[HEADER.counters + COUNTER.score]).toBeGreaterThanOrEqual(1);
    step(state, { buttons: 0, axis: 0 }, program);
    expect(state[p + BODY.w]).toBe(sizeOf(state[HEADER.counters + COUNTER.score] as number));
    for (let t = 0; t < 400; t += 1) step(state, { buttons: 0, axis: arenaAxis(1, 0) }, program);
    expect((state[p + BODY.x] as number) + (state[p + BODY.w] as number) / 2).toBeLessThanOrEqual(ARENA.half);
  });

  it('větší buňka nečinného hráče dojede a sní; se životy ztratí život a vrátí se na start', () => {
    for (const density of ARENA_DENSITIES) {
      const level = arenaLevel.generate(4, params(density));
      expect(replay(worldOf(level), [], ARCADE_LIBRARY).outcome, density).toBe('lost');
      expect(replay(worldOf(level, 'survive'), [], ARCADE_LIBRARY).outcome, `${density}/survive`).toBe('lost');
    }
    const w = worldOf(arenaLevel.generate(4, params('normal')), 'grow', 3);
    const program = loadProgram(w, ARCADE_LIBRARY);
    const state = instantiate(w);
    let t = 0;
    while (t < 3000 && state[HEADER.counters + COUNTER.health] === 3) {
      step(state, { buttons: 0, axis: 0 }, program);
      t += 1;
    }
    expect(state[HEADER.counters + COUNTER.health]).toBe(2);
    expect(state[HEADER.runState]).toBe(0);
    expect([state[bodyBase(0) + BODY.x], state[bodyBase(0) + BODY.z]]).toEqual([0, 0]);
  });

  it('růst je monotónní a nikdy pod startovní velikost, 50 semínek × 3 hustoty', () => {
    for (const density of ARENA_DENSITIES) {
      for (let seed = 1; seed <= 50; seed += 1) {
        const w = worldOf(arenaLevel.generate(seed, params(density)));
        const program = loadProgram(w, ARCADE_LIBRARY);
        const state = instantiate(w);
        let last: number = ARENA.startSize;
        // Hráč krouží: jí, co potká, a buňky ho honí – dokud běh nekončí.
        for (let t = 0; t < 1200 && state[HEADER.runState] === 0; t += 1) {
          const dir = DIRECTIONS[Math.floor(t / 20) % 32]!;
          step(state, { buttons: 0, axis: arenaAxis(dir.dx, dir.dz) }, program);
          const size = state[bodyBase(0) + BODY.w] as number;
          expect(size, `${density}/${seed}@${t}`).toBeGreaterThanOrEqual(last);
          last = size;
        }
        expect(last).toBeLessThanOrEqual(ARENA.maxSize);
      }
    }
  });
});
