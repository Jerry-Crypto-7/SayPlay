import { expect, it } from 'vitest';
import { representationCandidates } from '../resolver';
import { WORLDSTREAM_ASSETS } from '../catalog';

it('offers known aquarium metadata while an unknown object stays a cache miss', () => {
  const base = { stableId:'hero',role:'hero' as const,importance:3 as const,synonyms:[] };
  const known = representationCandidates({...base,label:'aquarium'},WORLDSTREAM_ASSETS);
  expect(known.candidates[0].source.assetId).toBe('aquarium');
  expect(known.candidates[0].bounds.max[1]).toBeGreaterThan(0);
  const novel = representationCandidates({...base,label:'chronofolding zephyroscope'},WORLDSTREAM_ASSETS);
  expect(novel.status).toBe('cache-miss'); expect(novel.stableId).toBe('hero');
  expect(novel.candidates).toEqual([]);
});
