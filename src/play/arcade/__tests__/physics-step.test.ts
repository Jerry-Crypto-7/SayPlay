/**
 * Fyzikální tělesa v kroku jádra (P29A T12): Rapier je hýbe, jádro po každém
 * tiku drží jejich kvantovaný stav v `Int32Array`, a hash i replay platí dál.
 */

import { beforeAll, describe, expect, it } from 'vitest';

import { type ArcadeState, type ArcadeWorld, BODY, type BodyInit, FLAG, NO_INPUT, PHYSICS_SUBSTEPS, bodyBase, unpackRotation } from '../contract';
import { buildWorld, hashArcade, instantiate, loadProgram, replay, step } from '../kernel';
import { ARCADE_LIBRARY } from '../library';
import { loadRapier } from '../physics/world';
import { THROW, launchVelocity, simulateThrow, throwFlight } from '../pieces/throw';

const PLAYER: BodyInit = { role: 'player', kind: 'player', x: -30000, y: 0, z: -30000, w: 1000, h: 600, d: 1000, solid: false };

const box = (x: number, y: number, z: number, size: number, extra: Partial<BodyInit> = {}): BodyInit => ({
  role: 'obstacle',
  kind: 'crate',
  x,
  y,
  z,
  w: size,
  h: size,
  d: size,
  solid: true,
  physics: true,
  ...extra,
});

function world(bodies: readonly BodyInit[]): ArcadeWorld {
  const built = buildWorld(
    {
      seed: 1,
      control: { id: 'move_free', params: { half: 40000 } },
      rules: [],
      bot: { id: 'arena_bot', params: { half: 40000 } },
      level: { length: 0, bodies: [PLAYER, ...bodies] },
    },
    ARCADE_LIBRARY,
  );
  if (!built.ok) throw new Error(built.issues.join('; '));
  return built.world;
}

/** Odehraje `ticks` tiků bez vstupu; `each` dostane stav po každém. */
function run(target: ArcadeWorld, ticks: number, each?: (state: ArcadeState, tick: number) => void): ArcadeState {
  const program = loadProgram(target, ARCADE_LIBRARY);
  const state = instantiate(target);
  for (let tick = 0; tick < ticks; tick += 1) {
    step(state, NO_INPUT, program);
    each?.(state, tick + 1);
  }
  return state;
}

const slot = (state: ArcadeState, body: number, name: keyof typeof BODY): number => state[bodyBase(body) + BODY[name]] as number;
const tilted = (state: ArcadeState, body: number): boolean => Math.abs(unpackRotation(slot(state, body, 'aux0'), slot(state, body, 'aux1'))[3]) < 0.99;

beforeAll(async () => {
  await loadRapier();
});

