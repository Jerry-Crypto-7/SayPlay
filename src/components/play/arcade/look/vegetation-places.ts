/**
 * Vegetace podél cesty (P46G T4). Les byl zelená plocha s pár stromy ze tří
 * modelů v řídké zrcadlové řadě. Tady má tři vrstvy: u cesty drobnosti (keře,
 * tráva, kameny, pařezy), uprostřed shluky stromů a v dálce souvislou linii.
 * Každá rostlina má vlastní velikost (0,7–1,4), natočení a odstín (±8 %),
 * místo leží náhodně v buňce mřížky, takže nic nestojí v řadě ani zrcadlově.
 *
 * Kolem cesty zůstává volný pás: půdorys rostliny (kružnice opsaná modelu
 * z katalogu) nesahá blíž než `clear` za kraj cesty po celé své délce, ani
 * v zatáčce. Telefon dostane podmnožinu desktopu (`PHONE_SHARE`).
 *
 * Rozmístění je čistá funkce semínka hry a tvaru cesty z vlastního streamu
 * `pure-rand` (jako výzdoba arény): tatáž hra má tytéž stromy a z běhových
 * streamů jádra se neodebere nic – hash replaye se nehne. Kreslí `Vegetation.tsx`.
 */

import { uniformFloat64 } from 'pure-rand/distribution/uniformFloat64';
import { xoroshiro128plus } from 'pure-rand/generator/xoroshiro128plus';
import { Color, SRGBColorSpace } from 'three';

import catalog from '@/assets/catalog-index.json';
import type { Flora, PlantSpecies } from '@/play/arcade/look';

import type { Box } from './ground';

export const LAYERS = ['near', 'mid', 'far'] as const;
export type Layer = (typeof LAYERS)[number];

/** Telefon (hrubý ukazatel) kreslí řidší vegetaci než desktop. */
export type VegetationProfile = 'phone' | 'desktop';
/** Podíl rostlin desktopu, který telefon nechá (AC: nejvýš 60 %). */
export const PHONE_SHARE = 0.55;

export interface Plant {
  readonly id: string;
  readonly layer: Layer;
  /** Pata ve scéně (m). */
  readonly x: number;
  readonly z: number;
  /** Násobek výšky druhu, 0,7–1,4. */
  readonly size: number;
  /** Výška rostliny (m) = výška druhu × `size`. */
  readonly height: number;
  /** Natočení kolem svislé osy (rad), 0–2π. */
  readonly turn: number;
  /** Násobek barvy po složkách (odstín a světlost), každá 0,92–1,08. */
  readonly shade: readonly [r: number, g: number, b: number];
  /** Poloměr půdorysu (m) při libovolném natočení. */
  readonly reach: number;
}

/** Cesta v `z`: střed (x scény) a půl šířky (m). */
export interface RoadAt {
  readonly center: number;
  readonly half: number;
}

export interface VegetationOptions {
  readonly flora: Flora;
  /** Semínko hry (`ArcadeWorld.seed`). */
  readonly seed: number;
  /** Rozsah podél trati (m, osa z scény). */
  readonly from: number;
  readonly to: number;
  readonly road: (z: number) => RoadAt;
  /** Volný pás za krajem cesty (m), kam žádná rostlina nesahá. */
  readonly clear: number;
  readonly profile: VegetationProfile;
}

/** Sůl semínka – stream vegetace je jiný než každý stream jádra i výzdoby arény. */
const SALT = 0x7e6e7a11;

/**
 * Vrstva: odstup od kraje volného pásu k okraji půdorysu (m), hustota na m² na
 * desktopu a buňka mřížky (m). Střed sází shluky (hustota je hustota středů shluků).
 */
const BANDS: Readonly<Record<Layer, { readonly from: number; readonly to: number; readonly density: number; readonly cell: number }>> = {
  near: { from: 0, to: 5, density: 0.3, cell: 2.5 },
  mid: { from: 2, to: 18, density: 0.012, cell: 9 },
  far: { from: 16, to: 40, density: 0.05, cell: 5 },
};
/** Shluk stromů: 3–6 kmenů do 4,5 m od středu. */
const CLUSTER = { least: 3, most: 6, spread: 4.5 } as const;

