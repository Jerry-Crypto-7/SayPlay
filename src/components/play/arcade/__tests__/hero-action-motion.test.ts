/**
 * Činnost hrdiny (P37B T2): každá hodnota `heroAction` kromě `none` má svou
 * rekvizitu a pohyb, který se v klidu hýbe a při nápřahu se změní. Okem se
 * nepozná, že jedna akce chybí (hrdina by jen stál) – proto test na výčet.
 */

import { describe, expect, it } from 'vitest';

import { HERO_ACTIONS } from '@/play/spec';

import { type ActionPose, BURST_KINDS, HERO_ACTION_MOTION, arc, motionOf, strike } from '../hero-action/actions';

const ACTIONS = HERO_ACTIONS.filter((action) => action !== 'none');
const FIELDS = ['x', 'y', 'z', 'rx', 'ry', 'rz', 'bob', 'pitch', 'roll', 'yaw', 'spill'] as const;
const distance = (a: ActionPose, b: ActionPose): number => FIELDS.reduce((sum, field) => sum + Math.abs(a[field] - b[field]), 0);

describe('hero action motion', () => {
  it('none draws the hero unchanged, every other action has a motion', () => {
    expect(motionOf('none')).toBeNull();
    for (const action of ACTIONS) expect(motionOf(action), action).not.toBeNull();
    expect(Object.keys(HERO_ACTION_MOTION).sort()).toEqual([...ACTIONS].sort());
  });

  it('gives every action its own prop', () => {
    const props = ACTIONS.map((action) => HERO_ACTION_MOTION[action].prop);
    expect(new Set(props).size).toBe(ACTIONS.length);
  });

  it.each(ACTIONS)('%s moves at rest and changes during the burst', (action) => {
    const motion = HERO_ACTION_MOTION[action];
    const times = [0, 0.13, 0.37, 0.71, 1.9];
    for (const t of times) for (const u of [0, 0.2, 0.5, 0.8, 1]) for (const field of FIELDS) expect(Number.isFinite(motion.pose(t, u)[field]), `${action} ${field} t=${String(t)} u=${String(u)}`).toBe(true);
    // Klidová smyčka: póza se v čase mění (bez nápřahu).
    expect(Math.max(...times.map((t) => distance(motion.pose(t, 1), motion.pose(0, 1))))).toBeGreaterThan(0.02);
    // Nápřah: uprostřed se póza liší od klidu v tutéž chvíli.
    expect(Math.max(...[0.3, 0.5, 0.7].map((u) => distance(motion.pose(0.4, u), motion.pose(0.4, 1))))).toBeGreaterThan(0.1);
    expect(motion.hand).toBeGreaterThan(0);
    expect(motion.hand).toBeLessThan(1);
  });

  it('spills only during the burst', () => {
    for (const action of ACTIONS) {
      const motion = HERO_ACTION_MOTION[action];
      for (const t of [0, 0.5, 1.3]) expect(motion.pose(t, 1).spill, action).toBe(0);
      if (motion.spill !== null) expect(Math.max(...[0.3, 0.5, 0.7, 0.9].map((u) => motion.pose(0.4, u).spill)), action).toBeGreaterThan(0);
    }
  });

  it('bursts on what the hero did, not on what happened to it', () => {
    for (const kind of ['score', 'despawn', 'win']) expect(BURST_KINDS.has(kind), kind).toBe(true);
    for (const kind of ['damage', 'lose', 'knockback', 'heal', 'respawn']) expect(BURST_KINDS.has(kind), kind).toBe(false);
  });

  it('keeps the burst curves at rest outside the burst', () => {
    for (const u of [-0.1, 1, 1.5]) {
      expect(arc(u)).toBe(0);
      expect(strike(u)).toBe(0);
    }
    expect(strike(0.3)).toBeCloseTo(-1);
    expect(Math.max(...[0.5, 0.6, 0.7].map(strike))).toBeGreaterThan(0.8);
  });
});
