/**
 * Slovesné efekty jádra (P29A T3): `grab`, `throwHeld`, `release`, `push`, `toggle`.
 *
 * Chyba v nich se neprojeví na obrazovce hned, ale až na replayi – proto každý
 * test čte stav tik po tiku a poslední porovnává hash dvou přehrání.
 */

import { beforeAll, describe, expect, it } from 'vitest';

import { BODY, BUTTON, FLAG, HEADER, NO_INPUT, bodyBase, type ArcadeInput, type ArcadeState, type ArcadeWorld, type BodyInit, type InputEvent } from '../contract';
import { buildWorld, hashArcade, instantiate, loadProgram, replay, step, type ArcadeProgram } from '../kernel';
import { ARCADE_LIBRARY } from '../library';
import { loadRapier } from '../physics/world';
import type { CompiledRule } from '../rules/compile';

const KEY = 32;
const CRATE = 33;
const DOOR = 34;
const BRIDGE = 35;

/** Osa `move_free`: 1 = +z, 500 = +x. */
const FORWARD: ArcadeInput = { buttons: 0, axis: 1 };
const RIGHT: ArcadeInput = { buttons: 0, axis: 500 };
const TAP: ArcadeInput = { buttons: BUTTON.TAP, axis: 0 };
const FIRE: ArcadeInput = { buttons: BUTTON.FIRE, axis: 0 };

const thing = (roleCode: number, x: number, z: number, size: readonly [number, number, number], solid: boolean, extra: Partial<BodyInit> = {}): BodyInit => ({
  role: 'thing',
  roleCode,
  kind: `thing:${roleCode}`,
  x,
  y: 0,
  z,
  w: size[0],
  h: size[1],
  d: size[2],
  solid,
  ...extra,
});

const rule = (id: string, piece: string, params: Omit<CompiledRule, 'id' | 'verb' | 'if'> & Partial<Pick<CompiledRule, 'if'>>) => ({
  id: piece,
  params: { id, verb: id, if: [], ...params },
});

/** Hráč v počátku, klíč před ním, bedna vpravo, dveře vzadu, skrytý most vlevo. */
function lab(physical = false): ArcadeWorld {
  const physics: Partial<BodyInit> = physical ? { physics: true } : {};
  const built = buildWorld(
    {
      seed: 1,
      control: { id: 'move_free', params: { half: 12000 } },
      bot: { id: 'arena_bot', params: { half: 12000 } },
      level: {
        length: 0,
        bodies: [
          { role: 'player', kind: 'player', x: 0, y: 0, z: 0, w: 1000, h: 600, d: 1000, solid: false },
          thing(KEY, 0, 2000, [500, 500, 500], false, physics),
          thing(CRATE, 4000, 0, [1000, 1000, 1000], true, physics),
          thing(DOOR, 0, -6000, [2000, 2500, 500], true),
          thing(BRIDGE, -6000, 0, [3000, 100, 3000], false, { template: true }),
        ],
      },
      rules: [
        rule('carry', 'rule_contact', { when: { contact: [1, KEY] }, if: [{ notHolding: true }], do: [{ grab: 'other' }] }),
        rule('throw', 'rule_press', { when: { press: BUTTON.TAP }, if: [{ holding: KEY }], do: [{ throwHeld: true }] }),
        rule('drop', 'rule_press', { when: { press: BUTTON.FIRE }, if: [{ holding: KEY }], do: [{ release: true }] }),
        rule('shove', 'rule_contact', { when: { contact: [1, CRATE] }, do: [{ push: 'other' }] }),
        rule('open', 'rule_tick', { when: { every: 30 }, do: [{ toggle: DOOR }, { toggle: BRIDGE }] }),
      ],
    },
    ARCADE_LIBRARY,
  );
  if (!built.ok) throw new Error(built.issues.join('; '));
  return built.world;
}

const P = 0;
const K = 1;
const C = 2;
const D = 3;
const B = 4;

const at = (state: ArcadeState, body: number, slot: keyof typeof BODY): number => state[bodyBase(body) + BODY[slot]] as number;
const flag = (state: ArcadeState, body: number, bit: number): boolean => (at(state, body, 'flags') & bit) !== 0;

