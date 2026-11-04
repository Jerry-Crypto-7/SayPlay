/**
 * Férový start (P70A T3, `FAIR_START` v `kernel.ts`): ochrana 3 s po prvním dotyku (tik 0), pomalý začátek 8 s
 * na 70 % a náběh na 100 %, poletování bere za zem život a ptáček se odrazí. Svět bez `fairStart` tikne jako dřív.
 */

import { describe, expect, it } from 'vitest';

import { type ArcadeLevel, type ArcadeWorld, BODY, COUNTER, HEADER, type PieceRef, RUN_STATE, bodyBase } from '../contract';
import { FAIR_START, buildWorld, instantiate, loadProgram, openingPace, replay, step, worldRests, worldTicks } from '../kernel';
import { ARCADE_LIBRARY } from '../library';
import { FLAP, flapRules, flapTrack } from '../pieces/flap';
import { openingAttack } from '../pieces/duel';

const HZ = 60;
const NONE = { buttons: 0, axis: 0 };

function worldOf(level: ArcadeLevel, rules: readonly PieceRef[], control: PieceRef, fairStart: boolean, health?: number): ArcadeWorld {
  const built = buildWorld({ seed: 1, control, rules, bot: { id: 'flap_bot', params: {} }, level, ...(health === undefined ? {} : { health }), ...(fairStart ? { fairStart: 'slow' as const } : {}) }, ARCADE_LIBRARY);
  if (!built.ok) throw new Error(built.issues.join('; '));
  return built.world;
}

const flapLevel = (): ArcadeLevel => flapTrack.generate(1, flapTrack.params.parse({ difficulty: 'easy' }));

describe('fair start – the shared opening pace', () => {
  it('is at most 70 % for the first 8 s, ramps up and is 100 % after the next 6 s', () => {
    for (let tick = 0; tick < 8 * HZ; tick += 1) expect(openingPace(tick)).toBeLessThanOrEqual(70);
    expect(openingPace(8 * HZ)).toBe(70);
    expect(openingPace(11 * HZ)).toBe(85);
    for (let tick = 14 * HZ; tick < 20 * HZ; tick += 1) expect(openingPace(tick)).toBe(100);
    // Náběh je plynulý: tempo nikdy neskočí o víc než procento za tik.
    for (let tick = 1; tick < 20 * HZ; tick += 1) expect(openingPace(tick) - openingPace(tick - 1)).toBeLessThanOrEqual(1);
  });

  it('the world moves on exactly the paced share of ticks, and on every tick after the ramp', () => {
    expect(worldTicks(0)).toBe(0);
    // 8 s na 70 % = 336 tiků pohybu z 480; tik 0 (první dotyk) se hýbe.
    expect(worldTicks(8 * HZ)).toBe(336);
    expect(worldRests(0)).toBe(false);
    // Celý začátek: 480 × 70 + 360 × průměr náběhu 84,5 = 640,2 tiku pohybu.
    expect(worldTicks(14 * HZ)).toBe(641);
    for (let tick = 14 * HZ; tick < 30 * HZ; tick += 1) expect(worldRests(tick)).toBe(false);
    let moved = 0;
    for (let tick = 0; tick < 14 * HZ; tick += 1) if (!worldRests(tick)) moved += 1;
    expect(moved).toBe(worldTicks(14 * HZ));
    // Nikdy dva odpočinky za sebou: pohyb neztuhne na dva snímky.
    for (let tick = 1; tick < 14 * HZ; tick += 1) expect(worldRests(tick) && worldRests(tick - 1)).toBe(false);
  });

  it('a kinematic body travels 70 % of the way in the opening and the full way after it; without fairStart every tick', () => {
    const level: ArcadeLevel = {
      length: 100_000,
      bodies: [
        { role: 'player', kind: 'hero', x: 0, y: 0, z: 0, w: 500, h: 500, d: 500, solid: false },
        { role: 'obstacle', kind: 'car', x: 50_000, y: 0, z: 50_000, w: 100, h: 100, d: 100, solid: false, kinematic: true, vz: -10 },
      ],
    };
    const control: PieceRef = { id: 'flap', params: {} };
    for (const fair of [true, false]) {
      const world = worldOf(level, [], control, fair);
      const program = loadProgram(world, ARCADE_LIBRARY);
      const state = instantiate(world);
      const carZ = bodyBase(1) + BODY.z;
      for (let tick = 0; tick < 8 * HZ; tick += 1) step(state, NONE, program);
      expect(50_000 - (state[carZ] as number), `fair ${String(fair)} at 8 s`).toBe(10 * (fair ? 336 : 8 * HZ));
      for (let tick = 8 * HZ; tick < 14 * HZ; tick += 1) step(state, NONE, program);
      const at14 = state[carZ] as number;
      step(state, NONE, program);
      expect(at14 - (state[carZ] as number)).toBe(10);
    }
  });

  it('a duel attack started in the slow opening is longer by the pace, after the ramp unchanged', () => {
    expect(openingAttack({ windup: 28, recover: 24 }, 0)).toEqual({ windup: 40, recover: 35 });
    expect(openingAttack({ windup: 28, recover: 24 }, 14 * HZ)).toEqual({ windup: 28, recover: 24 });
  });
});

