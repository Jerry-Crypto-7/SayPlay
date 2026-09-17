import { Material, Mesh, type Group } from 'three';
import { disposeSubtree } from '@/components/viewer/dispose';
import { assetReferenceSchema } from './schema';
import type { AssetLoader, LoadedAsset } from './loader';
import { batchStaticAsset } from './batch';

export interface AssetLease { object: Group; release(): void; triangles: number; hash: string }
export interface CacheLimits { geometryBytes: number; textureBytes: number; triangles: number; entries: number }
const DEFAULT_LIMITS: CacheLimits = { geometryBytes: 128 * 1024 ** 2, textureBytes: 256 * 1024 ** 2, triangles: 500_000, entries: 64 };

/** Pending acquisitions count as owners; concurrent requests share one fetch/decode.
 * Geometry/textures belong to the cache, mutable materials belong to each lease. */
export function createAssetCache(loader: AssetLoader, options: Partial<CacheLimits> = {}) {
  const limits = { ...DEFAULT_LIMITS, ...options };
  const entries = new Map<string, { pending: Promise<LoadedAsset>; refs: number; reserved: Pick<LoadedAsset, 'geometryBytes' | 'textureBytes' | 'triangles'> }>();
  let geometryBytes = 0, textureBytes = 0, triangles = 0;
  return {
    get size() { return entries.size; },
    async acquire(reference: unknown, level = 0): Promise<AssetLease> {
      const ref = assetReferenceSchema.parse(reference);
      if (!Number.isSafeInteger(level) || level < 0) throw new Error('Invalid LOD level');
      const key = `${ref.assetId}@${ref.version}:${ref.hash}:${level}`;
      let entry = entries.get(key);
      if (!entry) {
        if (entries.size >= limits.entries) throw new Error('Asset cache entry budget exceeded');
        const reserved = loader.estimate?.(ref, level) ?? { geometryBytes: 0, textureBytes: 0, triangles: 0 };
        if (geometryBytes + reserved.geometryBytes > limits.geometryBytes || textureBytes + reserved.textureBytes > limits.textureBytes
          || triangles + reserved.triangles > limits.triangles) throw new Error('Asset cache decoded budget exceeded');
        geometryBytes += reserved.geometryBytes; textureBytes += reserved.textureBytes; triangles += reserved.triangles;
        const created = { pending: undefined as unknown as Promise<LoadedAsset>, refs: 0, reserved };
        created.pending = Promise.resolve().then(() => loader.load(ref, level)).then((loaded) => {
          try {
            const batched = batchStaticAsset(loaded.object, loaded.mutableNodes);
            loaded.geometryBytes = Math.max(loaded.geometryBytes, batched.geometryBytes);
          } catch (error) { disposeSubtree(loaded.object); throw error; }
          const extra = { geometryBytes: Math.max(0, loaded.geometryBytes - reserved.geometryBytes), textureBytes: Math.max(0, loaded.textureBytes - reserved.textureBytes), triangles: Math.max(0, loaded.triangles - reserved.triangles) };
          if (geometryBytes + extra.geometryBytes > limits.geometryBytes || textureBytes + extra.textureBytes > limits.textureBytes
            || triangles + extra.triangles > limits.triangles) {
            disposeSubtree(loaded.object); throw new Error('Asset cache decoded budget exceeded');
          }
          geometryBytes += extra.geometryBytes; textureBytes += extra.textureBytes; triangles += extra.triangles;
          reserved.geometryBytes += extra.geometryBytes; reserved.textureBytes += extra.textureBytes; reserved.triangles += extra.triangles;
          return loaded;
        }).catch((error) => { geometryBytes -= reserved.geometryBytes; textureBytes -= reserved.textureBytes; triangles -= reserved.triangles;
          if (entries.get(key) === created) entries.delete(key); throw error; });
        entry = created; entries.set(key, entry);
      }
      const owner = entry; owner.refs++;
      let loaded: LoadedAsset;
      try { loaded = await owner.pending; } catch (error) { owner.refs--; throw error; }
      const object = loaded.object.clone(true), materials = new Map<Material, Material>();
      object.traverse((node) => {
        if (!(node instanceof Mesh)) return;
        const clone = (material: Material) => {
          let result = materials.get(material); if (!result) { result = material.clone(); materials.set(material, result); } return result;
        };
        node.material = Array.isArray(node.material) ? node.material.map(clone) : clone(node.material);
      });
      let released = false;
      return { object, triangles: loaded.triangles, hash: loaded.hash, release() {
        if (released) return; released = true;
        object.removeFromParent(); object.clear();
        for (const material of materials.values()) material.dispose(); materials.clear();
        if (--owner.refs === 0) {
          entries.delete(key); geometryBytes -= owner.reserved.geometryBytes; textureBytes -= owner.reserved.textureBytes; triangles -= owner.reserved.triangles;
          disposeSubtree(loaded.object);
        }
      } };
    },
  };
}
