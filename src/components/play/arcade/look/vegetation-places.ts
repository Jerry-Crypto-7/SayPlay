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