function run(state: ArcadeState, program: ArcadeProgram, input: ArcadeInput, ticks: number, each?: () => void): void {
  for (let i = 0; i < ticks; i += 1) {
    step(state, input, program);
    each?.();
  }
}

/** Dojde ke klíči a zvedne ho; vrátí stav a program. */
function holding(physical = false): { state: ArcadeState; program: ArcadeProgram } {
  const w = lab(physical);
  const program = loadProgram(w, ARCADE_LIBRARY);
  const state = instantiate(w);
  for (let i = 0; i < 60 && state[HEADER.held] === 0; i += 1) step(state, FORWARD, program);
  expect(state[HEADER.held]).toBe(K + 1);
  return { state, program };
}

describe('verb effects in the kernel', () => {
  it('grab pins the held body on the player every tick, wherever the player goes', () => {
    const { state, program } = holding();
    const pinned = (): void => {
      expect(at(state, K, 'x')).toBe(at(state, P, 'x'));
      expect(at(state, K, 'z')).toBe(at(state, P, 'z'));
      expect(at(state, K, 'y')).toBe(at(state, P, 'y') + at(state, P, 'h'));
    };
    pinned();
    const startX = at(state, P, 'x');
    run(state, program, RIGHT, 20, pinned);
    expect(at(state, P, 'x')).toBeGreaterThan(startX + 1000);
    run(state, program, NO_INPUT, 20, pinned);
    expect(state[HEADER.held]).toBe(K + 1);
  });

  it('a solid held body is not a ceiling: the player rises with it on the head', () => {
    const { state, program } = holding();
    const key = bodyBase(K);
    state[key + BODY.flags] = (state[key + BODY.flags] as number) | FLAG.solid;
    state[bodyBase(P) + BODY.vy] = 100;
    step(state, NO_INPUT, program);
    expect(at(state, P, 'y')).toBeGreaterThan(0);
    expect(at(state, K, 'y')).toBe(at(state, P, 'y') + at(state, P, 'h'));
  });

  it('throwHeld lets go with the speed of the facing direction, and the body comes to rest on the ground', () => {
    const { state, program } = holding();
    run(state, program, RIGHT, 10);
    step(state, TAP, program);
    expect(state[HEADER.held]).toBe(0);
    expect(at(state, K, 'vx')).toBeGreaterThan(0);
    expect(at(state, K, 'vz')).toBe(0);
    const thrownFrom = at(state, P, 'x');
    run(state, program, NO_INPUT, 240);
    expect(at(state, K, 'y')).toBe(0);
    expect(at(state, K, 'vx')).toBe(0);
    expect(at(state, K, 'vy')).toBe(0);
    expect(at(state, K, 'x')).toBeGreaterThan(thrownFrom + 3000);
    expect(state[HEADER.held]).toBe(0);
  });

  it('release puts the body down in front of a still player, on the ground and not picked up again', () => {
    const { state, program } = holding();
    run(state, program, NO_INPUT, 30);
    expect(at(state, P, 'vz')).toBe(0);
    step(state, FIRE, program);
    expect(state[HEADER.held]).toBe(0);
    run(state, program, NO_INPUT, 60);
    expect(state[HEADER.held]).toBe(0);
    expect(at(state, K, 'y')).toBe(0);
    expect(at(state, K, 'z')).toBeGreaterThan(at(state, P, 'z'));
  });

  it('push shoves the body along the dominant axis away from the player, and integer friction stops it', () => {
    const w = lab();
    const program = loadProgram(w, ARCADE_LIBRARY);
    const state = instantiate(w);
    for (let i = 0; i < 60 && at(state, C, 'vx') === 0; i += 1) step(state, RIGHT, program);
    expect(at(state, C, 'vx')).toBeGreaterThan(0);
    expect(at(state, C, 'vz')).toBe(0);
    const from = at(state, C, 'x');
    let last = at(state, C, 'vx');
    run(state, program, NO_INPUT, 60, () => {
      const vx = at(state, C, 'vx');
      expect(vx).toBeLessThan(last);
      last = Math.max(1, vx);
    });
    expect(at(state, C, 'vx')).toBe(0);
    expect(at(state, C, 'x')).toBeGreaterThan(from + 500);
    expect(flag(state, C, FLAG.solid)).toBe(true);
  });

  it('toggle switches every body of the role once: the door vanishes, the hidden bridge appears, and they stay so', () => {
    const w = lab();
    const program = loadProgram(w, ARCADE_LIBRARY);
    const state = instantiate(w);
    expect(flag(state, D, FLAG.alive)).toBe(true);
    expect(flag(state, B, FLAG.alive)).toBe(false);
    run(state, program, NO_INPUT, 30);
    expect(flag(state, D, FLAG.alive)).toBe(false);
    expect(flag(state, B, FLAG.alive)).toBe(true);
    run(state, program, NO_INPUT, 90);
    expect(flag(state, D, FLAG.alive)).toBe(false);
    expect(flag(state, B, FLAG.alive)).toBe(true);
  });

  it('two replays of the same carry, throw and push give the same hash; another run gives another', () => {
    const w = lab();
    const script: InputEvent[] = [];
    for (let t = 0; t < 30; t += 1) script.push({ tick: t, ...FORWARD });
    for (let t = 30; t < 60; t += 1) script.push({ tick: t, ...RIGHT });
    script.push({ tick: 60, ...TAP });
    for (let t = 61; t < 100; t += 1) script.push({ tick: t, ...RIGHT });
    const a = replay(w, script, ARCADE_LIBRARY, 400);
    const b = replay(w, script, ARCADE_LIBRARY, 400);
    expect(a).toEqual(b);
    const other = replay(w, script.filter((event) => event.tick !== 60), ARCADE_LIBRARY, 400);
    expect(other.hash).not.toBe(a.hash);
  });
});

