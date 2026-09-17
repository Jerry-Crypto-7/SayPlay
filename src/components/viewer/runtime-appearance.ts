import { Mesh, MeshStandardMaterial, type Object3D } from 'three';
import type { RuntimeSnapshot } from '@/worldstream/runtime-controller';
import type { SemanticSlot } from '@/worldstream/slots';

/** Presentation is derived from the current snapshot, including after rewind or a late GLB load. */
export function applyRuntimeAppearance(root: Object3D, slot: SemanticSlot, state: RuntimeSnapshot) {
  const entity = state.entities.find(e => e.stableId === (slot.binding?.entityId ?? slot.stableId));
  if (entity && slot.source.kind === 'asset' && slot.source.assetId === 'panel-door') {
    const leaf = root.getObjectByName('door-leaf');
    if (leaf) leaf.rotation.y = entity.locked ? 0 : -Math.PI * 0.48;
  }
  const flag = slot.binding?.signalFlag;
  if (!flag) return;
  const on = state.values[`f:${flag}`] === 1;
  root.traverse(node => {
    if (!(node instanceof Mesh)) return;
    for (const material of Array.isArray(node.material) ? node.material : [node.material]) {
      if (!(material instanceof MeshStandardMaterial)) continue;
      material.emissive.set(on ? '#ff7836' : '#000000');
      material.emissiveIntensity = on ? 1.6 : 0;
    }
  });
}
