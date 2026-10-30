/**
 * Střelba a hod vidět (P43 T5): záblesk u hrdiny v tiku, kdy jádro vypustilo
 * střelu, a stopa za každou letící střelou. Bez vypuštěné střely nic.
 * Životnost se měří v ticích simulace, takže ji vidí i klip robota krokovaný ručně.
 */

import { type ReactElement, type ReactNode, isValidElement } from 'react';
import { PerspectiveCamera } from 'three';
import { describe, expect, it, vi } from 'vitest';

import { BODY, FLAG, HEADER, ROLE, UNIT, bodyBase } from '@/play/arcade/contract';
import { LOOKS } from '@/play/arcade/look';

import type { ArcadeSession } from '../../session';
import { ShooterRig } from '../../shooter/ShooterRig';
import { ThrowRig } from '../../throw/ThrowRig';
import { cuesOf, heroActionOf } from '../cues';
import { FLASH_RADIUS, FLASH_TICKS, MUZZLE, ShootThrowFx, projectileSpawns, shootThrowFrame } from '../ShootThrowFx';

vi.mock('react', async (importOriginal) => {
  const react = await importOriginal<typeof import('react')>();
  // `useContext`: hrací obdélník na výšku (`usePlayRectRef`, P64) mimo plátno nezměřený.
  return { ...react, useMemo: (make: () => unknown) => make(), useRef: (current: unknown) => ({ current }), useEffect: () => undefined, useContext: () => ({ current: null }) };
});
vi.mock('@react-three/fiber', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@react-three/fiber')>()),
  useFrame: () => undefined,
  useThree: (select: (three: { camera: PerspectiveCamera }) => unknown) => select({ camera: new PerspectiveCamera() }),
}));

const PLAYER = 0;
const BULLET = 2;

/** Stav se hrdinou (tělo 0), terčem (1) a střelou (2), která letí, když `flying`. */
function stateWith(flying: boolean, tick = 100): Int32Array {
  const state = new Int32Array(bodyBase(3));
  state[HEADER.bodyCount] = 3;
  state[HEADER.player] = PLAYER;
  state[HEADER.tick] = tick;
  const put = (body: number, role: number, alive: boolean, x: number, z: number, vz = 0) => {
    const base = bodyBase(body);
    state[base + BODY.role] = role;
    state[base + BODY.flags] = alive ? FLAG.alive : 0;
    state[base + BODY.x] = x * UNIT;
    state[base + BODY.z] = z * UNIT;
    state[base + BODY.vz] = vz * UNIT;
    state[base + BODY.w] = state[base + BODY.h] = state[base + BODY.d] = UNIT / 4;
  };
  put(PLAYER, ROLE.player, true, 1, 0);
  put(1, ROLE.target, true, 0, 20);
  put(BULLET, ROLE.projectile, flying, 1, 1, 0.5);
  return state;
}

describe('shoot and throw cues', () => {
  it('a newly launched projectile is a shoot cue at its launch point, back-dated to the launch tick, once', () => {
    const known = new Set<number>();
    const spawns = projectileSpawns(stateWith(true), known);
    // 1 m from the hero at 0.5 m per tick: launched 2 ticks ago from the hero; the muzzle is MUZZLE m along the shot.
    expect(cuesOf(['shoot'], spawns, PLAYER)).toEqual([{ verb: 'shoot', at: 98, target: BULLET, x: 1, y: 0, z: MUZZLE }]);
    expect(projectileSpawns(stateWith(true, 101), known)).toEqual([]);
    // Spawned elsewhere: a stack cue, never a shot.
    expect(cuesOf(['stack'], spawns, PLAYER)).toEqual([]);
  });

  it('a projectile first seen far into its flight is no launch (the hand-stepped clip skips ticks)', () => {
    const state = stateWith(true);
    state[bodyBase(BULLET) + BODY.z] = 20 * UNIT; // 40 ticks of flight
    const known = new Set<number>();
    expect(projectileSpawns(state, known)).toEqual([]);
    expect(known.has(BULLET)).toBe(true);
    expect(shootThrowFrame([], state).trails).toHaveLength(1);
  });

  it('draws a small flash just ahead of the hero for FLASH_TICKS ticks and a trail behind the flying projectile', () => {
    const cues = cuesOf(['shoot'], projectileSpawns(stateWith(true), new Set()), PLAYER);
    const now = shootThrowFrame(cues, stateWith(true, 101));
    expect(now.flashes).toHaveLength(1);
    // Scene mirrors x like every body (`-x`); the flash sits MUZZLE m along the shot, not on the hero.
    expect(now.flashes[0]!.at[0]).toBe(-1);
    expect(now.flashes[0]!.at[2]).toBeCloseTo(MUZZLE);
    expect(FLASH_RADIUS).toBeLessThanOrEqual(0.5);
    expect(now.trails).toHaveLength(1);
    const [from, to] = [now.trails[0]!.from, now.trails[0]!.to];
    expect(to[2]).toBeGreaterThan(from[2]);
    expect(shootThrowFrame(cues, stateWith(true, 98 + FLASH_TICKS)).flashes).toEqual([]);
  });

  it('draws nothing when nothing was launched', () => {
    const idle = stateWith(false);
    expect(projectileSpawns(idle, new Set())).toEqual([]);
    expect(shootThrowFrame([], idle)).toEqual({ flashes: [], trails: [] });
  });
});

type Element = ReactElement<Record<string, unknown>>;
function findAll(node: ReactNode, type: unknown): Element[] {
  if (Array.isArray(node)) return node.flatMap((child: ReactNode) => findAll(child, type));
  if (!isValidElement(node)) return [];
  const element = node as Element;
  return [...(element.type === type ? [element] : []), ...findAll(element.props.children as ReactNode, type)];
}

describe('throw pose', () => {
  it('a throw game holds and pitches the ball unless the sentence gave the hero its own action', () => {
    expect(heroActionOf({ control: 'throw' })).toBe('throw');
    expect(heroActionOf({ control: 'throw', heroAction: 'stir' })).toBe('stir');
    expect(heroActionOf({ control: 'runner' })).toBe('none');
  });
});

describe('rigs mount the effect', () => {
  const session = { state: () => stateWith(false), prev: () => stateWith(false) } as unknown as ArcadeSession;
  const surface = { current: null };
  it('ShooterRig shows shots, ThrowRig shows throws', () => {
    expect(findAll(ShooterRig({ session, surface, enabled: false, heroAction: 'none', look: LOOKS.mall }), ShootThrowFx).map((fx) => fx.props.verb)).toEqual(['shoot']);
    expect(findAll(ThrowRig({ session, surface, enabled: false, heroAction: 'none' }), ShootThrowFx).map((fx) => fx.props.verb)).toEqual(['throw']);
  });
});
