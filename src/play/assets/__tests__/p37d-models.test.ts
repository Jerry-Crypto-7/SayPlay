import { describe, expect, it } from 'vitest';

import catalog from '../../../assets/catalog.json';
import index from '../../../assets/catalog-index.json';
import { heroChoice, modelOf } from '../../arcade/models';
import { CATALOG_ENTRIES } from '../entries/catalog';

/**
 * Modely P37D (`scripts/p37d/promote-batch.mjs`) prošly celým řetězem katalogu až do PLAY:
 * jméno z věty – i v množném čísle – vybere nový model, ne náhradu z kategorie
 * (dřív „frog“ ukázal lišku). Hrdinou je model, jehož jméno zná třída
 * v `scripts/assets/p32-manifest.mjs`; ostatní vedou do hry přes štítky indexu.
 */

const P37D = '/assets/worldstream/gen3d-p37d/';
const ours = catalog.assets.filter((asset) => asset.lods[0].path.startsWith(P37D));

describe('P37D models in PLAY', () => {
  it('every promoted model reaches the index, and a hero noun reaches the PLAY manifest', () => {
    expect(ours.length).toBeGreaterThanOrEqual(10);
    for (const asset of ours) {
      expect(index.assets.find((entry) => entry.assetId === asset.assetId)?.path).toBe(`${P37D}${asset.assetId}-lod1.glb`);
    }
    expect(CATALOG_ENTRIES.find((entry) => entry.id === 'gen3d-frog')?.class).toBe('animal');
  });

  it.each([
    ['frog', 'gen3d-frog'],
    ['frogs', 'gen3d-frog'],
    ['submarine', 'gen3d-submarine'],
    ['monster truck', 'gen3d-monster-truck'],
    ['monster trucks', 'gen3d-monster-truck'],
  ])('the hero "%s" is drawn by %s', (label, model) => {
    expect(heroChoice(label, undefined, 'move_free').model).toBe(model);
  });

  it('the platformer hero "frog" is the new model, not a stand-in from the animal class', () => {
    expect(heroChoice('frog', 'platformer', 'platform')).toMatchObject({ model: 'gen3d-frog', level: 'identity' });
  });

  it.each([
    ['squirrel', 'gen3d-squirrel'],
    ['squirrels', 'gen3d-squirrel'],
    ['water gun', 'gen3d-water-gun'],
    ['washing machine', 'gen3d-washing-machine'],
    ['conveyor belt', 'gen3d-conveyor-belt'],
    ['bug', 'gen3d-bug'],
  ])('the prop "%s" is drawn by %s', (label, model) => {
    expect(modelOf(label, false)).toBe(model);
  });
});
