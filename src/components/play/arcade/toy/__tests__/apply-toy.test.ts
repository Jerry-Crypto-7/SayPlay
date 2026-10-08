/**
 * Hračková póza na skutečných `Object3D` (P45D T5). Zbytkový náklon po odeznění
 * zásahu vypadá jako póza, a přitom postava zůstane křivá – proto se klid
 * kontroluje přesně, ne „skoro nula“.
 */

import { Group } from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { type ToyPose, type ToyView, toyPoseOf } from '@/play/arcade/toy-motion';

import { type ToyDeform, type ToyPart, applyToy, toyMotionOn } from '../applyToy';
import { bodyClassOf } from '../body-class';

const view = (over: Partial<ToyView> = {}): ToyView => ({
  vx: 0, vy: 0, vz: 0, grounded: true, alive: true, hit: false, shot: false,
  won: false, carrying: false, attack: false, turn: 0, opened: false, ...over,
});
const poseAt = (v: ToyView, ticks = 0): ToyPose => {
  let pose = toyPoseOf(view(), 'biped', null, 0, false);
  pose = toyPoseOf(v, 'biped', pose, 1, false);
  for (let tick = 2; tick < 2 + ticks; tick += 1) pose = toyPoseOf(view({ opened: v.opened }), 'biped', pose, tick, false);
  return pose;
};
const REST = poseAt(view());

function expectAtRest(group: Group): void {
  expect(group.position.toArray()).toEqual([0, 0, 0]);
  expect([group.rotation.x, group.rotation.y, group.rotation.z].map((value) => value + 0)).toEqual([0, 0, 0]);
  expect(group.scale.toArray()).toEqual([1, 1, 1]);
  expect(group.visible).toBe(true);
}

function stubPage(search: string, reduce: boolean): void {
  vi.stubGlobal('window', { location: { search }, matchMedia: () => ({ matches: reduce }) });
}

afterEach(() => vi.unstubAllGlobals());