describe('verb effects on physics bodies go through Rapier (P29A T13)', () => {
  beforeAll(async () => {
    await loadRapier();
  });

  /** Hráč jde doprava, dokud bedna nedostane strčení; pak stojí. Vrací stav a rychlosti bedny po strčení. */
  function shoved(): { state: ArcadeState; speeds: number[] } {
    const w = lab(true);
    const program = loadProgram(w, ARCADE_LIBRARY);
    const state = instantiate(w);
    for (let i = 0; i < 120 && at(state, C, 'vx') === 0; i += 1) step(state, RIGHT, program);
    const speeds: number[] = [];
    run(state, program, NO_INPUT, 180, () => speeds.push(at(state, C, 'vx')));
    return { state, speeds };
  }

  it('push hands its impulse to Rapier: the crate slides, Rapier friction stops it, no kernel gravity', () => {
    const { state, speeds } = shoved();
    expect(speeds[0]).toBeGreaterThan(0);
    expect(at(state, C, 'x')).toBeGreaterThan(5000);
    expect(at(state, C, 'vx')).toBe(0);
    // Rapierovo tření brzdí jinak než jádro (to ubírá přesně `VERB_MOTION.friction` za tik).
    expect(speeds.slice(0, 5).some((v, k) => k > 0 && (speeds[k - 1] as number) - v !== 8)).toBe(true);
    expect(flag(state, C, FLAG.gravity)).toBe(false);
    expect(hashArcade(shoved().state)).toBe(hashArcade(state));
  });

  it('throwHeld flies a physics body through Rapier: up, forward, down to rest', () => {
    const { state, program } = holding(true);
    run(state, program, RIGHT, 10);
    step(state, TAP, program);
    expect(state[HEADER.held]).toBe(0);
    const thrownFrom = at(state, P, 'x');
    const heights: number[] = [];
    run(state, program, NO_INPUT, 240, () => heights.push(at(state, K, 'y')));
    expect(Math.max(...heights)).toBeGreaterThan(at(state, P, 'h'));
    expect(Math.abs(at(state, K, 'y'))).toBeLessThanOrEqual(5);
    expect(at(state, K, 'vx')).toBe(0);
    expect(at(state, K, 'x')).toBeGreaterThan(thrownFrom + 1500);
    expect(flag(state, K, FLAG.gravity)).toBe(false);
  });
});
