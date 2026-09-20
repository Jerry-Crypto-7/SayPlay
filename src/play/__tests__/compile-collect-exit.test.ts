/**
 * Kostra kompilátoru simulace a vertikální řez `collect_exit` (P23-A, T3).
 *
 * Svět se postaví a vypadá správně i bez svědka – proto tu dohratelnost,
 * hash a hranice capabilities pinuje test, ne oko.
 *
 * Dohratelnost soudí `verifyWitness` nad stopou, kterou napsal kompilátor –
 * tentýž certifikát, jaký vydává `certifySteps`. Hledač `solveWitnessDetailed`
 * tenhle svět také vyřeší (20. 9. 2026: 2 623 uzlů, 48 s, 5 různých hub a
 * `moveTo portal`), ale 48 s do sady nepatří.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { buildRuntimeWorld } from '@/ir/build';
import { simHashOf } from '@/ir/worlddoc';
import { verifyWitness } from '@/verify/witness';

import { ADAPTERS, type AdapterTable } from '../compile/adapters';
import { compileSim, type SimCompilation } from '../compile';
import { MECHANICS, type MechanicId, type RuntimeAction } from '../registry';
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

const spec = fixture('collect_exit');

describe('compileSim – collect_exit', () => {
  it('builds a runtime world and its own witness is certified', () => {
    for (const seed of [1, 2, 3]) {
      const { sim } = compiled(spec, seed);
      const built = buildRuntimeWorld(sim);
      expect(built.ok, built.ok ? '' : built.issues.join('; ')).toBe(true);
      if (!built.ok) return;
      const verdict = verifyWitness(built.world, built.world.trace);
      expect(verdict.verdict, verdict.verdict === 'REJECTED' ? `seed ${seed}: ${verdict.reason} ${verdict.detail}` : '').toBe('CERTIFIED');
      // Pět různých hub, pak východ – opakovaný sběr téže houby čítač nezvedne.
      const pickups = sim.witness.ops.filter((op) => op.actionId === 'pickup').map((op) => op.target);
      expect(new Set(pickups).size).toBe(5);
      expect(sim.witness.ops.at(-1)).toMatchObject({ actionId: 'moveTo', target: 'portal' });
    }
  });

  it('does not win when the same item is picked five times', () => {
    const { sim } = compiled(spec, 1);
    const cheat = { ...sim, witness: { ...sim.witness, ops: sim.witness.ops.map((op) => (op.actionId === 'pickup' ? { ...op, target: 'mushroom_1' } : op)) } };
    const built = buildRuntimeWorld(cheat);
    if (!built.ok) throw new Error(built.issues.join('; '));
    expect(verifyWitness(built.world, built.world.trace).verdict).toBe('REJECTED');
  });

  it('gives the same simHash for the same spec and seed', () => {
    expect(simHashOf({ sim: compiled(spec, 3).sim })).toBe(simHashOf({ sim: compiled(spec, 3).sim }));
  });

  it('binds every rule to exactly one mechanic and every role to its entities', () => {
    const { sim, mechanics, roles } = compiled(spec, 2);
    const owners = new Map<string, number>();
    for (const binding of mechanics) for (const id of binding.ruleIds) owners.set(id, (owners.get(id) ?? 0) + 1);
    for (const id of Object.keys(sim.rules)) {
      if (id.startsWith('sys.')) continue;
      expect(owners.get(id), `rule ${id} owned once`).toBe(1);
    }
    for (const binding of mechanics) for (const id of binding.ruleIds) expect(sim.rules[id]).toBeDefined();

    expect(roles.map((role) => role.roleId)).toEqual(spec.roles.map((role) => role.id));
    for (const binding of roles) {
      const role = spec.roles.find((r) => r.id === binding.roleId) as GameSpecV1['roles'][number];
      expect(binding.entityIds).toHaveLength(role.count);
      for (const id of binding.entityIds) expect(sim.entities[id]).toBeDefined();
      for (const socket of binding.sockets) expect(sim.sockets[socket]).toBeDefined();
    }
    expect(Object.values(sim.entities).filter((entity) => entity.role === 'actor')).toHaveLength(1);
  });

  it('keeps every adapter inside its registry capabilities', () => {
    const { sim, mechanics } = compiled(spec, 4);
    for (const binding of mechanics) {
      const { events, actions } = MECHANICS[binding.mechanicId as MechanicId].capabilities;
      for (const id of binding.ruleIds) {
        const rule = sim.rules[id];
        expect(events, `${id} event`).toContain(rule.event.kind);
        for (const action of rule.actions) expect(actions, `${id} action`).toContain(action.kind as RuntimeAction);
      }
    }
  });

  it('throws on an adapter that steps outside its capabilities', () => {
    const rogue: AdapterTable = {
      ...ADAPTERS,
      collectible: () => ({
        rules: {
          cheat: { id: 'cheat', phase: 0, priority: 0, event: { kind: 'onStart' }, condition: null, actions: [{ kind: 'win' }] },
        },
      }),
    };
    expect(() => compileSim(spec, 1, rogue)).toThrow(/outside capabilities/);
  });

  it('fails closed on a mechanic without an adapter', () => {
    const result = compileSim(spec, 1, { ...ADAPTERS, collectible: null });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('MECHANIC_UNSUPPORTED');
      expect(result.issues[0]).toContain('collectible');
    }
  });
});
