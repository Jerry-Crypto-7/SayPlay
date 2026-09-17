import { describe, expect, it } from 'vitest';
import { toWorld } from '@/worldstream/slots';
import { createAssetManifest, fitAsset } from '../manifest';
import { assetCatalogSchema, assetRecordSchema, type AssetRecord } from '../schema';

import { asset } from '../__fixtures__/catalog';
const hash = 'a'.repeat(64);
const reference = { kind: 'asset', assetId: 'catalog.seated-person', version: 1, hash };

describe('approved asset manifest', () => {
  it('adds arbitrary classes as data and resolves exact versions, with defensive copies', () => {
    const first = asset();
    const second = { ...asset(), assetId: 'new.coral-hourglass' };
    const manifest = createAssetManifest({ version: 'worldstream-assets-v1', assets: [first, second] });
    expect(manifest.resolve({ ...reference, assetId: second.assetId }).ok).toBe(true);
    first.bounds.max[1] = 900;
    const resolved = manifest.resolve(reference);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.asset.bounds.max[1]).toBe(2);
    resolved.asset.sockets[0].at[1] = 400;
    const again = manifest.resolve(reference);
    expect(again.ok && again.asset.sockets[0].at[1]).toBe(0.7);
  });

  it.each([
    { ...reference, assetId: 'unknown' }, { ...reference, version: 2 },
    { ...reference, hash: 'b'.repeat(64) }, { ...reference, url: 'https://example.com/model.glb' },
  ])('rejects unavailable, stale or augmented references: %j', (ref) => {
    expect(createAssetManifest({ version: 'worldstream-assets-v1', assets: [asset()] }).resolve(ref).ok).toBe(false);
  });

  it.each(['https://example.com/a.glb', '/assets/worldstream/../a.glb', '/assets/worldstream/%2e%2e/a.glb',
    '/assets/worldstream/a.glb?url=x', '/assets/worldstream/a.glb#x', '/assets/worldstream/a.gltf'])('rejects unapproved file locations: %s', (path) => {
    const a = asset(); a.lods[0].path = path;
    expect(assetRecordSchema.safeParse(a).success).toBe(false);
  });

  it('rejects duplicate identities, inconsistent base hashes and dangling part sockets', () => {
    expect(assetCatalogSchema.safeParse({ version: 'worldstream-assets-v1', assets: [asset(), asset()] }).success).toBe(false);
    const a = asset(); a.lods[0].hash = 'b'.repeat(64);
    expect(assetRecordSchema.safeParse(a).success).toBe(false);
    const b = asset(); b.parts[0].sockets = ['missing'];
    expect(assetRecordSchema.safeParse(b).success).toBe(false);
    const c = asset(); c.sockets.push(c.sockets[0]);
    expect(assetRecordSchema.safeParse(c).success).toBe(false);
  });

  it('requires normalized axes, units, provenance and finite bounds', () => {
    for (const change of [{ units: 'centimeters' }, { up: '+Z' }, { front: '-Z' },
      { provenance: {} }, { bounds: { min: [0, 0, 0], max: [1, Infinity, 1] } }])
      expect(assetRecordSchema.safeParse({ ...asset(), ...change }).success).toBe(false);
  });
});

describe('representation fit without identity or simulation edits', () => {
  it('fits uniformly, grounds the asset and carries sockets through the same transform', () => {
    const a = asset();
    const before = structuredClone(a);
    const target = { min: [10, 3, 10], max: [14, 5, 14] } as const;
    const fit = fitAsset(a, target);
    expect(fit.scale).toEqual([1, 1, 1]);
    expect(toWorld(fit, [0, 0, 0])).toEqual([12, 3, 12]);
    expect(toWorld(fit, a.sockets[0].at)).toEqual([12, 3.7, 12]);
    expect(a).toEqual(before);
  });

  it('only stretches explicitly approved axes and rejects zero/nonfinite bounds', () => {
    const a = asset(); a.stretchableAxes = ['x'];
    const target = { min: [0, 0, 0], max: [4, 2, 4] } as const;
    expect(fitAsset(a, target).scale).toEqual([1, 1, 1]);
    expect(fitAsset(a, target, ['x']).scale).toEqual([4, 1, 1]);
    expect(() => fitAsset(a, target, ['y'])).toThrow('not approved');
    expect(() => fitAsset(a, { min: [0, 0, 0], max: [1, 0, 1] })).toThrow('positive bounds');
    expect(() => fitAsset(a, { min: [0, 0, 0], max: [Infinity, 1, 1] })).toThrow('positive bounds');
  });
});
