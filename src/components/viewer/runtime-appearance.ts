import { Mesh, MeshStandardMaterial, type Object3D, type Vector3 } from 'three';
import type { RuntimeSnapshot } from '@/worldstream/runtime-controller';
import type { SemanticSlot } from '@/worldstream/slots';

/** Presentation is derived from the current snapshot, including after rewind or a late GLB load. */
export function applyRuntimeAppearance(root: Object3D, slot: SemanticSlot, state: RuntimeSnapshot, now = 0) {
  const entity = state.entities.find(e => e.stableId === (slot.binding?.entityId ?? slot.stableId));
  if (entity && slot.source.kind === 'asset' && slot.source.assetId === 'panel-door') {
    const leaf = root.getObjectByName('door-leaf');
    if (leaf) leaf.rotation.y = entity.locked ? 0 : -Math.PI * 0.48;
  }
  if (entity) applyCollected(root, entity.stableId, state, now);
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

export const COLLECT_SHRINK_MS = 200;

/**
 * Sebraný předmět (P28B F-16): `collectible` entitu nedespawnuje, „sebráno“
 * drží jen čítač `<instance>_taken` (`src/play/compile/adapters/collectible.ts`).
 * Despawn by změnil hash stavu, proto ho schová jeviště – zmenšení za
 * `COLLECT_SHRINK_MS`, pak skrytí; po přetočení zpět se velikost vrátí.
 */
function applyCollected(root: Object3D, entityId: string, state: RuntimeSnapshot, now: number) {
  const data = root.userData as { collectedAt?: number; uncollectedScale?: Vector3 };
  if (state.values[`c:${entityId}_taken`] !== 1) {
    if (data.collectedAt === undefined) return;
    // Viditelnost vrací `WorldstreamStage` podle `entity.active` při každém novém snímku.
    root.scale.copy(data.uncollectedScale!);
    data.collectedAt = undefined;
    return;
  }
  if (data.collectedAt === undefined) {
    data.collectedAt = now;
    data.uncollectedScale = root.scale.clone();
  }
  const left = Math.max(0, 1 - (now - data.collectedAt) / COLLECT_SHRINK_MS);
  root.scale.copy(data.uncollectedScale!).multiplyScalar(left);
  if (left === 0) root.visible = false;
}
