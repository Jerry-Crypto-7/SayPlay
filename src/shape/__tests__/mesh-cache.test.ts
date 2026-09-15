import { describe, expect, it, vi } from 'vitest';
import { createCachedMeshClient } from '../mesh-cache';
import type { MeshOrder, MeshResult } from '../mesh-client';

// This suite tests cache ownership and keys, not geometry validity or speed.
const order = { program: { shapeId: 'test', nodes: [{ kind: 'sphere', radius: 1 }], root: 0,
  anchors: [], targetBounds: { min: [-1, -1, -1], max: [1, 1, 1] } },
  bounds: { min: [-1, -1, -1], max: [1, 1, 1] }, resolution: 16, sessionSeed: 1 } as unknown as MeshOrder;
const result: MeshResult = { shapeId: 'test', positions: new Float32Array([1, 2, 3]), normals: new Float32Array([0, 1, 0]),
  indices: new Uint32Array([0, 0, 0]), vertexCount: 1, triangleCount: 1, bounds: order.bounds, elapsedMs: 17 };
function fixture() {
  const mesh = vi.fn(async () => structuredClone(result));
  const base = { mesh, pending: 0, dispose: vi.fn() };
  return { mesh, base, client: createCachedMeshClient(base, 4096, 2) };
}
describe('mesh cache', () => {
  it('reuses identical requests, reports the reuse and isolates mutable buffers', async () => {
    const { client, mesh } = fixture();
    const first = await client.mesh(order); first.positions[0] = 99;
    const second = await client.mesh(structuredClone(order)); second.positions[1] = 88;
    const third = await client.mesh(order);
    expect(mesh).toHaveBeenCalledTimes(1);
    expect(second).toMatchObject({ cacheHit: true, elapsedMs: 17 });
    expect([...third.positions]).toEqual([1, 2, 3]);
    expect(client.cacheStats.hits).toBe(2);
  });
  it('includes full program, seed, resolution, and requested bounds in its key', async () => {
    const { client, mesh } = fixture();
    await client.mesh(order);
    await client.mesh({ ...order, sessionSeed: 2 });
    await client.mesh({ ...order, resolution: 32 });
    await client.mesh({ ...order, bounds: { min: [0, 0, 0], max: [2, 2, 2] } });
    await client.mesh({ ...order, program: { ...order.program, anchors: [{ name: 'test', at: [0, 1, 0] }] } });
    expect(mesh).toHaveBeenCalledTimes(5);
    expect(client.cacheStats.entries).toBeLessThanOrEqual(2);
    expect(client.cacheStats.bytes).toBeLessThanOrEqual(4096);
  });
  it('never caches failures and releases owned data on disposal', async () => {
    const { client, mesh, base } = fixture();
    mesh.mockRejectedValueOnce(new Error('worker failed'));
    await expect(client.mesh(order)).rejects.toThrow('worker failed');
    expect(client.cacheStats.entries).toBe(0);
    await client.mesh(order); client.dispose();
    expect(base.dispose).toHaveBeenCalledOnce(); expect(client.cacheStats.bytes).toBe(0);
    await expect(client.mesh(order)).rejects.toThrow('disposed');
  });
  it('refuses aborted callers even when a result is cached', async () => {
    const { client, mesh } = fixture(); await client.mesh(order);
    const control = new AbortController(); control.abort();
    await expect(client.mesh(order, control.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(mesh).toHaveBeenCalledTimes(1);
  });

  it('does not resurrect cache data when a disposed client receives a late result', async () => {
    let finish!: (value: MeshResult) => void;
    const base = { mesh: () => new Promise<MeshResult>(resolve => { finish = resolve; }), pending: 1, dispose: vi.fn() };
    const client = createCachedMeshClient(base);
    const pending = client.mesh(order);
    client.dispose();
    finish(structuredClone(result));
    await expect(pending).rejects.toThrow('disposed');
    expect(client.cacheStats).toMatchObject({ bytes: 0, entries: 0 });
  });
});
