/**
 * Vegetace podél cesty (P46G T4). Pinuje se, co by na snímku vypadalo dobře,
 * a přesto bylo špatně: rostlina ve volném pásu kolem cesty (v zatáčce zakryje
 * cestu), telefon se stejnou hustotou jako desktop, jiný les při každém
 * načtení hry, zrcadlové dvojice po stranách cesty a oranžové jehličnany
 * v letním lese.
 */

import { Color, type HSL, SRGBColorSpace } from 'three';
import { describe, expect, it } from 'vitest';

import catalog from '@/assets/catalog-index.json';
import { FLORA_SPECIES, type Flora, floraIds, landmarks, LOOK_IDS, LOOKS, sceneLook } from '@/play/arcade/look';

import { type StripSegment, stripCurve } from '../road-strip';
import { type AroundOptions, LAYERS, LOW_TOWARD_CAMERA, NONE_TOWARD_CAMERA, PHONE_SHARE, type Plant, type RoadAt, type VegetationOptions, placeAround, placeVegetation, plantPaint } from '../vegetation-places';

/** Silnice závodu se šikanou, zúžením a rozšířením. */
const SEGMENTS: readonly StripSegment[] = [
  { near: -60, far: 40, center: 0, width: 10 },
  { near: 40, far: 70, center: 6, width: 10 },
  { near: 70, far: 140, center: -3, width: 7 },
  { near: 140, far: 260, center: 2, width: 12 },
];
const curve = stripCurve(SEGMENTS);
const RACE = (z: number): RoadAt => {
  const { center, width } = curve(z);
  return { center, half: width / 2 };
};
/** Cesta běžce před ohnutím: rovná v ose. */
const RUNNER = (): RoadAt => ({ center: 0, half: 3.8 });

const FLORAS = LOOK_IDS.flatMap((id) => {
  const flora = LOOKS[id].flora;
  return flora === undefined ? [] : [[id, flora] as const];
});
const FOREST = LOOKS.forest.flora!;

const optionsOf = (flora: Flora, overrides: Partial<VegetationOptions> = {}): VegetationOptions => ({ flora, seed: 11, from: -60, to: 260, road: RACE, clear: 1.5, profile: 'desktop', ...overrides });

/** Nejmenší odstup půdorysu od kraje cesty (m) po celé délce půdorysu; cesta se čte po 10 cm, hustěji než rozmístění. */
function gapOf(plant: Plant, road: (z: number) => RoadAt): number {
  let least = Infinity;
  for (let z = plant.z - plant.reach; z <= plant.z + plant.reach + 1e-9; z += 0.1) {
    const { center, half } = road(z);
    least = Math.min(least, Math.abs(plant.x - center) - plant.reach - half);
  }
  return least;
}

const hueOf = (hex: string | Color): number => {
  const hsl: HSL = { h: 0, s: 0, l: 0 };
  (typeof hex === 'string' ? new Color(hex) : hex).getHSL(hsl, SRGBColorSpace);
  return hsl.h * 360;
};

