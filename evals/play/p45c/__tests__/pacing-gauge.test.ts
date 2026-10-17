import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { arcadeWorldOf } from '@/play/arcade/compile';
import { type ArcadeLevel, type BodyInit, type ControlPiece, HEADER, NO_INPUT, type RulePiece } from '@/play/arcade/contract';
import { type ArcadeLibrary, buildWorld } from '@/play/arcade/kernel';
import { assemblyOfCell, liveCells } from '@/play/compose/allowed';
import { compileRecipe } from '@/play/compose/compile';

import { behavioursOf, pressureRun, risingOf } from '../pacing';

/** Hráč stojí; tělo nic nedělá, hrozby hýbe jen jádro (kinematika). */
const still: ControlPiece<Record<string, never>> = { id: 'still', params: z.object({}).strict(), roles: ['player'], cost: () => ({ bodies: 1, rules: 0 }), step: () => undefined };

/** Scénář: v tiku `spawnAt` oživí předlohu 1 (−1 = nikdy), v tiku `loseAt` běh skončí. */
const script: RulePiece<{ spawnAt: number; loseAt: number }> = {
  id: 'script', trigger: 'tick', params: z.object({ spawnAt: z.int(), loseAt: z.int() }).strict(), roles: ['hazard'], cost: () => ({ bodies: 0, rules: 1 }),
  fire: ({ state }, { spawnAt, loseAt }) => {
    const tick = state[HEADER.tick] as number;
    if (tick === loseAt) return [{ kind: 'lose' }];
    return tick === spawnAt ? [{ kind: 'spawn', template: 1, x: 20_000, y: 0, z: 0, vx: 60, vy: 0, vz: 0 }] : [];
  },
};

const library: ArcadeLibrary = {
  controls: { still }, rules: { script }, generators: {},
  bots: { idle: { id: 'idle', params: z.object({}), roles: [], reactionTicks: 0, cost: () => ({ bodies: 0, rules: 0 }), decide: () => NO_INPUT } },
};

const player: BodyInit = { role: 'player', kind: 'player', x: 0, y: 0, z: 0, w: 800, h: 1000, d: 800, solid: false };
const hazard = (extra: Partial<BodyInit>): BodyInit => ({ role: 'hazard', kind: 'hazard', x: 20_000, y: 0, z: 0, w: 800, h: 800, d: 800, solid: false, kinematic: true, vx: 60, ...extra });

function world(level: ArcadeLevel, spawnAt: number) {
  const made = buildWorld({ seed: 1, control: { id: 'still', params: {} }, rules: [{ id: 'script', params: { spawnAt, loseAt: 600 } }], bot: { id: 'idle', params: {} }, level }, library);
  if (!made.ok) throw new Error(made.issues.join('; '));
  return made.world;
}

describe('pacing gauge', () => {
  it('reads steady pressure over the run as not rising', () => {
    const run = pressureRun(world({ bodies: [player, hazard({})], length: 0 }, -1), [], library);
    expect(run.tick).toBe(601);
    expect(run.threatsPerThird[0]).toBeGreaterThan(0);
    expect(Math.abs(run.threatsPerThird[2] - run.threatsPerThird[0])).toBeLessThan(0.05 * run.threatsPerThird[0]);
    expect(risingOf(run.threatsPerThird)).toBe(false);
  });

  it('splits the run it measured into thirds and never counts a template as a live threat', () => {
    // Předloha má rychlost, ale žije až od tiku 450 – poslední třetina běhu 0..600, ne horizontu 90 s.
    const run = pressureRun(world({ bodies: [player, hazard({ template: true })], length: 0, spawnSlots: 1 }, 450), [], library);
    expect(run.countPerThird[0]).toBe(0);
    expect(run.threatsPerThird[0]).toBe(0);
    expect(run.threatsPerThird[1]).toBe(0);
    expect(run.threatsPerThird[2]).toBeGreaterThan(0);
    expect(risingOf(run.threatsPerThird)).toBe(true);
  });

  it('needs the last third at least 15 % above the first', () => {
    expect(risingOf([10, 10, 11.4])).toBe(false);
    expect(risingOf([10, 10, 11.6])).toBe(true);
    expect(risingOf([0, 0, 0])).toBe(false);
  });

  it('finds no behaviour in a world without foes and finds the pursuer in arena escape', () => {
    expect(behavioursOf(world({ bodies: [player, { ...player, role: 'goal', kind: 'finish', x: 5000 }], length: 0 }, -1))).toEqual([]);
    const cell = liveCells().find((live) => live.id === 'arena.escape');
    if (cell === undefined) throw new Error('arena.escape is not live');
    const made = arcadeWorldOf(compileRecipe(assemblyOfCell(cell)), 1);
    if (!made.ok) throw new Error(made.issues.join('; '));
    // Od P45C T12 má přežití vedle pronásledovatele ještě jedno nové chování ze stream `pacing`.
    expect(behavioursOf(made.world)).toContain('pursue');
    expect(behavioursOf(made.world).length).toBe(2);
  });
});
