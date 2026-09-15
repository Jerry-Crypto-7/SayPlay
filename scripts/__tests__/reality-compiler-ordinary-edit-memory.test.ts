import { describe, expect, it } from 'vitest';
import { ORDINARY_MEMORY_SEQUENCE, ordinaryMemoryFixture, ordinaryMemoryFixtureHashes,
  validateOrdinaryMemorySamples, type OrdinaryMemorySample } from '../reality-compiler-ordinary-edit-memory';

function samples(): OrdinaryMemorySample[] {
  return ORDINARY_MEMORY_SEQUENCE.map((variant, index) => ({ variant, edit: index + 1,
    workerJobs: 1 + Math.min(index + 1, 17), representationId: `representation-${index}`,
    memory: { geometries: 7, textures: 4, programs: 6 },
    mesh: { outcome: 'completed', provenance: index === 17 ? 'cache' : 'prepared', elapsedMs: 10 },
    frame: { outcome: 'completed', elapsedMs: 1 } }));
}
describe('ordinary browser eviction evidence', () => {
  it('freezes seventeen distinct valid programs and revisits evicted then recent values', () => {
    expect(ORDINARY_MEMORY_SEQUENCE).toEqual([...Array.from({ length: 16 }, (_, i) => i + 1), 0, 16]);
    expect(new Set(ordinaryMemoryFixtureHashes().map(item => item.sha256)).size).toBe(17);
    for (let variant = 0; variant <= 16; variant++) expect(ordinaryMemoryFixture(variant).shapes).toHaveLength(1);
    expect(() => ordinaryMemoryFixture(17)).toThrow('FIXED_VARIANT_REQUIRED');
  });
  it('requires actual eviction miss followed by recent hit and stable resource counts', () => {
    expect(validateOrdinaryMemorySamples(1, samples()).status).toBe('PASS');
    const bad = samples(); bad[16].mesh.provenance = 'cache'; bad[16].workerJobs--;
    expect(validateOrdinaryMemorySamples(1, bad).status).toBe('FAIL');
    const grew = samples(); grew[17].memory.geometries++;
    expect(validateOrdinaryMemorySamples(1, grew).status).toBe('FAIL');
  });
  it('does not grant complete frame or resource credit to partial/unchanged observations', () => {
    expect(validateOrdinaryMemorySamples(1, samples().slice(0, 17)).status).toBe('FAIL');
    const pending = samples(); pending[3].frame = null;
    expect(validateOrdinaryMemorySamples(1, pending).status).toBe('FAIL');
    const unchanged = samples(); unchanged[8].representationId = unchanged[7].representationId;
    expect(validateOrdinaryMemorySamples(1, unchanged).status).toBe('FAIL');
    const unknown = samples(); unknown[0].mesh.elapsedMs = null;
    expect(validateOrdinaryMemorySamples(1, unknown).status).toBe('FAIL');
  });
});
