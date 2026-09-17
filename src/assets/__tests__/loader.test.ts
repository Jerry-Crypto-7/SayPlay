import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { Group, Mesh, BoxGeometry, MeshStandardMaterial, Texture } from 'three';
import { createAssetLoader } from '../loader';
import { createAssetCache } from '../cache';
import { createAssetManifest } from '../manifest';
import { asset } from '../__fixtures__/catalog';
import catalog from '../catalog.json';

async function fixture(mutate?: (doc: any) => void) {
  const doc = { asset: { version: '2.0' }, buffers: [{ byteLength: 36 }], bufferViews: [{ buffer: 0, byteLength: 36 }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [-.5, 0, -.5], max: [.5, 2, .5] }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }], materials: [{ name: 'Clothes' }],
    nodes: [{ name: 'Body', mesh: 0 }], scenes: [{ nodes: [0] }], scene: 0 };
  mutate?.(doc);
  const json = new TextEncoder().encode(JSON.stringify(doc)); const padded = Math.ceil(json.length / 4) * 4;
  const buffer = new ArrayBuffer(28 + padded + 36), view = new DataView(buffer);
  view.setUint32(0, 0x46546c67, true); view.setUint32(4, 2, true); view.setUint32(8, buffer.byteLength, true);
  view.setUint32(12, padded, true); view.setUint32(16, 0x4e4f534a, true);
  new Uint8Array(buffer, 20, padded).fill(32); new Uint8Array(buffer, 20, json.length).set(json);
  view.setUint32(20 + padded, 36, true); view.setUint32(24 + padded, 0x004e4942, true);
  new Float32Array(buffer, 28 + padded, 9).set([-.5, 0, -.5, .5, 2, -.5, 0, 0, .5]);
  const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', buffer))].map((b) => b.toString(16).padStart(2, '0')).join('');
  const record = asset(); record.hash = hash; Object.assign(record.lods[0], { hash, bytes: buffer.byteLength, triangles: 1, decodedGeometryBytes: 36 });
  const ref = { kind: 'asset', assetId: record.assetId, version: 1, hash };
  const manifest = createAssetManifest({ version: 'worldstream-assets-v1', assets: [record] });
  return { buffer, record, ref, manifest };
}