/** Poloměr půdorysu modelu na metr výšky: kružnice opsaná obdélníku z rozměrů v katalogu. */
const REACH: ReadonlyMap<string, number> = new Map(
  catalog.assets.map(({ assetId, bounds: { min, max } }) => [assetId, Math.hypot(Math.max(-min[0]!, max[0]!), Math.max(-min[2]!, max[2]!)) / (max[1]! - min[1]!)]),
);
export const reachOf = (id: string): number => REACH.get(id)!;

/**
 * Půdorys (x, z, `reach`) leží vně cesty rozšířené o `clear` po celé své délce z:
 * cesta se kontroluje po metru od `z − reach` do `z + reach`, takže ani zatáčka do něj nezajede.
 */
function outsideRoad(road: (z: number) => RoadAt, clear: number, x: number, z: number, reach: number): boolean {
  for (let at = z - reach; ; at = Math.min(at + 1, z + reach)) {
    const { center, half } = road(at);
    if (Math.abs(x - center) - reach < half + clear) return false;
    if (at >= z + reach) return true;
  }
}

const tint = (value: number): number => Math.min(1.08, Math.max(0.92, value));

export function placeVegetation({ flora, seed, from, to, road, clear, profile }: VegetationOptions): Plant[] {
  const rng = xoroshiro128plus((seed ^ SALT) | 0);
  const next = (): number => uniformFloat64(rng);
  const share = profile === 'phone' ? PHONE_SHARE : 1;
  const plants: Plant[] = [];
  /** Rostlina `offset` m od kraje volného pásu na straně `side`. Hodnoty se táhnou vždy, ať profil ani pás stream neposunou. */
  const plant = (layer: Layer, species: readonly PlantSpecies[], side: number, z: number, offset: number): void => {
    const { id, height: base } = species[Math.floor(next() * species.length)]!;
    const size = 0.7 + 0.7 * next();
    const turn = 2 * Math.PI * next();
    const light = 0.92 + 0.16 * next();
    const hue = (next() - 0.5) * 0.04;
    const keep = next();
    const height = base * size;
    const reach = reachOf(id) * height;
    const { center, half } = road(z);
    const x = center + side * (half + clear + reach + offset);
    if (keep >= share || !outsideRoad(road, clear, x, z, reach)) return;
    plants.push({ id, layer, x, z, size, height, turn, shade: [tint(light + hue), light, tint(light - hue)], reach });
  };
  for (const layer of LAYERS) {
    const species = flora[layer];
    if (species.length === 0) continue;
    const { from: near, to: far, density, cell } = BANDS[layer];
    for (const side of [-1, 1]) {
      for (let z0 = from; z0 < to; z0 += cell) {
        for (let d0 = near; d0 < far; d0 += cell) {
          // Buňka u vnějšího okraje vrstvy je užší; počet je celá část hustoty plus náhoda, místo náhodné v buňce.
          const depth = Math.min(cell, far - d0);
          const count = Math.floor(density * flora.density * cell * depth + next());
          for (let k = 0; k < count; k += 1) {
            const z = z0 + next() * cell;
            const offset = d0 + next() * depth;
            if (layer !== 'mid') {
              plant(layer, species, side, z, offset);
              continue;
            }
            const trees = CLUSTER.least + Math.floor(next() * (CLUSTER.most - CLUSTER.least + 1));
            for (let tree = 0; tree < trees; tree += 1) {
              const angle = 2 * Math.PI * next();
              const r = CLUSTER.spread * Math.sqrt(next());
              plant(layer, species, side, z + r * Math.cos(angle), offset + r * Math.sin(angle));
            }
          }
        }
      }
    }
  }
  return plants;
}

/** Strana hrací plochy ve scéně; `-z` je strana, odkud se na ni dívá kamera arény, bludiště i hřiště. */
export const SIDES = ['-x', '+x', '-z', '+z'] as const;
export type Side = (typeof SIDES)[number];

export interface AroundOptions {
  readonly flora: Flora;
  /** Semínko hry (`ArcadeWorld.seed`). */
  readonly seed: number;
  /** Hrací plocha ve scéně (m). */
  readonly box: Box;
  /** Volný pás za hranou plochy (m), kam žádná rostlina nesahá. */
  readonly clear: number;
  /**
   * Vrstvy, které na straně rostou. Rostlina, jejíž střed leží za volným pásem
   * na víc stranách (roh), musí mít vrstvu povolenou na každé z nich.
   */
  readonly layers: Readonly<Record<Side, readonly Layer[]>>;
  readonly profile: VegetationProfile;
  /** Zem pod vegetací (podstavec `FieldGround`, P73D): půdorys za její hranou se nepostaví – visel by nad prázdnem. */
  readonly land?: Box;
}

