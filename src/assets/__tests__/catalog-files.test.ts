import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Box3, Mesh, Vector3 } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import catalog from '../catalog.json';
import { assetCatalogSchema } from '../schema';

describe('committed original GLB catalog', () => {
  it('declares seventy-seven complete normalized assets with genuinely cheaper LODs', () => {
    // 30 z `originals.mjs` (šest původních + P22 T11) a 47 herních modelů
    // z Blenderu (`blender/game_models.py`, QA PLAY 22. 9. 2026; + 5 pro běžce, P25B).
    const parsed = assetCatalogSchema.parse(catalog);
    expect(parsed.assets.filter((a) => a.provenance.source === 'scripts/assets/originals.mjs')).toHaveLength(30);
    expect(parsed.assets.filter((a) => a.provenance.source === 'scripts/assets/blender/game_models.py')).toHaveLength(47);
    for (const asset of parsed.assets) {
      expect(asset.units).toBe('meters'); expect(asset.up).toBe('+Y'); expect(asset.front).toBe('+Z');
      expect(asset.pivot).toEqual([0, 0, 0]); expect(asset.lods).toHaveLength(2);
      expect(asset.lods[1].triangles).toBeLessThan(asset.lods[0].triangles);
      expect(asset.bounds.min[1]).toBeCloseTo(0, 5);
    }
  });
  it.each(catalog.assets)('loads both LODs of $assetId with truthful hashes, bounds and materials', async (asset) => {
    for (const lod of asset.lods) {
      const bytes = readFileSync(`public${lod.path}`);
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(lod.hash);
      expect(bytes.length).toBe(lod.bytes);
      const gltf = await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length), '');
      const bounds = new Box3().setFromObject(gltf.scene, true);
      for (let axis = 0; axis < 3; axis++) {
        expect(bounds.min.getComponent(axis)).toBeGreaterThanOrEqual(asset.bounds.min[axis] - 1e-6);
        expect(bounds.max.getComponent(axis)).toBeLessThanOrEqual(asset.bounds.max[axis] + 1e-6);
      }
      const materials = new Set<string>(); let triangles = 0;
      gltf.scene.traverse((node) => {
        if (!(node instanceof Mesh)) return;
        triangles += (node.geometry.index?.count ?? node.geometry.attributes.position.count) / 3;
        for (const mat of Array.isArray(node.material) ? node.material : [node.material]) materials.add(mat.name);
      });
      expect(triangles).toBe(lod.triangles);
      expect([...materials].sort()).toEqual([...new Set(asset.materials.map((m) => m.name))].sort());
      for (const part of asset.parts) {
        const node = gltf.scene.getObjectByName(part.node)!;
        expect(node).toBeDefined();
        expect(node.getWorldPosition(new Vector3()).toArray()).toEqual(part.pivot);
      }
    }
  });
  it('keeps physical object dimensions and forward-facing semantic features', async () => {
    const person = catalog.assets.find((a) => a.assetId === 'seated-person')!;
    expect(person.bounds.max[1]).toBeGreaterThan(1.4); expect(person.bounds.max[1]).toBeLessThan(1.5);
    const bytes = readFileSync(`public${person.lods[0].path}`);
    const gltf = await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length), '');
    expect(gltf.scene.getObjectByName('nose')!.position.z).toBeGreaterThan(gltf.scene.getObjectByName('head')!.position.z);
    const door = catalog.assets.find((a) => a.assetId === 'panel-door')!;
    expect(door.bounds.max[1]).toBeCloseTo(2.2);
    expect(catalog.assets.find((a) => a.assetId === 'aquarium')!.materials.filter((m) => m.alphaMode === 'BLEND')).toHaveLength(2);
  });
});
