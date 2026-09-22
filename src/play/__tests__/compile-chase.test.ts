/**
 * Adaptéry chaser, stun, patrol, defeat nad `chase_escape` a `combat_lite`
 * (P23-A, T6). Pronásledovatel, který se nehne, vypadá jako těžký svět –
 * proto test drží, že stojícího hráče chytí, a že ho stun na čas zastaví.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { buildRuntimeWorld } from '@/ir/build';
import { type Runtime, createRuntime, entitySlotId, step } from '@/sim/interpreter';
import { readSlot } from '@/sim/state';
import { verifyWitness } from '@/verify/witness';

import { compileSim, type SimCompilation, type SurfaceSim } from '../compile';
import { readGameSpec, type GameSpecV1 } from '../spec';

const fixturesDir = fileURLToPath(new URL('../__fixtures__/', import.meta.url));

function fixture(name: string): GameSpecV1 {
  const raw = JSON.parse(readFileSync(new URL(`${name}.json`, `file://${fixturesDir.replace(/\\/g, '/')}`), 'utf8'));
  const result = readGameSpec(raw);
  if (!result.ok) throw new Error(`${name}: ${result.reason} ${result.issues.join('; ')}`);
  return result.value;
}

function compiled(spec: GameSpecV1, seed: number): SimCompilation {
  const result = compileSim(spec, seed);
  if (!result.ok) throw new Error(`${spec.title}/${seed}: ${result.reason} ${result.issues.join('; ')}`);
  return result.value;
}

function runtimeOf(sim: SurfaceSim): Runtime {
  const built = buildRuntimeWorld(sim);
  if (!built.ok) throw new Error(built.issues.join('; '));
  return createRuntime(built.world);
}

function certified(sim: SurfaceSim): string {
  const built = buildRuntimeWorld(sim);
  if (!built.ok) return built.issues.join('; ');
  const verdict = verifyWitness(built.world, built.world.trace);
  return verdict.verdict === 'CERTIFIED' ? 'CERTIFIED' : `${verdict.reason}: ${verdict.detail}`;
}

/** Odkrokuje `ticks` tiků; vstupy jdou v tiku, který nesou. */
function run(runtime: Runtime, inputs: readonly { tick: number; actionId: string; target: string }[], ticks: number): string {
  for (let tick = 0; tick < ticks && runtime.runState === 'running'; tick += 1) {
    const due = inputs.filter((input) => input.tick === tick).map((input) => ({ ...input, actor: 'player' }));
    step(runtime, due);
  }
  return runtime.runState;
}

const slot = (runtime: Runtime, id: string): number => readSlot(runtime.layout, runtime.state, id);

/** Roomba o buňku vedle spawnu – „stojí u hráče“. */
function chaserNextToPlayer(sim: SurfaceSim): SurfaceSim {
  const [x, y] = sim.sockets.spawn;
  const beside: readonly [number, number] = x + 1 < sim.layout.width ? [x + 1, y] : [x - 1, y];
  return { ...sim, sockets: { ...sim.sockets, roomba: beside } };
}

