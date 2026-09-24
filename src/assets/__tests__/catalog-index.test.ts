import { describe, expect, it } from 'vitest';

import catalog from '../catalog.json';
import index from '../catalog-index.json';

/**
 * Štíhlý index, který čte arkáda v prohlížeči (P26A T6), musí být přesná
 * projekce plného katalogu: index, který se rozejde, vypadá funkčně a kreslí
 * špatné cesty. `promote.mjs` ho proto zapisuje spolu s katalogem.
 */
describe('catalog-index.json', () => {
  it('is the exact projection of catalog.json: id, tags, LOD1 path, bounds', () => {
    const expected = catalog.assets.map((asset) => ({
      assetId: asset.assetId,
      tags: asset.tags,
      path: (asset.lods.find((lod) => lod.level === 1) ?? asset.lods[0]).path,
      bounds: asset.bounds,
    }));
    expect(index.assets).toEqual(expected);
  });

  it('points every model at a LOD1 file', () => {
    for (const asset of index.assets) expect(asset.path, asset.assetId).toMatch(/-lod1\.glb$/);
  });
});