describe('physics bodies step through Rapier', () => {
  it('a crate falls and rests on the ground', () => {
    const heights: number[] = [];
    const state = run(world([box(0, 3000, 0, 500)]), 120, (s) => heights.push(slot(s, 1, 'y')));
    expect(heights[10]).toBeLessThan(3000);
    expect(Math.abs(slot(state, 1, 'y'))).toBeLessThanOrEqual(2);
    expect(slot(state, 1, 'vy')).toBe(0);
    expect(tilted(state, 1)).toBe(false);
  });

  it('a crate slides along the ground and friction stops it', () => {
    const speeds: number[] = [];
    const state = run(world([box(0, 0, 0, 500, { vz: 100 })]), 240, (s) => speeds.push(slot(s, 1, 'vz')));
    // Rychlost ve stavu je Rapierova: brzdí se postupně, ne skokem.
    expect(speeds[3]).toBeGreaterThan(0);
    expect(speeds[3]).toBeLessThan(100);
    expect(slot(state, 1, 'vz')).toBe(0);
    expect(slot(state, 1, 'z')).toBeGreaterThan(500);
    expect(slot(state, 1, 'z')).toBeLessThan(20000);
  });

  it('a bouncy ball comes back up after it hits the ground', () => {
    const vy: number[] = [];
    run(world([box(0, 4000, 0, 400, { ball: true, restitution: 800 })]), 180, (s) => vy.push(slot(s, 1, 'vy')));
    const firstFall = vy.findIndex((v) => v < 0);
    expect(firstFall).toBeGreaterThanOrEqual(0);
    expect(vy.slice(firstFall).some((v) => v > 20)).toBe(true);
    // Bez odrazu se nevrátí.
    const dead: number[] = [];
    run(world([box(0, 4000, 0, 400, { ball: true })]), 180, (s) => dead.push(slot(s, 1, 'vy')));
    expect(dead.some((v) => v > 20)).toBe(false);
  });

  it('a ball thrown into a tower topples it', () => {
    const tower = [0, 1, 2, 3].map((k) => box(0, k * 500, 6000, 500));
    const state = run(world([...tower, box(0, 1200, 2000, 600, { ball: true, vy: 30, vz: 300 })]), 240);
    expect([1, 2, 3, 4].some((i) => tilted(state, i))).toBe(true);
    expect(slot(state, 4, 'y')).toBeLessThan(1500);
  });

  it('the state stays in the Int32Array: hash and replay agree, and the ticks are not a no-op', () => {
    const scene = world([...[0, 1, 2, 3].map((k) => box(0, k * 500, 6000, 500)), box(0, 1000, 0, 400, { ball: true, vz: 250, restitution: 300 }), box(3000, 2000, 0, 500, { vx: -60 })]);
    const stepped = run(scene, 300);
    const first = replay(scene, [], ARCADE_LIBRARY, 300);
    const second = replay(scene, [], ARCADE_LIBRARY, 300);
    expect(first.hash).toBe(second.hash);
    expect(first.hash).toBe(hashArcade(stepped));
    expect(replay(scene, [], ARCADE_LIBRARY, 299).hash).not.toBe(first.hash);
  });

  it('a world without physics bodies never runs the physics phase', () => {
    const plain = world([{ ...box(0, 3000, 0, 500), physics: undefined, gravity: true }]);
    expect(loadProgram(plain, ARCADE_LIBRARY).physics).toBe(false);
    expect(loadProgram(world([box(0, 3000, 0, 500)]), ARCADE_LIBRARY).physics).toBe(true);
    // Kernelová gravitace: bez Rapieru dopadne přesně na nulu a nemá natočení.
    const state = run(plain, 120);
    expect(slot(state, 1, 'y')).toBe(0);
    expect(slot(state, 1, 'aux0')).toBe(0);
    expect(slot(state, 1, 'flags') & FLAG.physics).toBe(0);
  });

  it('rejects physics on the player, a kinematic body and ball/restitution without physics', () => {
    const issues = (bodies: readonly BodyInit[]): readonly string[] => {
      const built = buildWorld({ seed: 1, control: { id: 'move_free', params: { half: 40000 } }, rules: [], bot: { id: 'arena_bot', params: { half: 40000 } }, level: { length: 0, bodies } }, ARCADE_LIBRARY);
      return built.ok ? [] : built.issues;
    };
    expect(issues([{ ...PLAYER, physics: true }]).join()).toMatch(/physics body/);
    expect(issues([PLAYER, box(0, 0, 0, 500, { kinematic: true })]).join()).toMatch(/physics body/);
    expect(issues([PLAYER, { ...box(0, 0, 0, 500), physics: undefined, restitution: 200 }]).join()).toMatch(/belong to physics/);
    expect(issues([PLAYER, box(0, 0, 0, 500, { restitution: 1001 })]).join()).toMatch(/restitution 1001/);
  });

  it('simulateThrow flight predicts a physics ball to within one unit until it lands', () => {
    for (const plan of [
      { aim: 300, charge: 20 },
      { aim: -200, charge: 40 },
      { aim: 800, charge: 60 },
    ]) {
      const { vy, vz } = launchVelocity(plan.aim, plan.charge);
      const s = THROW.ballSize;
      const flight = throwFlight(plan, true);
      expect(simulateThrow([], plan, true)).toBe(-1);
      const actual: { y: number; z: number }[] = [];
      run(world([box(0, THROW.launchY, THROW.launchZ, s, { ball: true, vy, vz, solid: false })]), flight.length, (state) => actual.push({ y: slot(state, 1, 'y'), z: slot(state, 1, 'z') }));
      const landing = flight.length - 1;
      for (let n = 0; n < landing; n += 1) {
        expect(Math.abs((actual[n]?.y ?? NaN) - (flight[n]?.y ?? NaN))).toBeLessThanOrEqual(1);
        expect(Math.abs((actual[n]?.z ?? NaN) - (flight[n]?.z ?? NaN))).toBeLessThanOrEqual(1);
      }
      // Tik dopadu je předpovězený: míč je na zemi (zapadne nejvýš o pád jednoho
      // podkroku a Rapier ho vytlačí) a vpřed ho tření v podkrocích po dopadu
      // zbrzdí nejvýš o pohyb jednoho podkroku.
      const substepFall = Math.abs(flight[landing]?.vy ?? NaN) / PHYSICS_SUBSTEPS + 8;
      expect(Math.abs(actual[landing]?.y ?? NaN)).toBeLessThanOrEqual(substepFall);
      expect(Math.abs((actual[landing]?.z ?? NaN) - (flight[landing]?.z ?? NaN))).toBeLessThanOrEqual(Math.abs(vz) / PHYSICS_SUBSTEPS);
      expect(actual[landing - 1]?.y ?? NaN).toBeGreaterThan(substepFall);
    }
  });
});
