import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { type BodyInit, BODY, type ControlPiece, HEADER, NO_INPUT, type RulePiece, UNIT, bodyBase } from '@/play/arcade/contract';
import { type ArcadeLibrary, buildWorld } from '@/play/arcade/kernel';

import { segmentOf, segmentRun } from '../segments';

const LENGTH = 1000 * UNIT;

/** Hráč jede vpřed rychlostí svého úseku (`speeds[segmentOf(postup)]`), jinak nic. */
const run: ControlPiece<{ speeds: number[] }> = {
  id: 'run', params: z.object({ speeds: z.array(z.int()).length(4) }).strict(), roles: ['player'], cost: () => ({ bodies: 1, rules: 0 }),
  step: (state, player, _input, { speeds }) => {
    const base = bodyBase(player);
    const permille = Math.floor(((state[base + BODY.z] as number) * 1000) / LENGTH);
    state[base + BODY.z] = (state[base + BODY.z] as number) + (speeds[segmentOf(permille)] as number);
  },
};

/** Výhra na konci trati. */
const finish: RulePiece<Record<string, never>> = {
  id: 'finish', trigger: 'tick', params: z.object({}).strict(), roles: [], cost: () => ({ bodies: 0, rules: 1 }),
  fire: ({ state, player }) => ((state[bodyBase(player) + BODY.z] as number) >= LENGTH ? [{ kind: 'win' }] : []),
};

const library: ArcadeLibrary = {
  controls: { run }, rules: { finish }, generators: {},
  bots: { idle: { id: 'idle', params: z.object({}), roles: [], reactionTicks: 0, cost: () => ({ bodies: 0, rules: 0 }), decide: () => NO_INPUT } },
};

const player: BodyInit = { role: 'player', kind: 'player', x: 0, y: 0, z: 0, w: 800, h: 1000, d: 800, solid: false };
/** Stojící past každých 20 m po celé trati; `kind` od `swapAt` m jiný model (jen vzhled). */
const rocks = (swapAt = Infinity): BodyInit[] =>
  Array.from({ length: 50 }, (_, i) => ({ role: 'hazard', kind: i * 20 >= swapAt ? 'crate' : 'rock', x: 3000, y: 0, z: (i * 20 + 10) * UNIT, w: 800, h: 800, d: 800, solid: false }));
/** Nepřítel, který se hýbe napříč (nové chování), každých 60 m od `from` m. */
const drifters = (from: number): BodyInit[] =>
  Array.from({ length: Math.floor((1000 - from) / 60) }, (_, i) => ({ role: 'hazard', kind: 'bee', x: -3000, y: 0, z: (from + i * 60) * UNIT, w: 800, h: 800, d: 800, solid: false, kinematic: true, vx: 30 }));

function world(bodies: readonly BodyInit[], speeds: readonly number[] = [300, 300, 300, 300]) {
  const made = buildWorld({ seed: 1, control: { id: 'run', params: { speeds: [...speeds] } }, rules: [{ id: 'finish', params: {} }], bot: { id: 'idle', params: {} }, level: { bodies: [player, ...bodies], length: LENGTH } }, library);
  if (!made.ok) throw new Error(made.issues.join('; '));
  return made.world;
}

describe('segment gauge', () => {
  it('counts nothing when every segment has the same foes at the same speed', () => {
    const measured = segmentRun(world(rocks()), [], library);
    expect(measured.outcome).toBe('won');
    expect(measured.segments.every((segment) => segment.ticks > 0)).toBe(true);
    expect(measured.segments.map((segment) => segment.foes)).toEqual([['hazard:static'], ['hazard:static'], ['hazard:static'], ['hazard:static']]);
    expect(measured.changes).toEqual([[], []]);
    expect(measured.segmentChanges).toBe(0);
  });

  it('counts a new behaviour in segment 2 once, not again in segment 3', () => {
    const measured = segmentRun(world([...rocks(), ...drifters(300)]), [], library);
    expect(measured.changes[0]).toEqual(['foe:hazard:roam']);
    expect(measured.changes[1]).toEqual([]);
    expect(measured.segmentChanges).toBe(1);
  });

  it('never counts a new look of the same foe as a change', () => {
    const measured = segmentRun(world(rocks(300)), [], library);
    expect(measured.segmentChanges).toBe(0);
  });

  it('counts a denser segment but never a sparser one', () => {
    // Úsek 2 (od 240 m, kam dohlédne rozjezd) má každou druhou past navíc posunutou o 10 m: dvojnásobná hustota.
    const denser = [...rocks(), ...rocks().filter((rock) => rock.z >= 240 * UNIT).map((rock) => ({ ...rock, z: rock.z + 10 * UNIT }))];
    expect(segmentRun(world(denser), [], library).changes[0]).toEqual([expect.stringMatching(/^density:/)]);
    const sparser = rocks().filter((rock, index) => rock.z < 240 * UNIT || index % 2 === 0);
    expect(segmentRun(world(sparser), [], library).segmentChanges).toBe(0);
  });

  it('counts a speed step of at least 10 % in both segments', () => {
    const measured = segmentRun(world(rocks(), [300, 360, 420, 420]), [], library);
    expect(measured.changes.map((list) => list.filter((change) => change.startsWith('speed:')))).toEqual([['speed:18->21.6'], ['speed:21.6->25.2']]);
    expect(measured.segmentChanges).toBe(2);
    // Pod krokem 10 % rychlost není změna, zpomalení taky ne.
    expect(segmentRun(world(rocks(), [300, 320, 340, 340]), [], library).segmentChanges).toBe(0);
    expect(segmentRun(world(rocks(), [300, 240, 200, 200]), [], library).segmentChanges).toBe(0);
  });

  it('reads the run it replays: the hash at the end is the replay hash', () => {
    const made = world(rocks());
    expect(segmentRun(made, [], library).hash).toBe(segmentRun(made, [], library).hash);
    expect(made.initial[HEADER.bodyCount]).toBe(51);
  });
});
