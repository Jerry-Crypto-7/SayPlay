import { describe, expect, it } from 'vitest';
import { buildAssetBrief } from '../worldstream-asset-brief';
import { WORLDSTREAM_ASSETS } from '@/assets/catalog';
import { representationCandidates } from '@/assets/resolver';

const person = (index: number) => ({ stableId: `person${index}`, role: 'hero' as const,
  importance: 3 as const, synonyms: [], label: 'seated person' });

describe('request-specific shared asset dictionary', () => {
  it('preserves every ranked candidate and binding metadata with five separate identities', () => {
    const objects = Array.from({ length: 5 }, (_, index) => person(index));
    const old = objects.map(object => representationCandidates(object, WORLDSTREAM_ASSETS));
    const brief = buildAssetBrief(objects, WORLDSTREAM_ASSETS);
    expect(brief.objects.map(object => object.stableId)).toEqual(objects.map(object => object.stableId));
    for (const [index, object] of brief.objects.entries()) {
      expect(object.candidates.length).toBeGreaterThan(0);
      expect(object.candidates.map(key => brief.assets[key])).toEqual(old[index].candidates);
      for (const key of object.candidates) expect(key.length).toBeLessThan(64);
    }
    expect(Object.keys(brief.assets)).toHaveLength(old[0].candidates.length);
    expect(JSON.stringify(brief).length).toBeLessThan(JSON.stringify(old).length * 0.5);
    expect(JSON.stringify(brief)).not.toMatch(/https?:|\/assets\//);
  });

  it('does not leak unrelated catalog entries or substitute novel objects', () => {
    const unknown = { ...person(0), label: 'chronofolding zephyroscope' };
    const brief = buildAssetBrief([unknown], WORLDSTREAM_ASSETS);
    expect(brief.assets).toEqual({});
    expect(brief.objects[0]).toMatchObject({ stableId: 'person0', status: 'cache-miss', candidates: [],
      alternatives: ['authored shape', 'generation request (not available synchronously)'] });
    const aquarium = buildAssetBrief([{ ...unknown, label: 'aquarium' }], WORLDSTREAM_ASSETS);
    expect(Object.values(aquarium.assets).map(asset => asset.source.assetId)).toContain('aquarium');
    expect(Object.keys(aquarium.assets).length).toBeLessThan(WORLDSTREAM_ASSETS.candidates().length);
  });
});
