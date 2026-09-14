import { canonical } from '../ir/worlddoc';
import type { MeshClient, MeshOrder, MeshResult } from './mesh-client';

/** Per-client bounded LRU. It cannot mix budgeted/unbudgeted clients.
 * The cache owns copies; a renderer cannot mutate the next caller's geometry. */
export function createCachedMeshClient(base: MeshClient, maxBytes = 16 * 1024 * 1024, maxEntries = 16) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > 64 * 1024 * 1024 ||
    !Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > 64) throw new Error('invalid mesh cache limit');
  const entries = new Map<string, { result: MeshResult; bytes: number }>();
  let bytes = 0, hits = 0, misses = 0, disposed = false;
  const client: MeshClient & { readonly cacheStats: { bytes: number; entries: number; hits: number; misses: number } } = {
    async mesh(order: MeshOrder, signal?: AbortSignal): Promise<MeshResult> {
      if (disposed) throw new Error('mesh client is disposed');
      if (signal?.aborted) throw new DOMException('Mesh request cancelled', 'AbortError');
      const request = structuredClone(order);
      const key = canonical(request);
      const cached = entries.get(key);
      if (cached) {
        entries.delete(key); entries.set(key, cached); hits++;
        return { ...structuredClone(cached.result), cacheHit: true };
      }
      misses++;
      const result = await base.mesh(request, signal);
      if (disposed) throw new Error('mesh client is disposed');
      if (signal?.aborted) throw new DOMException('Mesh request cancelled', 'AbortError');
      const size = new TextEncoder().encode(key).length + result.positions.byteLength + result.normals.byteLength + result.indices.byteLength + 1024;
      if (!disposed && size <= maxBytes) {
        const previous = entries.get(key);
        if (previous) { bytes -= previous.bytes; entries.delete(key); }
        while (entries.size >= maxEntries || bytes + size > maxBytes) {
          const oldest = entries.keys().next().value;
          if (oldest === undefined) break;
          bytes -= entries.get(oldest)!.bytes; entries.delete(oldest);
        }
        entries.set(key, { result: structuredClone(result), bytes: size }); bytes += size;
      }
      return { ...result, cacheHit: false };
    },
    get pending() { return base.pending; },
    get cacheStats() { return { bytes, entries: entries.size, hits, misses }; },
    dispose() { disposed = true; entries.clear(); bytes = 0; base.dispose(); },
  };
  return client;
}