describe('rozmístění vegetace', () => {
  it('sady s vegetací jsou les, džungle, louka, poušť, pláž a sníh', () => {
    // Pláž a sníh od P46G T8; město ne – řada domů vedle vegetace by zřídla na jeden dům za 24 m.
    expect(FLORAS.map(([id]) => id)).toEqual(['meadow', 'forest', 'jungle', 'desert', 'beach', 'snow']);
  });

  it('tatáž hra dá tutéž vegetaci, jiné semínko jinou', () => {
    const a = placeVegetation(optionsOf(FOREST));
    expect(placeVegetation(optionsOf(FOREST))).toEqual(a);
    expect(placeVegetation(optionsOf(FOREST, { seed: 12 }))).not.toEqual(a);
  });

  it.each(FLORAS)('%s: žádná rostlina nesahá do volného pásu kolem cesty (závod i běžec)', (_, flora) => {
    for (const [road, clear] of [[RACE, 1.5], [RUNNER, 1.2]] as const) {
      const plants = placeVegetation(optionsOf(flora, { road, clear }));
      expect(plants.length).toBeGreaterThan(100);
      const inside = plants.filter((plant) => gapOf(plant, road) < clear - 0.02);
      expect(inside.map((plant) => `${plant.id} z=${plant.z.toFixed(1)} gap=${gapOf(plant, road).toFixed(2)}`)).toEqual([]);
    }
  });

  it.each(FLORAS)('%s: telefon nese nejvýš 60 % rostlin desktopu, a to jejich podmnožinu', (_, flora) => {
    const desktop = placeVegetation(optionsOf(flora));
    const phone = placeVegetation(optionsOf(flora, { profile: 'phone' }));
    expect(phone.length).toBeGreaterThan(0);
    expect(phone.length).toBeLessThanOrEqual(0.6 * desktop.length);
    expect(phone.length).toBeGreaterThanOrEqual(0.9 * PHONE_SHARE * desktop.length);
    const kept = new Set(desktop.map((plant) => `${plant.id}:${plant.x}:${plant.z}`));
    expect(phone.filter((plant) => !kept.has(`${plant.id}:${plant.x}:${plant.z}`))).toEqual([]);
  });

  it('les je hustý ve všech třech vrstvách: na 100 m trati stovky rostlin desktopu', () => {
    const plants = placeVegetation(optionsOf(FOREST));
    const per100 = (layer: Plant['layer']): number => (plants.filter((plant) => plant.layer === layer).length * 100) / 320;
    expect(per100('near')).toBeGreaterThan(150);
    expect(per100('mid')).toBeGreaterThan(40);
    expect(per100('far')).toBeGreaterThan(100);
    // Linie v dálce leží za středem, drobnosti u cesty.
    const offset = (plant: Plant): number => Math.abs(plant.x - RACE(plant.z).center) - RACE(plant.z).half;
    const mean = (layer: Plant['layer']): number => plants.filter((plant) => plant.layer === layer).reduce((sum, plant) => sum + offset(plant), 0) / plants.filter((plant) => plant.layer === layer).length;
    expect(mean('near')).toBeLessThan(mean('mid'));
    expect(mean('mid')).toBeLessThan(mean('far'));
  });

  it.each(FLORAS)('%s: žádné dvě rostliny nejsou zrcadlem přes osu cesty a nestojí v pravidelné řadě', (_, flora) => {
    const plants = placeVegetation(optionsOf(flora));
    const offset = (plant: Plant): number => plant.x - RACE(plant.z).center;
    const mirrored = plants.flatMap((a, i) => plants.slice(i + 1).filter((b) => a.id === b.id && Math.abs(a.z - b.z) < 0.01 && Math.abs(offset(a) + offset(b)) < 0.01).map((b) => `${a.id} z=${a.z.toFixed(2)}/${b.z.toFixed(2)}`));
    expect(mirrored).toEqual([]);
    // Rozestupy drobností podél trati na jedné straně: pravidelná řada by je měla skoro stejné.
    const near = plants.filter((plant) => plant.layer === 'near' && offset(plant) > 0).map((plant) => plant.z).sort((a, b) => a - b);
    const gaps = near.slice(1).map((z, i) => z - near[i]!);
    const mean = gaps.reduce((sum, gap) => sum + gap, 0) / gaps.length;
    const spread = Math.sqrt(gaps.reduce((sum, gap) => sum + (gap - mean) ** 2, 0) / gaps.length);
    expect(spread / mean).toBeGreaterThan(0.5);
  });

  it('každá rostlina má vlastní velikost 0,7–1,4, natočení 0–360° a odstín ±8 %', () => {
    const plants = placeVegetation(optionsOf(FOREST));
    for (const plant of plants) {
      expect(plant.size).toBeGreaterThanOrEqual(0.7);
      expect(plant.size).toBeLessThanOrEqual(1.4);
      expect(plant.turn).toBeGreaterThanOrEqual(0);
      expect(plant.turn).toBeLessThan(2 * Math.PI);
      for (const channel of plant.shade) {
        expect(channel).toBeGreaterThanOrEqual(0.92);
        expect(channel).toBeLessThanOrEqual(1.08);
      }
    }
    // Vlastní = skoro žádné dvě stejné hodnoty, a rozsah je využitý celý.
    const distinct = (values: readonly number[]): number => new Set(values).size;
    for (const values of [plants.map((plant) => plant.size), plants.map((plant) => plant.turn), plants.map((plant) => plant.shade[1]), plants.map((plant) => plant.shade[0] - plant.shade[2])]) {
      expect(distinct(values)).toBeGreaterThan(plants.length * 0.99);
    }
    expect(Math.min(...plants.map((plant) => plant.size))).toBeLessThan(0.72);
    expect(Math.max(...plants.map((plant) => plant.size))).toBeGreaterThan(1.38);
  });
});

