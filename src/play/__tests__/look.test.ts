/**
 * Sady prostředí arkády (P26 T11): výběr podle slov, pořadí klíčových slov,
 * pokrytí prostředí ze sady věrnosti, nálada z věty (P46G T5) a žádná fialová v paletě.
 */

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import corpus from '../../../evals/play/fidelity/corpus.json';
import catalog from '@/assets/catalog-index.json';
import { color } from '@/brand/tokens';

import { sceneryPlaces } from '@/components/play/arcade/look/Scenery';
import type { ArcadeSession } from '@/components/play/arcade/session';
import { Weather } from '@/components/play/arcade/Weather';

import { type Look, LOOKS, LOOK_IDS, PROP_KINDS, SCENERY_MODELS, STORM_WIND, isSceneryModel, kitFor, lookFor, lookOf, moodFor, sceneLook } from '../arcade/look';
import settingKits from '../arcade/look/setting-kits.json';
import { type GameSpecV1, readGameSpec } from '../spec';
import runner from '../arcade/__fixtures__/runner.json';
import { draftGameSpecWithMeta } from '../draft';
import p46g from '../../../evals/play/p46g/sentences.json';

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

  // P46J: scenérie z P46I stojí v sadách místo primitiv a starších kulis; rostliny jdou do vegetace.
  it.each([
    ['meadow', ['gen3d-picnic-table', 'gen3d-wooden-stile', 'gen3d-wooden-gate'], ['gen3d-poppy-flower', 'gen3d-buttercup']],
    ['forest', ['gen3d-forest-shrine', 'gen3d-standing-stone'], ['gen3d-fern', 'gen3d-mushroom-cluster', 'gen3d-wild-strawberry-plant']],
    ['jungle', ['gen3d-bamboo-hut', 'gen3d-jungle-waterfall'], ['gen3d-heliconia', 'gen3d-pitcher-plant', 'gen3d-rafflesia']],
    ['desert', ['gen3d-western-saloon', 'gen3d-buried-statue-head', 'gen3d-abandoned-mine-entrance'], ['gen3d-desert-shrub', 'gen3d-yucca-plant', 'gen3d-mesquite-tree']],
    ['beach', ['gen3d-beach-chair', 'gen3d-surf-rack'], []],
    ['snow', ['gen3d-snowy-bench', 'gen3d-ice-arch'], []],
    ['underwater', ['gen3d-staghorn-coral', 'gen3d-kelp', 'gen3d-barnacle-rock'], []],
    ['city', ['gen3d-telephone-pole', 'gen3d-flower-stall'], []],
    ['ocean', ['gen3d-navigation-buoy', 'gen3d-floating-dock'], []],
    ['factory', ['gen3d-smokestack', 'gen3d-industrial-fan'], []],
    ['living_room', ['gen3d-gramophone'], []],
    ['supermarket', ['gen3d-bread-rack'], []],
    ['mall', ['gen3d-gumball-machine'], []],
    ['volcano', ['gen3d-magma-rock', 'gen3d-steam-vent'], []],
    ['cave', ['gen3d-stalagmite', 'gen3d-crystal-geode', 'gen3d-glowing-mushroom'], []],
    ['space', ['gen3d-fuel-silo', 'gen3d-moon-flag'], []],
    ['castle', ['gen3d-castle-tower', 'gen3d-stone-gatehouse'], []],
    ['graveyard', ['gen3d-iron-fence', 'gen3d-grave-lantern'], []],
  ] as const)('%s nese scenérii P46I (P46J)', (id, props, plants) => {
    const look = LOOKS[id];
    expect(props.filter((prop) => !(look.props as readonly string[]).includes(prop))).toEqual([]);
    const flora = new Set([...(look.flora?.near ?? []), ...(look.flora?.mid ?? []), ...(look.flora?.far ?? [])].map((species) => species.id));
    expect(plants.filter((plant) => !flora.has(plant))).toEqual([]);
    // Sporné modely P46I (soudce je poznal jen přes poslední slovo nebo alternativu) v katalogu nejsou.
    const ids = new Set(catalog.assets.map((asset) => asset.assetId));
    expect(['gen3d-claw-machine', 'gen3d-coral-pillar', 'gen3d-cypress-tree'].filter((dropped) => ids.has(dropped))).toEqual([]);
  });
});