/** Plocha, na kterou kamera kouká šikmo shora z −z (aréna): na její straně jen nízké drobnosti, které hrdinu u hrany nezakryjí. */
export const LOW_TOWARD_CAMERA: Readonly<Record<Side, readonly Layer[]>> = { '-x': LAYERS, '+x': LAYERS, '-z': ['near'], '+z': LAYERS };
/** Plocha, kam hrdina vchází z −z (bludiště) nebo kde za ním stojí kamera nízko (hřiště): na straně kamery nic. */
export const NONE_TOWARD_CAMERA: Readonly<Record<Side, readonly Layer[]>> = { '-x': LAYERS, '+x': LAYERS, '-z': [], '+z': LAYERS };

/** Jak daleko za volný pás pruhy kolem plochy sahají (m): konec vzdálené linie a koruna stromu. */
const AROUND_M = BANDS.far.to + 10;
/** Sůl pruhů před a za plochou: jiný les než po stranách. */
const ENDS_SALT = 0x51ed27;

/**
 * Vegetace kolem obdélníkové hrací plochy (P46G T7: aréna, bludiště, hřiště).
 * Dva pruhy jako u cesty (`placeVegetation`): po stranách −x a +x celou délkou
 * i s rohy, před a za plochou (−z, +z) jen mezi volnými pásy stran – s prohozenými
 * osami. Půdorys žádné rostliny nesahá do plochy rozšířené o `clear`; strana
 * kamery dostane jen to, co jí `layers` dovolí (nízké drobnosti, nebo nic).
 */
export function placeAround({ flora, seed, box, clear, layers, profile, land }: AroundOptions): Plant[] {
  const [cx, cz] = [(box.x0 + box.x1) / 2, (box.z0 + box.z1) / 2];
  const [hx, hz] = [(box.x1 - box.x0) / 2, (box.z1 - box.z0) / 2];
  const sides = placeVegetation({ flora, seed, from: box.z0 - clear - AROUND_M, to: box.z1 + clear + AROUND_M, road: () => ({ center: cx, half: hx }), clear, profile });
  const ends = placeVegetation({ flora, seed: seed ^ ENDS_SALT, from: box.x0 - clear, to: box.x1 + clear, road: () => ({ center: cz, half: hz }), clear, profile })
    .map((plant) => ({ ...plant, x: plant.z, z: plant.x }))
    .filter((plant) => Math.abs(plant.x - cx) < hx + clear);
  const beyond = (plant: Plant): Side[] => [
    ...(plant.x < box.x0 - clear ? (['-x'] as const) : []),
    ...(plant.x > box.x1 + clear ? (['+x'] as const) : []),
    ...(plant.z < box.z0 - clear ? (['-z'] as const) : []),
    ...(plant.z > box.z1 + clear ? (['+z'] as const) : []),
  ];
  const onLand = (plant: Plant): boolean =>
    land === undefined || (plant.x - plant.reach >= land.x0 && plant.x + plant.reach <= land.x1 && plant.z - plant.reach >= land.z0 && plant.z + plant.reach <= land.z1);
  return [...sides, ...ends].filter((plant) => onLand(plant) && beyond(plant).every((side) => layers[side].includes(plant.layer)));
}

export interface OrchardOptions {
  readonly flora: Flora;
  /** Semínko hry (`ArcadeWorld.seed`). */
  readonly seed: number;
  /** Kam řady sadu sahají (m); stromy stojí v mřížce od rohu `x0`, `z0`. */
  readonly area: Box;
  /** Obdélník bez stromů (m): hrací plocha s uličkou za ní; žádný půdorys do něj nesahá. */
  readonly keep: Box;
  /** Nejvyšší strom (m): vyšší druh se zmenší, ať koruna zůstane pod obzorem kamery. */
  readonly top: number;
}

/** Sůl sadu: jiný proud než vegetace podél cesty a kolem plochy. */
const ORCHARD_SALT = 0x5ad0ba;
/** Sad: rozestup stromů v řadě (x) a řad (z) v m, výkyv místa (m) a velikost 0,9–1,1 – sázené řady, ne divoký les. */
const ORCHARD = { step: 4.2, row: 4.5, jitter: 0.3, size: 0.9, spread: 0.2 } as const;
/** Ovocné druhy středu vegetace: má-li je sada (jabloň louky), sad je jen z nich. */
const FRUIT = /apple|fruit|orchard/;

