import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { isGen3d } from '../../assets/gen3d/promote.mjs';
import { LICENSE, PUBLIC_DIR, promoteBatch } from '../promote-batch.mjs';

/**
 * Povýšení dávky do katalogu (P37D T3) nad dočasným kořenem: přijatý model projde
 * do katalogu, indexu i disclosure; zamítnutý, cizí licence, obsazené id a obsazené
 * jméno se přeskočí a nic cizího se nezmění; druhé povýšení téhož id nezdvojí.
 */

const ROOT = path.resolve(__dirname, '../../..');
const GLB = path.join(ROOT, 'public/assets/worldstream/gen3d/gen3d-acorn-lod0.glb');
const roots: string[] = [];

const taken = {
  assetId: 'gen3d-taken', tags: ['toad'], bounds: { min: [0, 0, 0], max: [1, 1, 1] },
  lods: [{ level: 0, path: '/assets/worldstream/gen3d/gen3d-taken-lod0.glb' }, { level: 1, path: '/assets/worldstream/gen3d/gen3d-taken-lod1.glb' }],
};

function makeRoot(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'p37d-root-'));
  roots.push(root);
  mkdirSync(path.join(root, 'src/assets'), { recursive: true });
  writeFileSync(path.join(root, 'src/assets/catalog.json'), JSON.stringify({ version: 1, assets: [taken] }));
  writeFileSync(path.join(root, 'disclosure.json'), JSON.stringify({ $comment: 'test', entries: [{ name: 'public/other.png', kind: 'asset' }] }));
  return root;
}

const entry = (id: string, nouns: string[], extra: Record<string, unknown> = {}) => ({
  id, nouns, glb: GLB, bounds: [0.6, 1, 0.6], palette: ['#8a5a2b'],
  source: { pipeline: 'ops/gen3d', imageModel: 'FLUX.2-klein-4B', shapeModel: 'TRELLIS.2-4B', seed: 1 },
  licence: LICENSE, checked: { judge: 'blind four-view sheet: top1', verdict: 'pass' }, ...extra,
});

const read = (root: string, file: string) => JSON.parse(readFileSync(path.join(root, file), 'utf8'));

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  // `normalizeModel` pracuje v `asset-quarantine/<id>` repa, ne pod dočasným kořenem.
  for (const id of ['gen3d-test-acorn', 'gen3d-test-broken']) rmSync(path.join(ROOT, 'asset-quarantine', id), { recursive: true, force: true });
});

