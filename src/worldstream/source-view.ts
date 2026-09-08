import { buildRuntimeWorld } from '@/ir/build';
import { createRuntime, entityPlacements } from '@/sim/interpreter';
import type { WorldDoc } from '@/ir/worlddoc';
import type { ProxyWorld } from './proxy';

/** Explicit schematic geometry from validated spatial declarations. No invented
 * architecture or claim that the source supplied an artistic appearance. */
export function sourceProxy(world: WorldDoc, title: string): ProxyWorld {
  const built = buildRuntimeWorld(world.sim);
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