describe('compileSim – chase_escape', () => {
  const spec = fixture('chase_escape');

  it('certifies stunning the roomba and running for the exit', () => {
    for (const seed of [1, 2, 3]) {
      const { sim } = compiled(spec, seed);
      expect(certified(sim), `seed ${seed}`).toBe('CERTIFIED');
      expect(sim.witness.ops.map((op) => `${op.actionId}:${op.target}`)).toEqual(['use:roomba', 'moveTo:exit']);
    }
  });

  it('catches a player who stands still within 200 ticks', () => {
    const { sim } = compiled(spec, 1);
    expect(run(runtimeOf(chaserNextToPlayer(sim)), [], 200)).toBe('lost');
  });

  it('gives a player who has not moved yet three seconds before the first catch', () => {
    for (const seed of [1, 2, 3]) {
      const runtime = runtimeOf(chaserNextToPlayer(compiled(spec, seed).sim));
      expect(run(runtime, [], 55), `seed ${seed}`).toBe('running');
      expect(run(runtime, [], 200), `seed ${seed}`).toBe('lost');
    }
  });

  it('keeps running while the roomba is stunned, then catches up', () => {
    const { sim } = compiled(spec, 2);
    const runtime = runtimeOf(chaserNextToPlayer(sim));
    // 4 s = 80 tiků zmrazení; do té doby se nic nestane.
    expect(run(runtime, [{ tick: 0, actionId: 'use', target: 'roomba' }], 75)).toBe('running');
    expect(slot(runtime, 'c:stunsUsed')).toBe(1);
    expect(run(runtime, [], 200)).toBe('lost');
  });

  it('limits the stun to its uses', () => {
    const { sim } = compiled(spec, 3);
    const runtime = runtimeOf(sim);
    const uses = [0, 2, 4, 6].map((tick) => ({ tick, actionId: 'use', target: 'roomba' }));
    run(runtime, uses, 10);
    expect(slot(runtime, 'c:stunsUsed')).toBe(3);
  });

  it('follows the player cell by cell and tracks it in bindings', () => {
    const { sim, mechanics } = compiled(spec, 1);
    const chaser = mechanics.find((m) => m.mechanicId === 'chaser');
    expect(chaser?.ruleIds.length).toBeGreaterThanOrEqual(sim.layout.width * sim.layout.height);
    // Hráč dojde k vozíku a stojí; roomba, která startovala jinde, ho tam dožene.
    const far = { ...sim, sockets: { ...sim.sockets, roomba: sim.sockets.exit } };
    expect(run(runtimeOf(far), [{ tick: 0, actionId: 'moveTo', target: 'cart_1' }], 400)).toBe('lost');
  });
});

describe('compileSim – combat_lite', () => {
  const spec = fixture('combat_lite');

  it('certifies five hits and removes each slime once', () => {
    for (const seed of [1, 2]) {
      const { sim } = compiled(spec, seed);
      expect(certified(sim), `seed ${seed}`).toBe('CERTIFIED');
      expect(sim.witness.ops.filter((op) => op.actionId === 'use')).toHaveLength(5);
    }
    const runtime = runtimeOf(compiled(spec, 1).sim);
    run(runtime, [{ tick: 0, actionId: 'use', target: 'slime_1' }, { tick: 3, actionId: 'use', target: 'slime_1' }], 8);
    expect(slot(runtime, 'c:defeated')).toBe(1);
    expect(slot(runtime, entitySlotId('slime_1', 'active'))).toBe(0);
    expect(runtime.runState).toBe('running');
  });

  it('wins on the fifth slime', () => {
    const runtime = runtimeOf(compiled(spec, 2).sim);
    const hits = [1, 2, 3, 4, 5].map((k) => ({ tick: k * 3, actionId: 'use', target: `slime_${k}` }));
    expect(run(runtime, hits, 40)).toBe('won');
  });
});

describe('compileSim – patrol', () => {
  const base = fixture('chase_escape');
  const spec: GameSpecV1 = {
    ...base,
    roles: [base.roles[0], { id: 'waiter', kind: 'patrol', label: 'waiter', count: 1 }, { id: 'exit', kind: 'exit', label: 'door', count: 1 }],
    mechanics: [
      { id: 'patrol', params: { role: 'waiter', disposition: 'bold', stops: 3, touchEffect: 'lose' } },
      { id: 'zone_trigger', params: { role: 'exit', when: 'enter', effect: 'win' } },
    ],
  };

  it('gives the patrol a mind over three stop sockets and a touch rule', () => {
    const { sim, mechanics } = compiled(spec, 1);
    expect(sim.state.agents).toEqual([{ id: 'waiter', disposition: 'bold', goals: ['waiter_stop1', 'waiter_stop2', 'waiter_stop3'] }]);
    for (const goal of ['waiter_stop1', 'waiter_stop2', 'waiter_stop3']) expect(sim.sockets[goal]).toBeDefined();
    expect(mechanics.find((m) => m.mechanicId === 'patrol')?.ruleIds).toContain('patrol.waiter.touch');
  });

  it('walks its route without a fault when touching does nothing', () => {
    const harmless: GameSpecV1 = { ...spec, mechanics: [{ id: 'patrol', params: { role: 'waiter', disposition: 'restless', stops: 3, touchEffect: 'none' } }, spec.mechanics[1]] };
    const { sim, mechanics } = compiled(harmless, 2);
    expect(mechanics.find((m) => m.mechanicId === 'patrol')?.ruleIds).toEqual([]);
    const runtime = runtimeOf(sim);
    expect(run(runtime, [], 100)).toBe('running');
    expect(runtime.fault).toBeNull();
  });
});
