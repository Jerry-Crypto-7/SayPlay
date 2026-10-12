/**
 * Sady prostředí arkády (P26 T11): výběr podle slov, pořadí klíčových slov,
 * pokrytí prostředí ze sady věrnosti a žádná fialová v paletě.
 */

import { describe, expect, it } from 'vitest';

import corpus from '../../../evals/play/fidelity/corpus.json';
import catalog from '@/assets/catalog-index.json';

import { sceneryPlaces } from '@/components/play/arcade/look/Scenery';

import { LOOKS, LOOK_IDS, PROP_KINDS, SCENERY_MODELS, isSceneryModel, kitFor, lookFor, lookOf, sceneLook } from '../arcade/look';
import settingKits from '../arcade/look/setting-kits.json';
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
    ['family vacation', 'beach'],
    ['a winter holiday', 'snow'],
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
    // Dřív chyběla „tower“ (věž = sama trať z plošin). P30B T6: porota věž z plošin nad
    // vodou nepoznala, samotná věž je proto hrad s věžemi a kamennými plošinami.
    expect(missing).toEqual([]);
  });
});

describe('kulisy z katalogu', () => {
  it('každý model kulis katalog má a každá sada aspoň jeden nese (P28D T6)', () => {
    const ids = new Set(catalog.assets.map((asset) => asset.assetId));
    expect(Object.keys(SCENERY_MODELS).filter((id) => !ids.has(id))).toEqual([]);
    const primitiveOnly = LOOK_IDS.filter((id) => !LOOKS[id].props.some(isSceneryModel));
    // Od 28. 9. má i sopka model z gen3d, primitiv `volcano` zůstal vedle něj.
    expect(primitiveOnly).toEqual([]);
  });

  it('rekvizity prostředí jsou modely katalogu a každé prostředí má aspoň jednu (P45H T2)', () => {
    const ids = new Set(catalog.assets.map((asset) => asset.assetId));
    expect(settingKits.kits.length).toBeGreaterThanOrEqual(20);
    expect(settingKits.kits.filter((kit) => kit.props.length === 0).map((kit) => kit.setting)).toEqual([]);
    expect(settingKits.kits.flatMap((kit) => kit.props.filter((prop) => !ids.has(prop.id) || !(prop.height > 0)).map((prop) => prop.id))).toEqual([]);
    expect(settingKits.kits.filter((kit) => !(LOOK_IDS as readonly string[]).includes(kit.look)).map((kit) => kit.setting)).toEqual([]);
  });

  it('sady nesou jen primitivy a modely ze SCENERY_MODELS (id gen3d-* typ nehlídá)', () => {
    const unknown = LOOK_IDS.flatMap((id) => LOOKS[id].props.filter((prop) => !(PROP_KINDS as readonly string[]).includes(prop) && !Object.hasOwn(SCENERY_MODELS, prop)));
    expect(unknown).toEqual([]);
  });
});

describe('rekvizity prostředí (P45H T3)', () => {
  it.each([
    ['ice fishing on a frozen lake', ['gen3d-ice-fishing-hut', 'gen3d-ice-floe']],
    ['race cars on the highway', ['gen3d-toll-booth', 'gen3d-highway-sign']],
    ['a cat runs through a supermarket', ['gen3d-checkout-counter', 'gen3d-shopping-basket']],
    ['a canyon', ['gen3d-rock-arch', 'gen3d-mesa']],
    // Nejdelší shoda vyhrává: pouštní kaňon má vlastní kit.
    ['a desert canyon', ['gen3d-rock-arch']],
    ['Haunted Mansion at midnight', ['gen3d-candelabra', 'gen3d-grandfather-clock', 'gen3d-chandelier']],
    // Návrh z „escape the haunted mansion“ píše místo jen „mansion“.
    ['mansion', ['gen3d-candelabra', 'gen3d-grandfather-clock', 'gen3d-chandelier']],
    ['a dog runs in a park', []],
    ['a completely different place', []],
  ] as const)('%s → %j', (setting, props) => {
    expect(kitFor(setting)).toEqual(props);
  });

  const theme = (setting: string) => ({ setting, mood: 'playful' });
  const kinds = (props: Parameters<typeof sceneryPlaces>[0], layout: 'sides' | 'behind') => sceneryPlaces(props, layout, 6, 0, 120).map((place) => place.kind);

  it('věta bez kitu má sadu beze změny', () => {
    expect(sceneLook(theme('a dog runs in a park'))).toBe(LOOKS.meadow);
    expect(sceneLook(theme('a cozy living room at night')).props).toBe(LOOKS.living_room.props);
    expect(sceneLook({ ...theme('busy city traffic'), look: 'city' }).props).toBe(LOOKS.city.props);
  });

  it.each([
    ['ice fishing on a frozen lake', 'snow'],
    ['a cat runs through a supermarket', 'supermarket'],
    ['a cat runs through a shopping mall', 'mall'],
    ['race cars on the highway', 'city'],
    ['a canyon', 'desert'],
  ] as const)('%s: kit stojí místo části sady, kulis není víc (%s)', (setting, look) => {
    const kit = kitFor(setting);
    const props = sceneLook(theme(setting)).props;
    expect(lookOf(theme(setting))).toBe(look);
    for (const layout of ['sides', 'behind'] as const) {
      const before = kinds(LOOKS[look].props, layout);
      const after = kinds(props, layout);
      expect(after).toHaveLength(before.length);
      // Každá rekvizita kitu ve scéně opravdu stojí, a sada v ní pořád je.
      expect(kit.filter((id) => !after.includes(id))).toEqual([]);
      expect(after.some((kind) => (LOOKS[look].props as readonly string[]).includes(kind))).toBe(true);
    }
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