/**
 * Vegetace kolem hrací plochy (P46G T7): aréna 30 × 30 m posunutá ze středu, ať se
 * nespletou osy. Pinuje se, co by na snímku vypadalo dobře, a přesto bylo špatně:
 * strom na hrací ploše nebo ve stěně, vysoký strom mezi kamerou a hrdinou u přední
 * hrany, vegetace před bludištěm, kudy hrdina vchází, a roh, který obejde pravidlo strany.
 */
describe('vegetace kolem hrací plochy', () => {
  const BOX = { x0: -12, x1: 18, z0: -5, z1: 25 } as const;
  const CLEAR = 3;
  const ALL = { '-x': LAYERS, '+x': LAYERS, '-z': LAYERS, '+z': LAYERS } as const;
  const around = (flora: Flora, overrides: Partial<AroundOptions> = {}): Plant[] => placeAround({ flora, seed: 7, box: BOX, clear: CLEAR, layers: LOW_TOWARD_CAMERA, profile: 'desktop', ...overrides });
  /** Odstup půdorysu od plochy rozšířené o volný pás (m); záporný = sahá dovnitř. */
  const gapToBox = (plant: Plant): number => Math.hypot(Math.max(BOX.x0 - plant.x, 0, plant.x - BOX.x1), Math.max(BOX.z0 - plant.z, 0, plant.z - BOX.z1)) - plant.reach - CLEAR;
  const inFront = (plant: Plant): boolean => plant.z < BOX.z0 - CLEAR;

  it.each(FLORAS)('%s: žádný půdorys nesahá na plochu ani do volného pásu', (_, flora) => {
    const plants = around(flora, { layers: ALL });
    expect(plants.length).toBeGreaterThan(100);
    expect(plants.filter((plant) => gapToBox(plant) < -1e-6).map((plant) => `${plant.id} ${plant.x.toFixed(1)},${plant.z.toFixed(1)} gap=${gapToBox(plant).toFixed(2)}`)).toEqual([]);
  });

  it('roste ze všech čtyř stran, i v rozích', () => {
    const plants = around(FOREST, { layers: ALL });
    const count = (test: (plant: Plant) => boolean): number => plants.filter(test).length;
    expect(count((plant) => plant.x < BOX.x0 - CLEAR && !inFront(plant))).toBeGreaterThan(100);
    expect(count((plant) => plant.x > BOX.x1 + CLEAR && !inFront(plant))).toBeGreaterThan(100);
    expect(count((plant) => plant.z > BOX.z1 + CLEAR && plant.x > BOX.x0 && plant.x < BOX.x1)).toBeGreaterThan(50);
    expect(count((plant) => inFront(plant) && plant.x > BOX.x0 && plant.x < BOX.x1)).toBeGreaterThan(50);
    expect(count((plant) => plant.x > BOX.x1 + CLEAR && plant.z > BOX.z1 + CLEAR)).toBeGreaterThan(20);
  });

  it.each(FLORAS)('%s: na straně kamery jen nízké drobnosti, u vchodu bludiště nic – i v rozích', (_, flora) => {
    const low = around(flora);
    const front = low.filter(inFront);
    expect(front.length).toBeGreaterThan(0);
    expect(front.filter((plant) => plant.layer !== 'near').map((plant) => `${plant.id} ${plant.layer} ${plant.x.toFixed(1)},${plant.z.toFixed(1)}`)).toEqual([]);
    // Drobnost na straně kamery je nižší než hrdina s rezervou: přes ni kamera pod 40° vidí na paty hrdiny u hrany.
    expect(Math.max(...front.map((plant) => plant.height))).toBeLessThan(2);
    // Stromy dál rostou po stranách a vzadu.
    expect(low.filter((plant) => !inFront(plant) && plant.layer !== 'near').length).toBeGreaterThan(20);
    expect(around(flora, { layers: NONE_TOWARD_CAMERA }).filter(inFront)).toEqual([]);
  });

  it('tatáž hra dá tutéž vegetaci, telefon nejvýš 60 % desktopu a jeho podmnožinu', () => {
    const desktop = around(FOREST);
    expect(around(FOREST)).toEqual(desktop);
    expect(around(FOREST, { seed: 8 })).not.toEqual(desktop);
    const phone = around(FOREST, { profile: 'phone' });
    expect(phone.length).toBeLessThanOrEqual(0.6 * desktop.length);
    expect(phone.length).toBeGreaterThan(0.4 * desktop.length);
    const kept = new Set(desktop.map((plant) => `${plant.id}:${plant.x}:${plant.z}`));
    expect(phone.filter((plant) => !kept.has(`${plant.id}:${plant.x}:${plant.z}`))).toEqual([]);
  });
});