describe('rekvizity prostředí (P45H T3)', () => {
  // P57 T9: zamrzlé jezero, dálnice, supermarket, kaňon, pouštní kaňon a park mají sady z knihovny (`look/__tests__/setting-kits.test.ts`).
  it('nejdelší shoda vyhrává: pouštní kaňon má vlastní sadu, ne sadu kaňonu', () => {
    expect(kitFor('a desert canyon')[0]).toBe('gen3d-cow-skull');
    expect(kitFor('a desert canyon')).not.toEqual(kitFor('a canyon'));
  });

  it.each([
    ['Haunted Mansion at midnight', ['gen3d-candelabra', 'gen3d-grandfather-clock', 'gen3d-chandelier']],
    // Návrh z „escape the haunted mansion“ píše místo jen „mansion“.
    ['mansion', ['gen3d-candelabra', 'gen3d-grandfather-clock', 'gen3d-chandelier']],
    // P46G T8: stavby a věci z generování vegetace i v obecných prostředích sad.
    ['A buggy races across the desert', ['gen3d-adobe-house', 'gen3d-bedouin-tent', 'gen3d-oasis-well', 'gen3d-stone-obelisk']],
    // P46I: přístav dostal k molu záchranný kruh, kotvu a uvazovací patník.
    ['a harbour at dawn', ['gen3d-wooden-pier', 'gen3d-lifebuoy', 'gen3d-anchor', 'gen3d-mooring-bollard']],
    ['a dog runs in a field', []],
    ['a completely different place', []],
  ] as const)('%s → %j', (setting, props) => {
    expect(kitFor(setting)).toEqual(props);
  });

  const theme = (setting: string) => ({ setting, mood: 'playful' });
  const kinds = (props: Parameters<typeof sceneryPlaces>[0], layout: 'sides' | 'behind') => sceneryPlaces(props, layout, 6, 0, 120).map((place) => place.kind);

  it('věta bez kitu má sadu beze změny', () => {
    expect(sceneLook(theme('a dog runs in a field'))).toBe(LOOKS.meadow);
    // Obývák má od modelů P45I vlastní kit (konferenční stolek), park od P46G T8, město od P57 T9, proto tu už nejsou.
    expect(sceneLook({ ...theme('a busy factory'), look: 'factory' }).props).toBe(LOOKS.factory.props);
  });

  it.each([
    ['ice fishing on a frozen lake', 'snow'],
    ['a cat runs through a supermarket', 'supermarket'],
    ['a cat runs through a shopping mall', 'mall'],
    ['race cars on the highway', 'city'],
    ['a canyon', 'desert'],
    // Obecná prostředí sad (P46G T8): kit délky 7 by z řady kroku 7 nechal jen dvě rekvizity.
    ['a fox runs through a forest', 'forest'],
    ['a jeep races through the jungle', 'jungle'],
    ['a buggy races across the desert', 'desert'],
    ['a taxi races downtown', 'city'],
    ['a crab runs on the beach', 'beach'],
    ['a penguin slides through the snow', 'snow'],
  ] as const)('%s: kit stojí místo části sady, kulis není víc (%s)', (setting, look) => {
    const kit = kitFor(setting);
    const props = sceneLook(theme(setting)).props;
    expect(lookOf(theme(setting))).toBe(look);
    for (const layout of ['sides', 'behind'] as const) {
      const before = kinds(LOOKS[look].props, layout);
      const after = kinds(props, layout);
      expect(after).toHaveLength(before.length);
      // Každá rekvizita kitu ve scéně opravdu stojí, a sada v ní pořád je. Sada P57 (15–25 kulis) se do 120 m
      // nevejde celá: na trati, která seznam projde aspoň jednou (krok 7 m), nesmí zůstat žádná mrtvá.
      const long = sceneryPlaces(props, layout, 6, 0, props.length * 7).map((place) => place.kind);
      expect(kit.filter((id) => !(kit.length > 8 ? long : after).includes(id))).toEqual([]);
      expect(after.some((kind) => (LOOKS[look].props as readonly string[]).includes(kind))).toBe(true);
    }
  });
});

