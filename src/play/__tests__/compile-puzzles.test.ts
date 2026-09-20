/**
 * Adaptéry checkpoint, lock_key, switch nad `checkpoint_race` a `switch_puzzle`
 * (P23-A, T5). Dveře, které se odemknou a už nezamknou, vypadají hotově –
 * proto test drží zpětné zamknutí i pořadí bran.
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

describe('compileSim – checkpoint_race', () => {
  const spec = fixture('checkpoint_race');

  it('certifies passing the five gates in order before the clock runs out', () => {
    for (const seed of [1, 2]) {
      const { sim } = compiled(spec, seed);
      expect(certified(sim), `seed ${seed}`).toBe('CERTIFIED');
      expect(sim.witness.ops.map((op) => op.target)).toEqual(['gate_1', 'gate_2', 'gate_3', 'gate_4', 'gate_5']);
      expect(sim.state.counters.gatesPassed).toEqual({ min: 0, max: 5, init: 0 });
    }
  });

  it('ignores a gate taken out of order and counts each gate once', () => {
    const { sim } = compiled(spec, 3);
    // Brány na diagonále: pohyb jde nejdřív po x, pak po y, takže cesta mezi
    // dvěma branami žádnou třetí neprotne a čítač počítá jen cílené průchody.
    const sockets: Record<string, readonly [number, number]> = { ...sim.sockets, spawn: [0, 0] };
    for (let k = 1; k <= 5; k += 1) sockets[`gate_${k}`] = [k, k];
    const runtime = runtimeOf({ ...sim, sockets });
    run(runtime, [{ tick: 0, actionId: 'moveTo', target: 'gate_2' }], 60);
    expect(slot(runtime, 'c:gatesPassed')).toBe(0);
    run(runtime, [{ tick: 0, actionId: 'moveTo', target: 'gate_1' }], 60);
    expect(slot(runtime, 'c:gatesPassed')).toBe(1);
    run(runtime, [{ tick: 0, actionId: 'moveTo', target: 'gate_2' }, { tick: 60, actionId: 'moveTo', target: 'gate_1' }, { tick: 120, actionId: 'moveTo', target: 'gate_2' }], 180);
    expect(slot(runtime, 'c:gatesPassed')).toBe(2);
    expect(runtime.runState).toBe('running');
  });

  it('loses when the clock ends before the last gate', () => {
    const { sim } = compiled(spec, 1);
    expect(run(runtimeOf(sim), [], 1900)).toBe('lost');
  });
});

describe('compileSim – switch_puzzle', () => {
  const spec = fixture('switch_puzzle');

  it('certifies red + blue and walking through the door', () => {
    const { sim } = compiled(spec, 1);
    expect(certified(sim)).toBe('CERTIFIED');
    expect(sim.witness.ops.map((op) => `${op.actionId}:${op.target}`)).toEqual(['use:red', 'use:blue', 'moveTo:door']);
    expect(sim.entities.door.locked).toBe(true);
  });

  it('unlocks on red + blue and locks back when green joins', () => {
    const { sim } = compiled(spec, 2);
    const runtime = runtimeOf(sim);
    const locked = (): number => slot(runtime, entitySlotId('door', 'locked'));
    expect(locked()).toBe(1);
    run(runtime, [{ tick: 0, actionId: 'use', target: 'red' }, { tick: 2, actionId: 'use', target: 'blue' }], 5);
    expect(locked()).toBe(0);
    run(runtime, [{ tick: 0, actionId: 'use', target: 'green' }], 3);
    expect(locked()).toBe(1);
    // Zpět na red + blue: zelená se vypne a dveře se znovu odemknou.
    run(runtime, [{ tick: 0, actionId: 'use', target: 'green' }], 3);
    expect(locked()).toBe(0);
    expect(runtime.runState).toBe('running');
  });

  it('does not win through a locked door', () => {
    const { sim } = compiled(spec, 3);
    expect(run(runtimeOf(sim), [{ tick: 0, actionId: 'moveTo', target: 'door' }], 80)).toBe('running');
  });
});

describe('compileSim – lock_key', () => {
  const base = fixture('switch_puzzle');
  const spec: GameSpecV1 = {
    ...base,
    roles: [
      base.roles[0],
      { id: 'key', kind: 'key', label: 'brass key', count: 2 },
      { id: 'door', kind: 'door', label: 'vault door', count: 1 },
    ],
    mechanics: [
      { id: 'lock_key', params: { keyRole: 'key', doorRole: 'door', keysNeeded: 2 } },
      { id: 'zone_trigger', params: { role: 'door', when: 'enter', effect: 'win' } },
    ],
    verification: [{ id: 'winnable', kind: 'reachability', assert: { runState: 'won' } }],
  };

  it('needs both keys, once each, before the door opens', () => {
    const { sim } = compiled(spec, 1);
    expect(certified(sim)).toBe('CERTIFIED');
    const runtime = runtimeOf(sim);
    run(runtime, [{ tick: 0, actionId: 'pickup', target: 'key_1' }, { tick: 2, actionId: 'pickup', target: 'key_1' }], 5);
    expect(slot(runtime, 'c:keysHeld')).toBe(1);
    expect(slot(runtime, entitySlotId('door', 'locked'))).toBe(1);
    run(runtime, [{ tick: 0, actionId: 'pickup', target: 'key_2' }], 3);
    expect(slot(runtime, 'c:keysHeld')).toBe(2);
    expect(slot(runtime, entitySlotId('door', 'locked'))).toBe(0);
  });
});
