/**
 * Sady prostředí arkády (P26 T11): výběr podle slov, pořadí klíčových slov,
 * pokrytí prostředí ze sady věrnosti a žádná fialová v paletě.
 */

import { describe, expect, it } from 'vitest';

import corpus from '../../../evals/play/fidelity/corpus.json';
import catalog from '@/assets/catalog-index.json';

import { LOOKS, LOOK_IDS, SCENERY_MODELS, isSceneryModel, lookFor, lookOf } from '../arcade/look';
import { readGameSpec } from '../spec';
import runner from '../arcade/__fixtures__/runner.json';

describe('lookFor', () => {
  it.each([
    ['a haunted castle', 'castle'],
    ['an icy moon', 'space'],
    ['a jungle river full of crocodiles', 'jungle'],
    ['behind a snow fort', 'snow'],
    ['a supermarket at night', 'supermarket'],
    ['a shopping mall', 'mall'],
    ['sunken ruins on the sea floor', 'underwater'],
    ['the australian outback', 'desert'],
    ['a haunted hospital', 'graveyard'],
    ['a mining colony', 'factory'],
    ['busy city traffic', 'city'],
    ['on a volcano', 'volcano'],
    ['a cozy living room', 'living_room'],
    ['a sunny beach', 'beach'],
    ['the open ocean', 'ocean'],
    ['a pine forest', 'forest'],
    ['the park', 'meadow'],
  ] as const)('%s → %s', (setting, look) => {
    expect(lookFor(setting)).toBe(look);
  });

  it('nálada rozhoduje, jen když místo nic neřekne', () => {
    expect(lookFor('a shopping mall', 'spooky')).toBe('mall');
    expect(lookFor('somewhere', 'spooky')).toBe('graveyard');
    expect(lookFor('a completely different place', 'playful')).toBeNull();
  });

  it('volba modelu má přednost před slovy, bez obojího louka', () => {
    expect(lookOf({ setting: 'a shopping mall', mood: 'tense', look: 'snow' })).toBe('snow');
    expect(lookOf({ setting: 'a completely different place', mood: 'playful' })).toBe('meadow');
  });

  it('každou sadu jde vybrat slovy', () => {
    const samples = ['park', 'city street', 'mall', 'supermarket', 'living room', 'factory', 'forest', 'jungle', 'desert', 'beach', 'ocean', 'under water', 'snow', 'volcano', 'cave', 'mars', 'castle', 'graveyard'];
    expect(new Set(samples.map((sample) => lookFor(sample)))).toEqual(new Set(LOOK_IDS));
  });
});

describe('sada věrnosti', () => {
  it('každé prostředí z kontrolního seznamu má sadu', () => {
    const settings = corpus.sentences.flatMap((entry) => entry.checklist.filter((item) => item.slot === 'setting').map((item) => item.item));
    const missing = settings.filter((setting) => lookFor(setting) === null);
    expect(settings.length).toBeGreaterThanOrEqual(20);
    // „a tower of moving platforms“: věž je sama trať z plošin, ne prostředí kolem ní.
    expect(missing).toEqual(['tower']);
  });
});

describe('kulisy z katalogu', () => {
  it('každý model kulis katalog má a každá sada aspoň jeden nese (P28D T6)', () => {
    const ids = new Set(catalog.assets.map((asset) => asset.assetId));
    expect(Object.keys(SCENERY_MODELS).filter((id) => !ids.has(id))).toEqual([]);
    const primitiveOnly = LOOK_IDS.filter((id) => !LOOKS[id].props.some(isSceneryModel));
    // Sopka stojí na vlastním primitivu `volcano`: katalog kužel sopky nemá.
    expect(primitiveOnly).toEqual(['volcano']);
  });
});

describe('spec', () => {
  it('theme.look se čte jen ze seznamu sad', () => {
    expect(readGameSpec({ ...runner, theme: { ...runner.theme, look: 'space' } }).ok).toBe(true);
    expect(readGameSpec({ ...runner, theme: { ...runner.theme, look: 'moonbase' } }).ok).toBe(false);
  });
});

/** Odstín v stupních z `#rrggbb`; `null` pro šedou. */
function hue(hex: string): number | null {
  const [r, g, b] = [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16) / 255) as [number, number, number];
  const max = Math.max(r, g, b);
  const delta = max - Math.min(r, g, b);
  if (delta < 0.04) return null;
  const raw = max === r ? ((g - b) / delta) % 6 : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4;
  return (raw * 60 + 360) % 360;
}

it('žádná barva sad není fialová (odstín 250–320°)', () => {
  const colors = Object.values(LOOKS).flatMap((look) => [look.sky, look.light[0], look.light[1], look.ground, look.track, look.water, ...look.tint]);
  const purple = colors.filter((color) => {
    const h = hue(color);
    return h !== null && h >= 250 && h <= 320;
  });
  expect(purple).toEqual([]);
});