describe('fair start – 3 s of protection after the first touch', () => {
  it('a lose effect in the first 3 s does nothing, at 3 s it ends the run; without fairStart at once', () => {
    // Poletování bez životů: ptáček bez ťuku spadne na zem za ~0,6 s a `fall_out` prohraje.
    const plain = worldOf(flapLevel(), flapRules(), { id: 'flap', params: {} }, false);
    expect(replay(plain, [], ARCADE_LIBRARY).tick).toBeLessThan(FAIR_START.protectTicks);
    const fair = worldOf(flapLevel(), flapRules(), { id: 'flap', params: {} }, true);
    const run = replay(fair, [], ARCADE_LIBRARY);
    expect(run.outcome).toBe('lost');
    expect(run.tick).toBe(FAIR_START.protectTicks + 1);
  });

  it('damage in the first 3 s takes no life, after it does', () => {
    const world = worldOf(flapLevel(), flapRules(3, true, false, false, true), { id: 'flap', params: { bounce: 1 } }, true, 3);
    const program = loadProgram(world, ARCADE_LIBRARY);
    const state = instantiate(world);
    const health = HEADER.counters + COUNTER.health;
    for (let tick = 0; tick < FAIR_START.protectTicks; tick += 1) step(state, NONE, program);
    expect(state[health]).toBe(3);
    expect(state[HEADER.runState]).toBe(RUN_STATE.running);
    for (let tick = FAIR_START.protectTicks; tick < FAIR_START.protectTicks + 3 * HZ && state[health] === 3; tick += 1) step(state, NONE, program);
    expect(state[health]).toBe(2);
  });
});

describe('fair start – flap: the ground costs a life and the bird bounces', () => {
  it('a ground touch takes one life, the bird bounces up and the game goes on until the last life', () => {
    const world = worldOf(flapLevel(), flapRules(3, true, false, false, true), { id: 'flap', params: { bounce: 1 } }, true, 3);
    const program = loadProgram(world, ARCADE_LIBRARY);
    const state = instantiate(world);
    const health = HEADER.counters + COUNTER.health;
    const y = bodyBase(0) + BODY.y;
    for (let tick = 0; tick < FAIR_START.protectTicks; tick += 1) step(state, NONE, program);
    // Po ochraně: první dotek země ubere život, hra běží dál a ptáček je zase ve vzduchu.
    let lost = -1;
    for (let tick = FAIR_START.protectTicks; tick < 30 * HZ && lost < 0; tick += 1) {
      step(state, NONE, program);
      if ((state[health] as number) < 3) lost = tick;
    }
    expect(lost).toBeGreaterThan(0);
    expect(state[HEADER.runState]).toBe(RUN_STATE.running);
    let peak = 0;
    for (let tick = 0; tick < 20; tick += 1) {
      step(state, NONE, program);
      peak = Math.max(peak, state[y] as number);
    }
    expect(peak).toBeGreaterThan(FLAP.bounceVy * 4);
    // Nečinný hráč dál prohraje – jen později: všechny tři životy.
    const run = replay(world, [], ARCADE_LIBRARY);
    expect(run.outcome).toBe('lost');
    expect(run.tick).toBeGreaterThan(FAIR_START.protectTicks + 2 * HZ);
  });

  it('a stored flap world (no bounce, no fairStart) still loses on the first ground touch', () => {
    const world = worldOf(flapLevel(), flapRules(3, true), { id: 'flap', params: {} }, false, 3);
    expect(replay(world, [], ARCADE_LIBRARY).tick).toBeLessThan(FAIR_START.protectTicks);
  });
});