describe('druhy a barvy', () => {
  it('každý druh vegetace katalog má, les nese aspoň 6 druhů a ve scéně je opravdu vidět', () => {
    const ids = new Set(catalog.assets.map((asset) => asset.assetId));
    expect(FLORAS.flatMap(([, flora]) => [...floraIds(flora)].filter((id) => !ids.has(id)))).toEqual([]);
    expect(floraIds(FOREST).size).toBeGreaterThanOrEqual(6);
    expect(new Set(placeVegetation(optionsOf(FOREST)).map((plant) => plant.id)).size).toBeGreaterThanOrEqual(6);
  });

  it.each(FLORAS)('%s: nejvýš FLORA_SPECIES druhů (kreslicí volání na telefonu) a každý stojí ve scéně', (_, flora) => {
    expect(floraIds(flora).size).toBeLessThanOrEqual(FLORA_SPECIES);
    expect(new Set(placeVegetation(optionsOf(flora)).map((plant) => plant.id))).toEqual(floraIds(flora));
  });

  it('jehličnany v lese jsou zelené, oranžové jen na podzim', () => {
    const summer = sceneLook({ setting: 'dark forest', mood: 'tense' }).flora!;
    const autumn = sceneLook({ setting: 'an autumn forest', mood: 'calm' }).flora!;
    expect(summer.autumn).toBeUndefined();
    expect(autumn.autumn).toBe(true);
    expect(sceneLook({ setting: 'forest in the fall', mood: 'calm' }).flora!.autumn).toBe(true);
    expect(sceneLook({ setting: 'forest by a waterfall', mood: 'calm' }).flora!.autumn).toBeUndefined();
    // Jehličí `cc0-tree-pine` je v textuře oranžové (KayKit Halloween).
    for (const needle of ['#9a4529', '#a44d2b', '#b0562e']) {
      const green = plantPaint('cc0-tree-pine', summer)(new Color(needle));
      expect(hueOf(green)).toBeGreaterThan(80);
      expect(hueOf(green)).toBeLessThan(160);
      expect(plantPaint('cc0-tree-pine', autumn)(new Color(needle)).getHexString()).toBe(new Color(needle).getHexString());
    }
    // Kmen zůstane, listí z šedé palety katalogu dostane barvu sady, jiný druh oranžovou nemění.
    expect(plantPaint('cc0-tree-pine', summer)(new Color('#584c45')).getHexString()).toBe(new Color('#584c45').getHexString());
    expect(plantPaint('cc0-pine-tree', summer)(new Color('#4a525c')).getHexString()).toBe(new Color(summer.leaf).getHexString());
    expect(hueOf(plantPaint('cc0-pine-tree', autumn)(new Color('#4a525c')))).toBeLessThan(45);
    expect(plantPaint('cc0-bush-berries', summer)(new Color('#c8412f')).getHexString()).toBe(new Color('#c8412f').getHexString());
  });

  it('barvy listí nejsou fialové (odstín 250–320°)', () => {
    expect(FLORAS.map(([, flora]) => hueOf(flora.leaf)).filter((hue) => hue >= 250 && hue <= 320)).toEqual([]);
  });

  it('řada kulis vedle vegetace nese jen stavby a věci; sada bez vegetace rekvizity celé', () => {
    const forest = landmarks(LOOKS.forest);
    expect(forest.length).toBeGreaterThan(0);
    expect(forest.filter((prop) => floraIds(FOREST).has(prop) || ['tree', 'pine', 'palm', 'cactus'].includes(prop))).toEqual([]);
    expect(landmarks(LOOKS.city)).toBe(LOOKS.city.props);
  });
});
