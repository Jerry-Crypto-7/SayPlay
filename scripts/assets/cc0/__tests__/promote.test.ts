import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { NodeIO } from '@gltf-transform/core';
import { describe, expect, it } from 'vitest';

import { purpleColours } from '../normalize.mjs';
import { BUDGET, cc0Tags, checkCatalog, fitBudget, folderBytes, isCc0 } from '../promote.mjs';

const root = path.resolve(__dirname, '../../../..');
const read = (file: string) => JSON.parse(readFileSync(path.join(root, file), 'utf8'));
const catalog = read('src/assets/catalog.json');
const disclosure = read('disclosure.json');
const cc0 = catalog.assets.filter(isCc0);

type Asset = { assetId: string; tags: string[]; provenance: { license: string; licenseEvidence: string }; lods: { path: string }[] };

describe('CC0 catalog entries', () => {
  it('exist and pass the provenance check: allowed licence, licence text on disk, disclosure for every file', () => {
    expect(cc0.length).toBeGreaterThan(0);
    expect(checkCatalog({ catalog, disclosure, root })).toEqual([]);
  });

  it('report a licence outside the allowlist, a missing licence text and a missing disclosure record', () => {
    const [first] = cc0 as Asset[];
    const tamper = (change: (asset: Asset) => void) => {
      const copy = structuredClone(catalog);
      change(copy.assets.find((asset: Asset) => asset.assetId === first.assetId));
      return checkCatalog({ catalog: copy, disclosure, root }).join('\n');
    };
    expect(tamper((asset) => { asset.provenance.license = 'CC-BY-NC-4.0'; })).toMatch(new RegExp(`${first.assetId}.*licen`));
    expect(tamper((asset) => { asset.provenance.licenseEvidence = 'public/assets/worldstream/cc0/licenses/missing.txt'; })).toMatch(/licen[cs]e text/);
    const stripped = { ...disclosure, entries: disclosure.entries.filter((entry: { name: string }) => entry.name !== `public${first.lods[0].path}`) };
    expect(checkCatalog({ catalog, disclosure: stripped, root }).join('\n')).toMatch(/disclosure/);
  });

  it('never take a tag that a project model already carries', () => {
    const own = new Set(catalog.assets.filter((asset: Asset) => !isCc0(asset)).flatMap((asset: Asset) => [asset.assetId, ...asset.tags]));
    for (const asset of cc0 as Asset[]) for (const tag of asset.tags.filter((tag) => !tag.startsWith('seen:'))) expect(own.has(tag), `${asset.assetId}: ${tag}`).toBe(false);
  });

  it('carry no purple vertex colour in any committed LOD', async () => {
    const io = new NodeIO();
    for (const asset of cc0 as Asset[]) {
      for (const lod of asset.lods) expect(purpleColours(await io.read(path.join(root, 'public', lod.path))), lod.path).toBeNull();
    }
  });
});

describe('size budget', () => {
  const model = (assetId: string, bytes: number) => ({ assetId, bytes });

  it('drops a model over the per-model cap and a model that would overrun the total, with a reason, in selection order', () => {
    const budget = { modelBytes: 300, totalBytes: 500 };
    const { kept, dropped } = fitBudget([model('a', 200), model('b', 301), model('c', 250), model('d', 300), model('e', 1)], budget);
    expect(kept.map((item) => item.assetId)).toEqual(['a', 'c', 'e']);
    expect(dropped.map((item) => item.assetId)).toEqual(['b', 'd']);
    expect(dropped[0].reason).toMatch(/301 B.*300 B per model/);
    expect(dropped[1].reason).toMatch(/total/);
  });

  it('holds in the committed catalog: every CC0 model under 300 kB, the folder under 80 MB, the report agrees', () => {
    expect(BUDGET).toEqual({ modelBytes: 300_000, totalBytes: 80_000_000 });
    for (const asset of cc0 as unknown as Array<Omit<Asset, 'lods'> & { lods: { bytes: number }[] }>) {
      expect(asset.lods.reduce((sum, lod) => sum + lod.bytes, 0), asset.assetId).toBeLessThanOrEqual(BUDGET.modelBytes);
    }
    const report = read('scripts/assets/cc0/promote-report.json');
    expect(folderBytes(path.join(root, 'public/assets/worldstream/cc0'))).toBeLessThanOrEqual(BUDGET.totalBytes);
    expect(report.promoted.map((item: { assetId: string }) => item.assetId).sort()).toEqual(cc0.map((asset: Asset) => asset.assetId).sort());
    for (const item of report.dropped) expect(item.reason, item.assetId).toBeTruthy();
  });

  it('reports a model over the cap and a folder over the total', () => {
    const [first] = cc0 as Array<Asset & { lods: { bytes: number }[] }>;
    const copy = structuredClone(catalog);
    copy.assets.find((asset: Asset) => asset.assetId === first.assetId).lods[0].bytes = BUDGET.modelBytes + 1;
    expect(checkCatalog({ catalog: copy, disclosure, root }).join('\n')).toMatch(new RegExp(`${first.assetId}.*300000 B`));
    expect(checkCatalog({ catalog, disclosure, root, budget: { ...BUDGET, totalBytes: 1 } }).join('\n')).toMatch(/cc0 folder/);
  });

  it('ships one contact sheet per category of the promoted models', () => {
    const report = read('scripts/assets/cc0/promote-report.json');
    const categories = new Set<string>(report.promoted.map((item: { category: string }) => item.category));
    expect(categories.size).toBeGreaterThanOrEqual(5);
    for (const category of categories) expect(existsSync(path.join(root, `public/assets/worldstream/cc0/_sheet-${category}.png`)), category).toBe(true);
  });
});

describe('cc0Tags', () => {
  it('uses the noun, its synonyms and file-name words, minus category, colour and shape words and taken tags', () => {
    expect(cc0Tags({ noun: 'corgi', file: 'Models/GLB format/animal-dog.glb', synonyms: ['dog'] }, new Set(['dog']))).toEqual(['corgi']);
    expect(cc0Tags({ noun: 'present', file: 'Models/GLB format/present-a-cube.glb', synonyms: ['gift'] }, new Set())).toEqual(['present', 'gift']);
    expect(cc0Tags({ noun: 'sock', file: 'Models/GLB format/sock-green.glb', synonyms: [] }, new Set())).toEqual(['sock']);
    expect(cc0Tags({ noun: 'asteroid', file: 'Models/GLB format/meteor.glb', synonyms: ['meteor'] }, new Set())).toEqual(['asteroid', 'meteor']);
  });

  it('never tags a compound noun with its modifier: a bear trap is no bear, a gas tank no battle tank', () => {
    expect(cc0Tags({ noun: 'bear trap', file: 'Environment/glTF/BearTrap_Closed.gltf', synonyms: ['bear trap', 'bear-trap', 'trap', 'bear'] }, new Set())).not.toContain('bear');
    expect(cc0Tags({ noun: 'gas tank', file: 'Environment/glTF/GasTank.gltf', synonyms: ['gas tank', 'gas-tank', 'tank', 'gas'] }, new Set())).toEqual(['gas tank', 'gas-tank']);
  });
});
