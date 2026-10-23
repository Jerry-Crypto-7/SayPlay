import { describe, expect, it } from 'vitest';

import { sampleTail, tally } from '../usage-tally.mjs';

/** Řádek sčítání scény (`scripts/play-scene-census.mjs`): obsazení, kulisy a vegetace jedné věty. */
const row = (id: string, setting: string, parts: { hero: string; enemy: string; cast?: string[]; scenery?: string[]; flora?: string[]; look?: string; kit?: number }) => ({
  id,
  setting,
  look: parts.look ?? 'meadow',
  kit: parts.kit ?? 0,
  hero: parts.hero,
  enemy: parts.enemy,
  cast: [parts.hero, parts.enemy, ...(parts.cast ?? [])],
  scenery: parts.scenery ?? [],
  flora: parts.flora ?? [],
});

const KNOWN = new Set(['gen3d-frog', 'gen3d-fly', 'gen3d-lily-pad', 'cc0-tree', 'gen3d-barn', 'gen3d-zombie', 'cc0-rock', 'gen3d-fence']);

describe('tally', () => {
  it('counts a model twice in one scene as one scene and two uses, per role', () => {
    const report = tally([row('a', 'pond', { hero: 'gen3d-frog', enemy: 'gen3d-fly', scenery: ['gen3d-lily-pad', 'cc0-tree'], flora: ['cc0-tree'] })], KNOWN);
    const tree = report.models.find((model) => model.id === 'cc0-tree');
    expect(tree).toMatchObject({ scenes: 1, uses: 2, roles: { scenery: 1, flora: 1 }, settings: { pond: 1 } });
    expect(report.models.find((model) => model.id === 'gen3d-frog')).toMatchObject({ scenes: 1, uses: 1, roles: { hero: 1 } });
    expect(report.models.find((model) => model.id === 'gen3d-fly')).toMatchObject({ roles: { enemy: 1 } });
  });

  it('keeps hero and enemy out of the cast role and counts other cast members there', () => {
    const report = tally([row('a', 'farm', { hero: 'gen3d-frog', enemy: 'gen3d-zombie', cast: ['gen3d-fence'] })], KNOWN);
    expect(report.models.find((model) => model.id === 'gen3d-fence')?.roles).toEqual({ cast: 1 });
    expect(report.models.find((model) => model.id === 'gen3d-frog')?.roles).toEqual({ hero: 1 });
  });

  it('puts ids outside the catalog into unknown, never into the ranking', () => {
    const report = tally([row('a', 'farm', { hero: 'rigged:q-fox', enemy: 'gen3d-zombie', scenery: ['shelf', 'shelf'] })], KNOWN);
    expect(report.models.map((model) => model.id)).toEqual(['gen3d-zombie']);
    expect(report.unknown).toEqual({ 'rigged:q-fox': { scenes: 1, uses: 1 }, shelf: { scenes: 1, uses: 2 } });
  });

  it('ranks by scenes, then uses, then id, and the top list follows the ranking', () => {
    const rows = [
      row('a', 'farm', { hero: 'gen3d-frog', enemy: 'gen3d-zombie', scenery: ['gen3d-barn', 'gen3d-barn'] }),
      row('b', 'farm', { hero: 'gen3d-frog', enemy: 'gen3d-zombie', scenery: ['cc0-rock'] }),
      row('c', 'pond', { hero: 'gen3d-frog', enemy: 'gen3d-fly', scenery: ['gen3d-barn'] }),
    ];
    const report = tally(rows, KNOWN, { top: 3 });
    expect(report.models.map((model) => [model.id, model.scenes, model.uses])).toEqual([
      ['gen3d-frog', 3, 3],
      ['gen3d-barn', 2, 3],
      ['gen3d-zombie', 2, 2],
      ['cc0-rock', 1, 1],
      ['gen3d-fly', 1, 1],
    ]);
    expect(report.top).toEqual(['gen3d-frog', 'gen3d-barn', 'gen3d-zombie']);
  });

  it('sorts settings by scenes and keeps their looks and kit sizes', () => {
    const rows = [
      row('a', 'Farm ', { hero: 'gen3d-frog', enemy: 'gen3d-zombie', look: 'farm', kit: 2 }),
      row('b', 'farm', { hero: 'gen3d-frog', enemy: 'gen3d-zombie', look: 'farm', kit: 2 }),
      row('c', 'pond', { hero: 'gen3d-frog', enemy: 'gen3d-fly', look: 'meadow' }),
    ];
    expect(tally(rows, KNOWN).settings).toEqual([
      { setting: 'farm', scenes: 2, looks: { farm: 2 }, kit: 2 },
      { setting: 'pond', scenes: 1, looks: { meadow: 1 }, kit: 0 },
    ]);
  });
});

describe('sampleTail', () => {
  const catalog = Array.from({ length: 50 }, (_, index) => `m${String(index).padStart(2, '0')}`);

  it('draws only from outside the top list, without repeats, and the same seed gives the same sample', () => {
    const top = catalog.slice(0, 10);
    const sample = sampleTail(catalog, top, { seed: 57, count: 20 });
    expect(sample).toHaveLength(20);
    expect(new Set(sample).size).toBe(20);
    expect(sample.some((id) => top.includes(id))).toBe(false);
    expect(sampleTail([...catalog].reverse(), top, { seed: 57, count: 20 })).toEqual(sample);
    expect(sampleTail(catalog, top, { seed: 58, count: 20 })).not.toEqual(sample);
  });

  it('returns the whole tail when it is smaller than the count', () => {
    expect(sampleTail(catalog, catalog.slice(0, 45), { seed: 57, count: 20 }).sort()).toEqual(catalog.slice(45));
  });
});