describe('applyToy – hračková póza na skupinu modelu', () => {
  it('nulová póza nechá skupinu přesně v klidu', () => {
    stubPage('', false);
    const group = new Group();
    applyToy({ group }, REST, 1.8);
    expectAtRest(group);
  });

  it('po zásahu a jeho odeznění nezůstane žádný náklon', () => {
    stubPage('', false);
    const group = new Group();
    applyToy({ group }, poseAt(view({ hit: true }), 3), 1.8);
    expect(Math.abs(group.rotation.x) + Math.abs(group.rotation.z)).toBeGreaterThan(0.1);
    applyToy({ group }, poseAt(view({ hit: true }), 60), 1.8);
    expectAtRest(group);
  });

  it('poskok, výpad, náklon a pád jdou na polohu a natočení skupiny', () => {
    stubPage('', false);
    const group = new Group();
    const pose = { ...REST, hop: 0.1, lunge: 0.2, pitch: 0.15, roll: -0.1, yaw: 0.5, squash: 0.2 };
    applyToy({ group }, pose, 2);
    expect(group.position.y).toBeCloseTo(0.2);
    expect(group.position.z).toBeCloseTo(0.4);
    expect(group.rotation.x).toBeCloseTo(0.15);
    expect(group.rotation.z).toBeCloseTo(-0.1);
    expect(group.rotation.y).toBeCloseTo(0.5);
    expect(group.scale.y).toBeCloseTo(0.8);
    applyToy({ group }, { ...REST, fall: 1 }, 2);
    expect(group.rotation.x).toBeCloseTo(-Math.PI / 2);
  });

  it('oslava zvedne skupinu nad zem', () => {
    stubPage('', false);
    const group = new Group();
    applyToy({ group }, { ...REST, cheer: 1 }, 2);
    expect(group.position.y).toBeGreaterThan(0.2);
  });

  it('omezený pohyb: zásah blikne bez cuknutí', () => {
    stubPage('', true);
    const group = new Group();
    const hit = toyPoseOf(view({ hit: true }), 'biped', null, 0, !toyMotionOn());
    applyToy({ group }, hit, 1.8);
    expect([group.rotation.x, group.rotation.z].map((value) => value + 0)).toEqual([0, 0]);
    expect(hit.flash).toBe(1);
  });

  it('díly se otáčí kolem pivotu podle role a nulová póza je vrátí', () => {
    stubPage('', false);
    const parts: ToyPart[] = (['door', 'lid', 'wheel', 'wing', 'leg', 'tail'] as const).map((role) => ({ pivot: new Group(), role, side: -1 }));
    const [door, lid, wheel, wing, leg, tail] = parts.map((part) => part.pivot) as Group[];
    applyToy({ group: new Group(), parts }, { ...REST, open: 1, wheel: 1.2, flap: 1, stride: 1, sway: 0.5 }, 1);
    expect(Math.abs(door!.rotation.y)).toBeGreaterThan(1);
    expect(Math.abs(lid!.rotation.x)).toBeGreaterThan(1);
    expect(wheel!.rotation.x).toBeCloseTo(1.2);
    expect(Math.abs(wing!.rotation.z)).toBeGreaterThan(0.3);
    expect(Math.abs(leg!.rotation.x)).toBeGreaterThan(0.2);
    expect(Math.abs(tail!.rotation.y)).toBeGreaterThan(0.2);
    applyToy({ group: new Group(), parts }, REST, 1);
    for (const { pivot } of parts) expect([pivot.rotation.x, pivot.rotation.y, pivot.rotation.z].map((value) => value + 0)).toEqual([0, 0, 0]);
  });

  it('křídla na opačných stranách mávají zrcadlově', () => {
    stubPage('', false);
    const left = { pivot: new Group(), role: 'wing', side: -1 };
    const right = { pivot: new Group(), role: 'wing', side: 1 };
    applyToy({ group: new Group(), parts: [left, right] }, { ...REST, flap: 1 }, 1);
    expect(left.pivot.rotation.z).toBeCloseTo(-right.pivot.rotation.z);
  });

  it('deformace dostane mávnutí, vlnění a krok', () => {
    stubPage('', false);
    const deform: ToyDeform = { toyFlap: { value: 0 }, toySway: { value: 0 }, toyStride: { value: 0 } };
    applyToy({ group: new Group(), deform }, { ...REST, flap: 0.7, sway: -0.4, stride: 0.3 }, 1);
    expect([deform.toyFlap.value, deform.toySway.value, deform.toyStride.value]).toEqual([0.7, -0.4, 0.3]);
  });

  it('?toy=off nechá skupinu, díly i deformaci beze změny', () => {
    stubPage('?toy=off', false);
    const group = new Group();
    group.position.set(1, 2, 3);
    group.rotation.set(0.1, 0.2, 0.3);
    const door = { pivot: new Group(), role: 'door', side: 1 };
    const deform: ToyDeform = { toyFlap: { value: 0 }, toySway: { value: 0 }, toyStride: { value: 0 } };
    applyToy({ group, parts: [door], deform }, { ...REST, hop: 0.2, open: 1, flap: 1, flash: 0.5 }, 2);
    expect(group.position.toArray()).toEqual([1, 2, 3]);
    expect([group.rotation.x, group.rotation.y, group.rotation.z]).toEqual([0.1, 0.2, 0.3]);
    expect(group.visible).toBe(true);
    expect(door.pivot.rotation.y).toBe(0);
    expect(deform.toyFlap.value).toBe(0);
  });

  it('jediný vypínač: pohyb jen bez prefers-reduced-motion a bez ?toy=off', () => {
    stubPage('', false);
    expect(toyMotionOn()).toBe(true);
    stubPage('?toy=off', false);
    expect(toyMotionOn()).toBe(false);
    stubPage('?seed=1', true);
    expect(toyMotionOn()).toBe(false);
  });
});

describe('bodyClassOf – třída těla modelu scény', () => {
  it('katalog podle catalog-motion.json, riggované podle manifestu, primitiv ptáček létá', () => {
    expect(bodyClassOf('race-car')).toBe('vehicle');
    expect(bodyClassOf('dog')).toBe('quadruped');
    expect(bodyClassOf('cc0-shark')).toBe('swimmer');
    expect(bodyClassOf('panel-door')).toBe('prop');
    expect(bodyClassOf('explorer')).toBe('biped');
    expect(bodyClassOf('rigged:knight')).toBe('biped');
    expect(bodyClassOf('rigged:skeleton-mage')).toBe('biped');
    expect(bodyClassOf('rigged:pet-dog')).toBe('quadruped');
    expect(bodyClassOf('rigged:pet-penguin')).toBe('flyer');
    expect(bodyClassOf('bird')).toBe('flyer');
    expect(bodyClassOf('no-such-model')).toBe('prop');
  });
});
