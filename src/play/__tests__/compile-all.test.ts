/**
 * Adaptéry carry, property_transform, spawn_wave a kompilace všech osmi
 * archetypů (P23-A, T7). Osm světů se postaví i s adaptérem, který tiše nic
 * nevydá – proto test drží počet adaptérů, certifikaci každého světa a u
 * každého nového adaptéru jeho vlastní kauzální krok.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { buildRuntimeWorld } from '@/ir/build';
import { type Runtime, createRuntime, entityPlacements, entitySlotId, step } from '@/sim/interpreter';
import { readSlot } from '@/sim/state';
import { verifyWitness } from '@/verify/witness';

import { compileGame, compileSim, type SimCompilation, type SurfaceSim } from '../compile';
import { draftGameSpec } from '../draft';
import { ADAPTERS } from '../compile/adapters';
import { TICKS_PER_SECOND } from '../compile/adapters/timer';
import { ARCHETYPE_IDS, MECHANIC_IDS } from '../registry';
import { verifyGame } from '../verify';
import { readGameSpec, type GameSpecV1 } from '../spec';

const fixturesDir = fileURLToPath(new URL('../__fixtures__/', import.meta.url));

function fixture(name: string): GameSpecV1 {
  const raw = JSON.parse(readFileSync(new URL(`${name}.json`, `file://${fixturesDir.replace(/\\/g, '/')}`), 'utf8'));
  return spec(raw, name);
}

function spec(raw: unknown, name: string): GameSpecV1 {
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

const placement = (runtime: Runtime, id: string) => entityPlacements(runtime).find((entity) => entity.stableId === id);
const slot = (runtime: Runtime, id: string): number => readSlot(runtime.layout, runtime.state, id);

/** Fixtura s mechanikou navíc; koření (`SPICE`) má každý archetyp povolené. */
function rawWithMechanic(base: string, mechanic: { id: string; params: Record<string, unknown> }): Record<string, unknown> {
  const raw = JSON.parse(readFileSync(new URL(`${base}.json`, `file://${fixturesDir.replace(/\\/g, '/')}`), 'utf8')) as Record<string, unknown>;
  return { ...raw, mechanics: [...(raw.mechanics as unknown[]), mechanic] };
}

function withMechanic(base: string, mechanic: { id: string; params: Record<string, unknown> }): GameSpecV1 {
  return spec(rawWithMechanic(base, mechanic), `${base}+${mechanic.id}`);
}

describe('compileSim – every archetype', () => {
  it('has a compile adapter for all 16 mechanics', () => {
    expect(MECHANIC_IDS).toHaveLength(16);
    expect(MECHANIC_IDS.filter((id) => ADAPTERS[id] === null)).toEqual([]);
  });

  it('compiles and certifies the eight fixtures over seeds 1..3', () => {
    const results: string[] = [];
    for (const archetype of ARCHETYPE_IDS) {
      const gameSpec = fixture(archetype);
      for (const seed of [1, 2, 3]) {
        const { sim } = compiled(gameSpec, seed);
        results.push(`${archetype}/${seed}: ${certified(sim)}`);
      }
    }
    expect(results).toHaveLength(24);
    const solved = results.filter((line) => line.endsWith('CERTIFIED'));
    // Pin naměřeného počtu (20. 9. 2026), ne dolní strop z AC (22).
    expect(solved.length, results.join('\n')).toBeGreaterThanOrEqual(24);
  });
});

