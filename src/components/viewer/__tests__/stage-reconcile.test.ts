import { describe, expect, it } from 'vitest';
import sim from '../../../../evals/reality-compiler/museum.sim.json';
import { buildRuntimeWorld } from '../../../ir/build';
import { sealSimHash, type WorldDoc } from '../../../ir/worlddoc';
import { createRuntime, entityPlacements } from '../../../sim/interpreter';
import type { ProxyWorld } from '../../../worldstream/proxy';
import { PALETTES } from '../../../kit';
import { buildStage } from '../WorldstreamStage';
import { socketName } from '../representation';

/** Schematický svět z rozmístění entit (dřív `worldstream/source-view.ts`, smazaný s tvorbou světů v P44D T6). */
function sourceProxy(doc: WorldDoc, title: string): ProxyWorld {
  const built = buildRuntimeWorld(doc.sim);
  if (!built.ok) throw new Error('The source scenario cannot run.');
  const entities = entityPlacements(createRuntime({ ...built.world, trace: [] }));
  return { kind: 'built', title, sessionSeed: 1, resolution: 16, quality: 'full', scenery: [],
    slots: entities.map(entity => ({
      slot: { stableId: entity.stableId, label: entity.stableId, role: 'prop', importance: 1,
        source: { kind: 'geom', node: 0 }, anchors: [],
        localBounds: { min: [-0.3, 0, -0.3], max: [0.3, 0.7, 0.3] },
        worldBounds: { min: [entity.x - 0.3, 0, entity.y - 0.3], max: [entity.x + 0.3, 0.7, entity.y + 0.3] },
        transform: { scale: [1, 1, 1], translation: [entity.x, 0, entity.y] } },
      form: { kind: 'clay', rung: 'semantic-clay', drawn: true, reason: 'Schematic source scenario; appearance is not sourced.' },
    })) };
}

function fixture() {
  const world = sourceProxy(sealSimHash({ irVersion: 'v1', simRevision: 0, lookRevision: 0, sim,
    look: { modules: [], palette: {}, lightRig: {}, atmosphere: {}, materialRoles: {}, camera: {}, audio: {} } }), 'fixture');
  if (world.kind !== 'built') throw new Error('fixture');
  return { ...world, slots: world.slots.map(entry => ({ ...entry,
    slot: { ...entry.slot, anchors: [{ name: 'top', at: [0, 0.7, 0] as const }] } })) };
}

describe('stage reconciliation', () => {
  it('keeps real wrapper, socket, runtime transform and untouched representation identities', () => {
    const world = fixture(); const stage = buildStage(world, PALETTES.harbor);
    const visitor = stage.registry.view('visitor')!;
    const sensor = stage.registry.view('sensorA')!;
    const socket = visitor.group.getObjectByName(socketName('top'));
    visitor.group.position.x += 3; visitor.group.userData.runtime = { tick: 37 };
    const beforeX = visitor.group.position.x;
    const next = { ...world, slots: world.slots.map(entry => entry.slot.stableId !== 'visitor' ? entry : {
      ...entry, slot: { ...entry.slot, localBounds: { ...entry.slot.localBounds, max: [0.5, 0.7, 0.3] as const } },
    }) };
    stage.reconcile(next, PALETTES.harbor);
    const changed = stage.registry.view('visitor')!;
    expect(changed.group).toBe(visitor.group);
    expect(changed.group.position.x).toBe(beforeX);
    expect(changed.group.userData.runtime).toEqual({ tick: 37 });
    expect(changed.group.getObjectByName(socketName('top'))).toBe(socket);
    expect(changed.attached).not.toBe(visitor.attached);
    expect(stage.registry.view('sensorA')!.group).toBe(sensor.group);
    expect(stage.registry.view('sensorA')!.attached).toBe(sensor.attached);
    stage.dispose();
  });

  it('does not rebuild equivalent representations and removes only deleted slots', () => {
    const world = fixture(); const stage = buildStage(world, PALETTES.harbor);
    const before = stage.registry.view('visitor')!;
    stage.reconcile(structuredClone(world), PALETTES.harbor);
    expect(stage.registry.view('visitor')!.attached).toBe(before.attached);
    stage.reconcile({ ...world, slots: world.slots.filter(entry => entry.slot.stableId !== 'sensorA') }, PALETTES.harbor);
    expect(stage.registry.view('sensorA')).toBeNull();
    expect(stage.registry.view('visitor')!.attached).toBe(before.attached);
    expect(stage.views).toHaveLength(world.slots.length - 1);
    stage.dispose();
  });
});