/** Relativní jas `#rrggbb` (lineární sRGB). */
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((at) => {
    const channel = Number.parseInt(hex.slice(at, at + 2), 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

describe('nálada z věty (P46G T5)', () => {
  it.each([
    ['dark forest', 'gloom'],
    ['a gloomy swamp', 'gloom'],
    ['shadowy alleys', 'gloom'],
    ['a haunted castle', 'spooky'],
    ['a creepy dark forest', 'spooky'],
    ['a stormy sea', 'storm'],
    ['a rainy city', 'storm'],
    ['a foggy harbour', 'fog'],
    ['misty hills', 'fog'],
    ['a sunny beach', 'bright'],
    ['a bright meadow', 'bright'],
    ['forest at sunset', 'dusk'],
    ['a rainforest', null],
    ['a train station', null],
    ['forest', null],
  ] as const)('%s → %s', (setting, mood) => {
    expect(moodFor(setting, 'fast')).toBe(mood);
  });

  it('čte i náladu specu, nejen místo', () => {
    expect(moodFor('a forest', 'dark and tense')).toBe('gloom');
    expect(sceneLook({ setting: 'somewhere', mood: 'sunset' }).horizon).toBe(sceneLook({ setting: 'somewhere at dusk', mood: '' }).horizon);
  });

  // Návrh z věty, jak ho staví rychlá verze.
  const sentenceLook = (sentence: string) => sceneLook(draftGameSpecWithMeta(sentence).spec.theme);

  it('„dark forest“ je tmavší než les: obloha a mlha, slunce, dohled; zem zůstane', () => {
    const forest = sentenceLook('A race car speeds through a forest');
    const dark = sentenceLook('A race car speeds through a dark forest');
    expect(dark).not.toEqual(forest);
    expect(luminance(dark.horizon)).toBeLessThan(luminance(forest.horizon) / 2);
    expect(luminance(dark.skyTop)).toBeLessThan(luminance(forest.skyTop));
    expect(dark.sun).toBeLessThan(forest.sun / 2);
    expect(dark.fog[1]).toBeLessThan(forest.fog[1]);
    expect(dark.ground).toBe(forest.ground);
  });

  it('noc přebije náladu', () => {
    const night = sceneLook({ setting: 'a forest at night', mood: 'fast' });
    // Vítr bouřky fouká i v noci (P54B T13); světlo je noci.
    for (const setting of ['a sunny forest at night', 'a dark creepy forest at night', 'a stormy foggy forest at night']) expect({ ...sceneLook({ setting, mood: 'fast' }), wind: undefined }, setting).toEqual(night);
    expect(sceneLook({ setting: 'a stormy foggy forest at night', mood: 'fast' }).wind).toBe(STORM_WIND);
    expect(sceneLook({ setting: 'a sunny forest', mood: 'dark', timeOfDay: 'night' })).toEqual(night);
  });

  it('věta bez slov nálady má sadu beze změny', () => {
    // Světlo sady; rekvizity smí změnit kit prostředí (P46G T8: les, džungle, poušť).
    const light = ({ sky, skyTop, horizon, light: hemisphere, sun, sunColor, glow, fog, exposure }: Look) => ({ sky, skyTop, horizon, hemisphere, sun, sunColor, glow, fog, exposure });
    // Dnešní věty P46G kromě „dark forest“ a nálady, které píšou žánry a režisér.
    for (const sentence of p46g.sentences.filter((entry) => entry.id !== 'forest-race')) {
      const theme = draftGameSpecWithMeta(sentence.text).spec.theme;
      expect(light(sceneLook(theme)), sentence.text).toEqual(light(LOOKS[lookOf(theme)]));
    }
    for (const mood of ['energetic', 'fast', 'playful', 'tense', 'adventurous', 'cheerful', 'cozy', 'curious', 'calm', 'eerie', 'dreamy', 'electric']) {
      expect(moodFor('a forest', mood)).toBeNull();
      expect(sceneLook({ setting: 'a busy factory', mood })).toBe(LOOKS.factory);
    }
  });

  const moods = ['a dark place', 'a spooky place', 'a stormy place', 'a foggy place', 'a sunny place', 'a spooky place at dusk'];
  /** Jas matné plochy pod světlem sady: polokoule shora a slunce, krát expozice. simplified: bez úhlů a ACES – stačí na porovnání nálady s nocí téže sady. */
  const lit = (albedo: string, look: Look) => luminance(albedo) * look.exposure * (look.light[2] * luminance(look.light[0]) + look.sun * luminance(look.sunColor));
  const contrast = (look: Look, albedo: string) => Math.abs(lit(albedo, look) - lit(look.ground, look));

  it.each(LOOK_IDS)('%s zůstane v náladě čitelná: hrdina a překážky proti zemi aspoň jako v noci', (id) => {
    const night = sceneLook({ setting: 'a place', mood: '', look: id, timeOfDay: 'night' });
    for (const setting of moods) {
      const moody = sceneLook({ setting, mood: '', look: id });
      // Nálada tmavší než noc se zvedne přesně na noc: tolerance jen na zaokrouhlení.
      for (const albedo of [color.tomato, color.sun, color.ink, color.paper]) expect(contrast(moody, albedo), `${setting} ${albedo}`).toBeGreaterThanOrEqual(contrast(night, albedo) * (1 - 1e-9));
    }
  });

  it('nálada nepřidá fialovou (odstín 250–320°, sytost nad 0,05)', () => {
    const purple = (hex: string) => {
      const [r, g, b] = [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16) / 255) as [number, number, number];
      const [max, min] = [Math.max(r, g, b), Math.min(r, g, b)];
      if (max === min) return false;
      const saturation = (max - min) / (1 - Math.abs(max + min - 1));
      const raw = max === r ? ((g - b) / (max - min)) % 6 : max === g ? (b - r) / (max - min) + 2 : (r - g) / (max - min) + 4;
      const h = (raw * 60 + 360) % 360;
      return h >= 250 && h <= 320 && saturation > 0.05;
    };
    expect(purple('#7c3aed')).toBe(true);
    const colors = LOOK_IDS.flatMap((id) =>
      moods.flatMap((setting) => {
        const look = sceneLook({ setting, mood: '', look: id });
        return [look.sky, look.skyTop, look.horizon, look.light[0], look.light[1], look.sunColor];
      }),
    );
    expect(colors.filter(purple)).toEqual([]);
  });

  it('bouřka z věty prší, počasí specu má přednost', () => {
    const weather = (theme: GameSpecV1['theme']) => renderToStaticMarkup(createElement(Weather, { session: {} as ArcadeSession, theme }));
    expect(weather({ setting: 'a stormy city', mood: 'tense' })).toContain('data-weather="rain"');
    expect(weather({ setting: 'a city', mood: 'tense' })).toBe('');
    expect(weather({ setting: 'a stormy city', mood: 'tense', weather: 'snow' })).toContain('data-weather="snow"');
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
