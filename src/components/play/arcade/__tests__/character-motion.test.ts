/**
 * Pohyb postavy bez klipu (P36C T8). Na snímku vypadá „skoro dobře“ i pohyb,
 * který je špatně – natažení bez dopadu, zásah, který se nakloní jen na jednu
 * stranu, pád, který skončí v půlce –, proto test drží tvar každého pohybu.
 */

import { Group } from 'three';
import { describe, expect, it } from 'vitest';

import { FALL_S, HIT_S, LAND_S, deadFor, fallOf, headingOf, tiltPose, turnToward } from '../characterMotion';
import { type HeldState, poseTick, proceduralPose } from '../RiggedModel';

const STEP = 1 / 60;

/** Přehraje stavy po snímcích 1/60 s a vrátí měřítko a náklon skupiny po každém. */
function play(states: readonly HeldState['state'][], hasClip: (state: string) => boolean): { y: number; x: number; z: number; tiltZ: number }[] {
  const group = new Group();
  let held: HeldState | null = null;
  return states.map((state) => {
    held = poseTick(group, held, state, hasClip, STEP, 1.8);
    return { y: group.scale.y, x: group.scale.x, z: group.scale.z, tiltZ: group.rotation.z };
  });
}

const frames = (state: HeldState['state'], seconds: number): HeldState['state'][] => Array.from({ length: Math.round(seconds / STEP) }, () => state);

describe('character motion without a clip (P36C T8)', () => {
  it('a pet without a jump clip stretches in the air and squashes when it lands', () => {
    const pet = (state: string): boolean => state === 'idle' || state === 'run';
    const shots = play([...frames('run', 0.1), ...frames('jump', 0.3), ...frames('run', LAND_S + 0.05)], pet);
    const air = shots[Math.round(0.2 / STEP)]!;
    expect(air.y).toBeGreaterThan(1.05);
    expect(air.x).toBeLessThan(1);
    const landing = shots[Math.round(0.4 / STEP)]!;
    expect(landing.y).toBeLessThan(0.85);
    expect(landing.x).toBeGreaterThan(1.05);
    // Objem drží: širší o polovinu toho, o co nižší.
    expect(landing.x - 1).toBeCloseTo((1 - landing.y) / 2);
    expect(shots.at(-1)!.y).toBe(1);
  });

  it('a character whose clip plays the jump lands without an extra squash', () => {
    const kenney = (state: string): boolean => state !== 'hit';
    const shots = play([...frames('jump', 0.3), ...frames('run', 0.1)], kenney);
    expect(shots.every((shot) => shot.y === 1)).toBe(true);
  });

  it('a hit recoils, wobbles to both sides and settles', () => {
    const group = new Group();
    const sideways: number[] = [];
    for (let since = 0; since <= HIT_S; since += 0.005) {
      proceduralPose(group, 'hit', since, 1.8);
      sideways.push(group.rotation.z);
    }
    expect(Math.max(...sideways)).toBeGreaterThan(0.1);
    expect(Math.min(...sideways)).toBeLessThan(-0.1);
    proceduralPose(group, 'hit', 0, 1.8);
    expect(group.rotation.x).toBeLessThan(-0.3);
    proceduralPose(group, 'hit', HIT_S, 1.8);
    expect([group.rotation.x, group.rotation.z]).toEqual([0, 0]);
  });

  it('a fall speeds up, bounces once and ends lying on its back and side', () => {
    expect(fallOf(0)).toBe(0);
    // Zrychluje: v půlce času je pod čtvrtinou cesty, ne v půlce.
    expect(fallOf(FALL_S / 2)).toBeLessThan(0.3);
    expect(fallOf(FALL_S)).toBeCloseTo(1);
    const bounce = fallOf(FALL_S + 0.1);
    expect(bounce).toBeLessThan(0.99);
    expect(bounce).toBeGreaterThan(0.85);
    expect(fallOf(2)).toBe(1);
    const group = new Group();
    tiltPose(group, 1, fallOf(2));
    expect(group.rotation.x).toBeCloseTo(-Math.PI / 2);
    // Na bok taky – pád jen dozadu by kamera za zády běžce viděla zkrácený.
    expect(group.rotation.z).toBeGreaterThan(0.3);
  });

  it('a static model wobbles on a hit on top of its run lean', () => {
    const group = new Group();
    tiltPose(group, 0.1, 0, 0.2);
    expect(group.rotation.z).not.toBe(0);
    expect(group.rotation.x).toBeLessThan(0.2);
    tiltPose(group, 1, 0, 0.2);
    expect([group.rotation.x, group.rotation.z]).toEqual([0.2, 0]);
  });

  it('turns towards the motion the short way round, mirrored like the scene', () => {
    expect(headingOf(0, 1)).toBeCloseTo(0);
    // Jádro +x je ve scéně −x.
    expect(headingOf(1, 0)).toBeCloseTo(-Math.PI / 2);
    expect(Math.abs(headingOf(0, -1))).toBeCloseTo(Math.PI);
    // Z 3 rad k −3 rad přes ±π (0,28 rad), ne zpátky přes nulu (6 rad).
    expect(turnToward(3, -3, 0.5)).toBeGreaterThan(3);
    expect(turnToward(undefined, 1.2, 0.1)).toBe(1.2);
  });

  it('times the fall from the tick of death and forgets it on a restart', () => {
    const memory = new Map<number, number>();
    expect(deadFor(memory, 0, true, 10, 60)).toBe(0);
    expect(deadFor(memory, 0, false, 100, 60)).toBe(0);
    expect(deadFor(memory, 0, false, 130, 60)).toBeCloseTo(0.5);
    expect(deadFor(memory, 0, true, 0, 60)).toBe(0);
    expect(deadFor(memory, 0, false, 40, 60)).toBe(0);
  });
});