describe('compileSim – delivery (carry)', () => {
  const gameSpec = fixture('delivery');

  it('certifies picking up the cake and walking it to the table', () => {
    for (const seed of [1, 2, 3]) {
      const { sim } = compiled(gameSpec, seed);
      expect(certified(sim), `seed ${seed}`).toBe('CERTIFIED');
      expect(sim.witness.ops.map((op) => `${op.actionId}:${op.target}`)).toEqual(['pickup:cake', 'moveTo:table']);
      expect(sim.state.slots).toBe(1);
    }
  });

  it('wins when the cake is picked up while already standing at the table', () => {
    const { sim } = compiled(gameSpec, 1);
    const runtime = runtimeOf({ ...sim, sockets: { ...sim.sockets, spawn: sim.sockets.table as readonly [number, number] } });
    expect(run(runtime, [{ tick: 0, actionId: 'pickup', target: 'cake' }], 40)).toBe('won');
  });

  it('does not win at the table without the cake', () => {
    const { sim } = compiled(gameSpec, 1);
    // Bez číšníka: test je o doručení, dotyk hlídky na trase by ho prohrál jinak.
    const rules = Object.fromEntries(Object.entries(sim.rules).filter(([id]) => !id.startsWith('patrol.')));
    const runtime = runtimeOf({ ...sim, rules, state: { ...sim.state, agents: [] } });
    expect(run(runtime, [{ tick: 0, actionId: 'moveTo', target: 'table' }], 80)).toBe('running');
  });

  it('loses when the waiter touches a chef carrying the fragile cake', () => {
    const { sim } = compiled(gameSpec, 1);
    // Číšník stojí bez mysli krok před stolem (cesta jde po x, pak po y):
    // `onCollide` je hrana, takže dotyk vznikne až příchodem šéfkuchaře, a jen
    // nesený dort rozhodne, jestli to prohraje.
    const [sx, sy] = sim.sockets.spawn as readonly [number, number];
    const [tx, ty] = sim.sockets.table as readonly [number, number];
    const beforeTable: readonly [number, number] = ty !== sy ? [tx, ty - Math.sign(ty - sy)] : [tx - Math.sign(tx - sx), sy];
    const sockets = { ...sim.sockets, waiter: beforeTable };
    const state = { ...sim.state, agents: [] };
    const rules = Object.fromEntries(Object.entries(sim.rules).filter(([id]) => !id.startsWith('patrol.')));
    const walk = { tick: 1, actionId: 'moveTo', target: 'table' };
    const held = runtimeOf({ ...sim, sockets, state, rules });
    expect(run(held, [{ tick: 0, actionId: 'pickup', target: 'cake' }, walk], 80)).toBe('lost');
    const empty = runtimeOf({ ...sim, sockets, state, rules });
    expect(run(empty, [walk], 80)).toBe('running');
  });
});

describe('compileGame – waiting witness (R6)', () => {
  it('the fragile cake that lost to the waiter at tick 6 on seed 1964188670 now wins by waiting', () => {
    const result = compileGame(draftGameSpec('Carry a fragile cake across a kitchen to a party table.'), 1964188670);
    expect(result.ok).toBe(true);
  });
});

describe('draft – enemies in collect_exit (P25B T2)', () => {
  const ghosts = 'A knight must collect three keys in a haunted castle while dodging ghosts.';

  it('keeps the dodged ghosts as a patrol whose touch loses, and the game still verifies', () => {
    const gameSpec = draftGameSpec(ghosts);
    expect(gameSpec.archetype).toBe('collect_exit');
    expect(gameSpec.roles.find((role) => role.id === 'enemy')).toMatchObject({ kind: 'patrol', label: 'ghost', count: 2 });
    expect(gameSpec.tutorial.goalLine).toMatch(/Avoid the ghosts\.$/);
    for (const seed of [1, 2, 3]) {
      const result = compileGame(gameSpec, seed);
      if (!result.ok) throw new Error(`seed ${seed}: ${result.reason} ${result.issues.join('; ')}`);
      const report = verifyGame(result.value);
      expect(report.keypoints.filter((keypoint) => !keypoint.passed), `seed ${seed}`).toEqual([]);
      expect(report.publishEligible, `seed ${seed}`).toBe(true);
    }
  });

  it('turns a hunting enemy into a chaser, and a dodged hazard stays out of the roles', () => {
    const hunted = draftGameSpec('Collect five coins while a goblin hunts you.');
    expect(hunted.roles.find((role) => role.id === 'enemy')).toMatchObject({ kind: 'chaser', label: 'goblin', count: 1 });
    expect(hunted.mechanics.map((mechanic) => mechanic.id)).toContain('chaser');
    expect(readGameSpec(hunted).ok).toBe(true);
    expect(draftGameSpec('Collect five coins and avoid the lava.').roles.some((role) => role.id === 'enemy')).toBe(false);
  });
});