describe('approved GLB loader', () => {
  it('separates real load phases and shared cache hits do not fabricate decode samples', async () => {
    const f=await fixture();let clock=0;
    const loader=createAssetLoader(f.manifest,{fetch:async()=>new Response(f.buffer),now:()=>++clock});
    const cache=createAssetCache(loader),leases=await Promise.all(Array.from({length:5},()=>cache.acquire(f.ref)));
    expect(loader.timings?.()).toEqual([expect.objectContaining({sequence:1,assetId:f.record.assetId,status:'loaded',totalMs:5,
      phases:{download:1,hash:1,preflight:1,decode:1,validation:1}})]);
    const snapshot=loader.timings!();(snapshot[0].phases as {decode:number}).decode=999;
    expect(loader.timings!()[0].phases.decode).toBe(1);
    for(const lease of leases)lease.release();expect(cache.size).toBe(0);
  });
  it('bounds failed-load diagnostics and leaves unreached decode phases unmeasured', async () => {
    const f=await fixture(),corrupt=f.buffer.slice(0);new Uint8Array(corrupt)[30]^=1;
    const loader=createAssetLoader(f.manifest,{fetch:async()=>new Response(corrupt)});
    for(let i=0;i<65;i++)await expect(loader.load(f.ref)).rejects.toThrow('hash');
    const samples=loader.timings!();expect(samples).toHaveLength(64);expect(samples[0].sequence).toBe(2);
    expect(samples.at(-1)).toMatchObject({status:'failed',phase:'hash',phases:{preflight:null,decode:null,validation:null}});
    expect(samples.every(s=>s.totalMs>=0&&s.phases.download!==null&&s.phases.hash!==null)).toBe(true);
  });
  it('accepts every packaged model and LOD through the production security checks', async () => {
    const manifest = createAssetManifest(catalog);
    const cache = createAssetCache(createAssetLoader(manifest, { fetch: async (path) => new Response(readFileSync(`public${String(path)}`)) }));
    for (const model of catalog.assets) for (const lod of model.lods) {
      const lease = await cache.acquire({ kind: 'asset', assetId: model.assetId, version: model.version, hash: model.hash }, lod.level);
      expect(lease.triangles).toBe(lod.triangles); lease.release();
    }
    expect(cache.size).toBe(0);
  });
  it('decodes real GLB with geometry, named part and material', async () => {
    const f = await fixture(); const fetcher = vi.fn(async (_url: string | URL | Request) => new Response(f.buffer));
    const loaded = await createAssetLoader(f.manifest, { fetch: fetcher }).load(f.ref);
    expect(loaded.object.getObjectByName('Body')).toBeInstanceOf(Mesh);
    expect(loaded.triangles).toBe(1); expect(loaded.geometryBytes).toBe(36);
    expect(fetcher.mock.calls[0][0]).toBe('/assets/worldstream/person/model.glb');
  });
  it('rejects an unapproved identity without fetching', async () => {
    const f = await fixture(), fetcher = vi.fn();
    await expect(createAssetLoader(f.manifest, { fetch: fetcher }).load({ ...f.ref, hash: 'f'.repeat(64) })).rejects.toThrow('hash');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('rejects arbitrary URL/path fields and missing LODs before fetching', async () => {
    const f = await fixture(), fetcher = vi.fn(), loader = createAssetLoader(f.manifest, { fetch: fetcher });
    await expect(loader.load({ ...f.ref, path: 'https://attacker.test/model.glb' })).rejects.toThrow('Invalid asset reference');
    await expect(loader.load('https://attacker.test/model.glb')).rejects.toThrow('Invalid asset reference');
    await expect(loader.load(f.ref, 99)).rejects.toThrow('Missing LOD');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('rejects hash mismatches and streams beyond declared size before parse', async () => {
    const f = await fixture(), parse = vi.fn(); const corrupt = f.buffer.slice(0); new Uint8Array(corrupt)[30] ^= 1;
    await expect(createAssetLoader(f.manifest, { parse, fetch: async () => new Response(corrupt) }).load(f.ref)).rejects.toThrow('hash');
    const cancel = vi.fn(); const stream = new ReadableStream({ start(c) { c.enqueue(new Uint8Array(f.buffer.byteLength + 1)); }, cancel });
    await expect(createAssetLoader(f.manifest, { parse, fetch: async () => new Response(stream) }).load(f.ref)).rejects.toThrow('byte budget');
    expect(cancel).toHaveBeenCalledOnce(); expect(parse).not.toHaveBeenCalled();
  });
  it.each([
    ['external URI', (d: any) => { d.buffers[0].uri = 'https://evil.test/a.bin'; }],
    ['codec extension', (d: any) => { d.meshes[0].primitives[0].extensions = { KHR_draco_mesh_compression: {} }; }],
    ['decoded allocation', (d: any) => { d.accessors[0].count = 100_000_000; }],
    ['cycle', (d: any) => { d.nodes[0].children = [0]; }],
    ['material mismatch', (d: any) => { d.materials[0].doubleSided = true; }],
    ['missing part', (d: any) => { d.nodes[0].name = 'Wrong'; }],
  ])('rejects %s before decoder invocation', async (_, mutate) => {
    const f = await fixture(mutate), parse = vi.fn();
    await expect(createAssetLoader(f.manifest, { parse, fetch: async () => new Response(f.buffer) }).load(f.ref)).rejects.toThrow();
    expect(parse).not.toHaveBeenCalled();
  });
});

describe('reference counted assets', () => {
  it('shares fetch, geometry and textures while isolating materials; last release disposes and reload works', async () => {
    const texture = new Texture(), geometry = new BoxGeometry(), material = new MeshStandardMaterial({ map: texture });
    const geometryDispose = vi.spyOn(geometry, 'dispose'), textureDispose = vi.spyOn(texture, 'dispose');
    const load = vi.fn(async () => { const object = new Group(); object.add(new Mesh(geometry, material));
      return { object, triangles: 12, hash: 'a'.repeat(64), geometryBytes: 100, textureBytes: 100 }; });
    const cache = createAssetCache({ load }), ref = { kind: 'asset', assetId: 'test', version: 1, hash: 'a'.repeat(64) };
    const [a, b] = await Promise.all([cache.acquire(ref), cache.acquire(ref)]);
    expect(load).toHaveBeenCalledOnce();
    const first = a.object.children[0] as Mesh, second = b.object.children[0] as Mesh;
    expect(first.geometry).toBe(second.geometry); expect(first.material).not.toBe(second.material);
    a.release(); a.release(); expect(geometryDispose).not.toHaveBeenCalled(); expect(textureDispose).not.toHaveBeenCalled();
    b.release(); expect(geometryDispose).toHaveBeenCalledOnce(); expect(textureDispose).toHaveBeenCalledOnce(); expect(cache.size).toBe(0);
    const c = await cache.acquire(ref); expect(load).toHaveBeenCalledTimes(2); c.release();
  });
  it('reserves pending memory before a second distinct load and clears failed reservations', async () => {
    let fail!: (error: Error) => void;
    const load = vi.fn(() => new Promise<any>((_, reject) => { fail = reject; }));
    const cache = createAssetCache({ load, estimate: () => ({ geometryBytes: 80, textureBytes: 0, triangles: 1 }) }, { geometryBytes: 100 });
    const ref = { kind: 'asset', assetId: 'test', version: 1, hash: 'a'.repeat(64) };
    const first = cache.acquire(ref); await Promise.resolve();
    await expect(cache.acquire({ ...ref, assetId: 'other' })).rejects.toThrow('budget'); expect(load).toHaveBeenCalledOnce();
    fail(new Error('decode failed')); await expect(first).rejects.toThrow('decode failed'); expect(cache.size).toBe(0);
  });
});
