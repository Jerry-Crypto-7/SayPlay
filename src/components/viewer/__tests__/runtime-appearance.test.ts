import { describe, expect, it } from 'vitest';
import { Group, Mesh, BoxGeometry, MeshStandardMaterial } from 'three';
import { applyRuntimeAppearance } from '../runtime-appearance';
import type { SemanticSlot } from '@/worldstream/slots';
import type { RuntimeSnapshot } from '@/worldstream/runtime-controller';

describe('visible deterministic state', () => {
  it('replays the signal and a hinged door in both directions without mutating the snapshot', () => {
    const root = new Group(), leaf = new Group(); leaf.name='door-leaf'; root.add(leaf);
    const material = new MeshStandardMaterial(); const geometry = new BoxGeometry(); leaf.add(new Mesh(geometry,material));
    const slot = { stableId:'doorVisual', source:{kind:'asset',assetId:'panel-door'}, binding:{entityId:'door',signalFlag:'alarm'} } as SemanticSlot;
    const state = { entities:[{stableId:'door',locked:false}], values:{'f:alarm':1} } as unknown as RuntimeSnapshot;
    const before = JSON.stringify(state);
    applyRuntimeAppearance(root,slot,state);
    expect(leaf.rotation.y).toBeLessThan(-1);
    expect(material.emissiveIntensity).toBe(1.6);
    expect(JSON.stringify(state)).toBe(before);
    applyRuntimeAppearance(root,slot,{...state,entities:[{...state.entities[0],locked:true}],values:{'f:alarm':0}});
    expect(leaf.rotation.y).toBe(0); expect(material.emissiveIntensity).toBe(0);
    geometry.dispose(); material.dispose();
  });

  it('shrinks a collected item away in 200 ms and brings it back after a rewind (P28B F-16)', () => {
    const root = new Group(); root.scale.set(2, 2, 2);
    const slot = { stableId:'mushroom_1Visual', source:{kind:'proxy'}, binding:{entityId:'mushroom_1'} } as unknown as SemanticSlot;
    const at = (taken: number) => ({ entities:[{stableId:'mushroom_1',locked:false,active:true}], values:{'c:mushroom_1_taken':taken} }) as unknown as RuntimeSnapshot;
    applyRuntimeAppearance(root, slot, at(0), 1000);
    expect(root.scale.x).toBe(2); expect(root.visible).toBe(true);
    applyRuntimeAppearance(root, slot, at(1), 1000);
    expect(root.scale.x).toBe(2);
    applyRuntimeAppearance(root, slot, at(1), 1100);
    expect(root.scale.x).toBeCloseTo(1); expect(root.visible).toBe(true);
    applyRuntimeAppearance(root, slot, at(1), 1200);
    expect(root.scale.x).toBe(0); expect(root.visible).toBe(false);
    applyRuntimeAppearance(root, slot, at(0), 1300);
    expect(root.scale.x).toBe(2);
  });
});