describe('promote-batch (P37D T3)', () => {
  it('promotes a passed model into the catalog, the index and disclosure, and skips the rest', async () => {
    const root = makeRoot();
    const batch = {
      schema: 'catalog-batch.v1',
      entries: [
        entry('gen3d-test-acorn', ['test acorn', 'toad']),
        entry('gen3d-test-rejected', ['rejected'], { checked: { judge: 'blind four-view sheet: no', verdict: 'fail' } }),
        entry('gen3d-test-foreign', ['foreign'], { licence: 'CC-BY-4.0' }),
        entry('gen3d-taken', ['fresh noun']),
        entry('gen3d-test-toad', ['toad']),
      ],
    };
    const { promoted, skipped } = await promoteBatch(batch, { root, sync: false });

    expect(promoted).toEqual(['gen3d-test-acorn']);
    expect(Object.fromEntries(skipped.map((skip: { id: string; reason: string }) => [skip.id, skip.reason]))).toEqual({
      'gen3d-test-rejected': 'judge: blind four-view sheet: no',
      'gen3d-test-foreign': `licence CC-BY-4.0 is not the pipeline licence ${LICENSE}`,
      'gen3d-taken': 'id already in the catalog outside gen3d-p37d',
      'gen3d-test-toad': '"toad" is already a tag of another catalog model',
    });

    const catalog = read(root, 'src/assets/catalog.json');
    expect(catalog.assets.map((asset: { assetId: string }) => asset.assetId)).toEqual(['gen3d-taken', 'gen3d-test-acorn']);
    expect(catalog.assets[0]).toEqual(taken);
    const promotedAsset = catalog.assets[1];
    // „toad“ už je štítek jiného modelu, do nového nepatří.
    expect(promotedAsset.tags).toEqual(['test acorn']);
    expect(promotedAsset.provenance.license).toBe(LICENSE);
    expect(promotedAsset.lods.map((lod: { path: string }) => lod.path)).toEqual([
      '/assets/worldstream/gen3d-p37d/gen3d-test-acorn-lod0.glb',
      '/assets/worldstream/gen3d-p37d/gen3d-test-acorn-lod1.glb',
    ]);
    expect(promotedAsset.lods[1].triangles).toBeLessThan(promotedAsset.lods[0].triangles);
    expect(isGen3d(promotedAsset)).toBe(false);
    expect(isGen3d(taken)).toBe(true);

    expect(read(root, 'src/assets/catalog-index.json').assets[1]).toMatchObject({ assetId: 'gen3d-test-acorn', path: '/assets/worldstream/gen3d-p37d/gen3d-test-acorn-lod1.glb' });
    const files = readdirSync(path.join(root, PUBLIC_DIR)).sort();
    expect(files).toEqual(['PROVENANCE.md', 'gen3d-test-acorn-lod0.glb', 'gen3d-test-acorn-lod1.glb', 'gen3d-test-acorn.png']);
    const names = read(root, 'disclosure.json').entries.map((record: { name: string }) => record.name);
    expect(names).toEqual(['public/other.png', ...files.map((file) => `${PUBLIC_DIR}/${file}`)]);
  }, 180_000);

  it('promoting the same id again replaces the entry instead of doubling it', async () => {
    const root = makeRoot();
    const batch = { schema: 'catalog-batch.v1', entries: [entry('gen3d-test-acorn', ['test acorn'])] };
    await promoteBatch(batch, { root, sync: false });
    const { promoted, skipped } = await promoteBatch(batch, { root, sync: false });

    expect(promoted).toEqual(['gen3d-test-acorn']);
    expect(skipped).toEqual([]);
    const ids = read(root, 'src/assets/catalog.json').assets.map((asset: { assetId: string }) => asset.assetId);
    expect(ids).toEqual(['gen3d-taken', 'gen3d-test-acorn']);
    const names: string[] = read(root, 'disclosure.json').entries.map((record: { name: string }) => record.name);
    expect(new Set(names).size).toBe(names.length);
    expect(readFileSync(path.join(root, PUBLIC_DIR, 'PROVENANCE.md'), 'utf8').match(/gen3d-test-acorn/g)).toHaveLength(1);
  }, 180_000);

  it('skips a model normalize cannot finish and still promotes the rest', async () => {
    const root = makeRoot();
    const batch = {
      schema: 'catalog-batch.v1',
      entries: [entry('gen3d-test-broken', ['broken thing'], { glb: path.join(root, 'missing-lod0.glb') }), entry('gen3d-test-acorn', ['test acorn'])],
    };
    const { promoted, skipped } = await promoteBatch(batch, { root, sync: false });

    expect(promoted).toEqual(['gen3d-test-acorn']);
    expect(skipped).toEqual([{ id: 'gen3d-test-broken', reason: expect.stringMatching(/^normalize: /) }]);
    expect(read(root, 'src/assets/catalog.json').assets.map((asset: { assetId: string }) => asset.assetId)).toEqual(['gen3d-taken', 'gen3d-test-acorn']);
    expect(readdirSync(path.join(root, PUBLIC_DIR)).some((file) => file.includes('broken'))).toBe(false);
  }, 180_000);

  it('drops an own model with its files and disclosure, and never a foreign one', async () => {
    const root = makeRoot();
    await promoteBatch({ schema: 'catalog-batch.v1', entries: [entry('gen3d-test-acorn', ['test acorn'])] }, { root, sync: false });
    const { dropped } = await promoteBatch({ schema: 'catalog-batch.v1', entries: [] }, { root, sync: false, drop: ['gen3d-test-acorn', 'gen3d-taken'] });

    expect(dropped).toEqual(['gen3d-test-acorn']);
    expect(read(root, 'src/assets/catalog.json').assets.map((asset: { assetId: string }) => asset.assetId)).toEqual(['gen3d-taken']);
    expect(readdirSync(path.join(root, PUBLIC_DIR))).toEqual(['PROVENANCE.md']);
    const names = read(root, 'disclosure.json').entries.map((record: { name: string }) => record.name);
    expect(names.some((name: string) => name.includes('acorn'))).toBe(false);
    expect(readFileSync(path.join(root, PUBLIC_DIR, 'PROVENANCE.md'), 'utf8')).not.toMatch(/acorn/);
  }, 180_000);

  it('refuses a batch that breaks the schema before touching anything', () => {
    const run = spawnSync(process.execPath, [path.join(ROOT, 'scripts/p37d/promote-batch.mjs'), '--batch', path.join(ROOT, 'src/play/assets/__fixtures__/batch-no-licence.json')], { encoding: 'utf8' });
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/invalid batch/);
    expect(existsSync(path.join(ROOT, 'asset-quarantine/acorn'))).toBe(false);
  });
});