describe('compileSim – property_transform', () => {
  it('flips the state on use once, from the declared state only', () => {
    const gameSpec = withMechanic('collect_exit', { id: 'property_transform', params: { role: 'portal', from: 'open', to: 'sealed', trigger: 'use' } });
    const { sim } = compiled(gameSpec, 1);
    const runtime = runtimeOf(sim);
    expect(placement(runtime, 'portal')?.state).toBe('open');
    run(runtime, [{ tick: 0, actionId: 'use', target: 'portal' }], 2);
    expect(placement(runtime, 'portal')?.state).toBe('sealed');
    expect(Object.keys(sim.rules).filter((id) => id.startsWith('property_transform.'))).toEqual(['property_transform.portal']);
  });

  it('flips the state when the transform timer ends', () => {
    const gameSpec = withMechanic('collect_exit', { id: 'property_transform', params: { role: 'portal', from: 'open', to: 'sealed', trigger: 'timer' } });
    const { sim } = compiled(gameSpec, 1);
    const ticks = sim.state.timers.portal_transform?.durationTicks ?? 0;
    expect(ticks).toBeGreaterThan(0);
    const runtime = runtimeOf(sim);
    run(runtime, [], ticks);
    expect(placement(runtime, 'portal')?.state).toBe('open');
    run(runtime, [], 2);
    expect(placement(runtime, 'portal')?.state).toBe('sealed');
  });

  it('times the transform by afterSeconds, 10 s when omitted', () => {
    const params = { role: 'portal', from: 'open', to: 'sealed', trigger: 'timer' } as const;
    const ticksOf = (extra: object): number | undefined =>
      compiled(withMechanic('collect_exit', { id: 'property_transform', params: { ...params, ...extra } }), 1).sim.state.timers.portal_transform?.durationTicks;
    expect(ticksOf({})).toBe(10 * TICKS_PER_SECOND);
    expect(ticksOf({ afterSeconds: 3 })).toBe(3 * TICKS_PER_SECOND);
  });

  it('rejects a from state the role never reaches, accepts one another mechanic sets', () => {
    const dead = readGameSpec(rawWithMechanic('collect_exit', { id: 'property_transform', params: { role: 'portal', from: 'closed', to: 'sealed', trigger: 'use' } }));
    expect(dead.ok).toBe(false);
    if (!dead.ok) {
      expect(dead.reason).toBe('MECHANIC_REJECTED');
      expect(dead.issues.join('\n')).toContain('/params/from: role portal is never in state closed');
    }
    // Spínač začíná `off`, `on` mu nastaví mechanika `switch`.
    const setByAnother = rawWithMechanic('switch_puzzle', { id: 'property_transform', params: { role: 'red', from: 'on', to: 'jammed', trigger: 'use' } });
    expect(readGameSpec(setByAnother).ok).toBe(true);
  });

  it('flips the state on the named signal, or on <role>Triggered without a name', () => {
    const named = withMechanic('collect_exit', {
      id: 'property_transform',
      params: { role: 'portal', from: 'open', to: 'sealed', trigger: 'signal', signal: 'collectedFull' },
    });
    const { sim } = compiled(named, 1);
    expect(sim.rules['property_transform.portal']?.event).toEqual({ kind: 'onSignal', name: 'collectedFull' });
    const runtime = runtimeOf(sim);
    // Sběr všech pěti hub vyšle `collectedFull`; signál se doručí tik po vyslání.
    run(runtime, [1, 2, 3, 4, 5].map((k) => ({ tick: 0, actionId: 'pickup', target: `mushroom_${k}` })), 4);
    expect(placement(runtime, 'portal')?.state).toBe('sealed');

    const unnamed = withMechanic('collect_exit', { id: 'property_transform', params: { role: 'portal', from: 'open', to: 'sealed', trigger: 'signal' } });
    expect(compiled(unnamed, 1).sim.rules['property_transform.portal']?.event).toEqual({ kind: 'onSignal', name: 'portalTriggered' });
  });
});

describe('compileSim – spawn_wave', () => {
  const gameSpec = withMechanic('combat_lite', { id: 'spawn_wave', params: { role: 'slime', poolSize: 5, everySeconds: 3, maxAlive: 5 } });

  it('declares the pool, the arena and the wave timer', () => {
    const { sim } = compiled(gameSpec, 1);
    expect(sim.state.pool.slime).toEqual({ size: 5, tag: 'slime' });
    expect(sim.state.zones.slime_arena).toEqual([[0, 0, sim.layout.width, sim.layout.height]]);
    expect(sim.state.timers.slime_wave?.durationTicks).toBe(60);
    expect(certified(sim)).toBe('CERTIFIED');
  });

  it('revives a knocked-out slime at the nest on the next wave, but not above maxAlive', () => {
    const { sim } = compiled(gameSpec, 1);
    const runtime = runtimeOf(sim);
    run(runtime, [], 61);
    expect(entityPlacements(runtime).filter((entity) => entity.stableId.startsWith('slime') && entity.active)).toHaveLength(5);
    run(runtime, [{ tick: 0, actionId: 'use', target: 'slime_1' }], 3);
    expect(placement(runtime, 'slime_1')?.active).toBe(false);
    run(runtime, [], 61);
    const revived = placement(runtime, 'slime_1');
    expect(revived?.active).toBe(true);
    expect([revived?.x, revived?.y]).toEqual(sim.sockets.slime_nest);
    expect(slot(runtime, entitySlotId('slime_1', 'active'))).toBe(1);
  });

  it('revives with a fresh combat state, so the second wave can be knocked out again', () => {
    const { sim } = compiled(gameSpec, 1);
    const runtime = runtimeOf(sim);
    run(runtime, [{ tick: 0, actionId: 'use', target: 'slime_1' }], 3);
    expect(placement(runtime, 'slime_1')?.active).toBe(false);
    run(runtime, [], 62);
    expect(placement(runtime, 'slime_1')).toMatchObject({ active: true, state: 'alive' });
    run(runtime, [{ tick: 0, actionId: 'use', target: 'slime_1' }], 3);
    expect(placement(runtime, 'slime_1')?.active).toBe(false);
  });
});