/**
 * Sad (P73D, chytání): stromy středu vegetace v pravidelných řadách na zemi po stranách a za hrací plochou –
 * místo řady korun, která visela nad pruhy přes horní hranu obrazu. Čistá funkce semínka jako `placeVegetation`;
 * stromů jsou desítky, telefon je nese všechny. Kreslí `Orchard` (`Vegetation.tsx`).
 */
export function placeOrchard({ flora, seed, area, keep, top }: OrchardOptions): Plant[] {
  const fruit = flora.mid.filter(({ id }) => FRUIT.test(id));
  const species = fruit.length > 0 ? fruit : flora.mid;
  if (species.length === 0) return [];
  const rng = xoroshiro128plus((seed ^ ORCHARD_SALT) | 0);
  const next = (): number => uniformFloat64(rng);
  const plants: Plant[] = [];
  // Po indexu, ne přičítáním: součet desetinných kroků by krajní řadu tiše minul.
  for (let r = 0; r <= (area.z1 - area.z0) / ORCHARD.row + 1e-9; r += 1) {
    const row = area.z0 + r * ORCHARD.row;
    for (let c = 0; c <= (area.x1 - area.x0) / ORCHARD.step + 1e-9; c += 1) {
      const column = area.x0 + c * ORCHARD.step;
      // Hodnoty se táhnou vždy, ať vynechaný strom proud neposune.
      const { id, height: base } = species[Math.floor(next() * species.length)]!;
      const height = Math.min(top, base * (ORCHARD.size + ORCHARD.spread * next()));
      const turn = 2 * Math.PI * next();
      const light = 0.92 + 0.16 * next();
      const hue = (next() - 0.5) * 0.04;
      const x = column + (next() - 0.5) * 2 * ORCHARD.jitter;
      const z = row + (next() - 0.5) * 2 * ORCHARD.jitter;
      const reach = reachOf(id) * height;
      if (x + reach > keep.x0 && x - reach < keep.x1 && z + reach > keep.z0 && z - reach < keep.z1) continue;
      plants.push({ id, layer: 'mid', x, z, size: height / base, height, turn, shade: [tint(light + hue), light, tint(light - hue)], reach });
    }
  }
  return plants;
}

/** Šedá z palety katalogu (`scripts/assets/cc0/normalize.mjs --style`), kterou mají listí, mech a kaktusy modelů Quaternius. */
const SLATE = new Color('#4a525c');
/** Jehličnany katalogu. Jehličí `cc0-tree-pine` (KayKit Halloween) je oranžové – podzimní. */
export const CONIFERS: ReadonlySet<string> = new Set(['cc0-tree-pine', 'cc0-pine-tree']);
/** Listí na podzim. */
export const AUTUMN_LEAF = '#c8701f';

/**
 * Barva vrcholu rostliny `id` ve vegetaci sady (lineární RGB, mění `color`):
 * šedá listí z palety katalogu dostane barvu listí sady, oranžové jehličí
 * jehličnanu mimo podzim zezelená v odstínu listí. Kmen (šedý, hnědý) je méně
 * sytý a zůstane. Na podzim je listí oranžové a jehličí se nemění.
 */
export function plantPaint(id: string, flora: Flora): (color: Color) => Color {
  const autumn = flora.autumn === true;
  const leaf = new Color(autumn ? AUTUMN_LEAF : flora.leaf);
  const needles = !autumn && CONIFERS.has(id);
  const target = leaf.getHSL({ h: 0, s: 0, l: 0 }, SRGBColorSpace);
  const hsl = { h: 0, s: 0, l: 0 };
  return (color) => {
    if (Math.abs(color.r - SLATE.r) + Math.abs(color.g - SLATE.g) + Math.abs(color.b - SLATE.b) < 0.01) return color.copy(leaf);
    if (!needles) return color;
    color.getHSL(hsl, SRGBColorSpace);
    if (hsl.h <= 45 / 360 && hsl.s > 0.5 && hsl.l > 0.15) color.setHSL(target.h, target.s, hsl.l * 0.85, SRGBColorSpace);
    return color;
  };
}
