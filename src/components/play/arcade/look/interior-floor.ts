/**
 * Podlaha interiéru mimo arénu (P62 T6). Dlažbu interiéru kladla jen aréna (`arenaFloor.ts`, T3); údolí běžce
 * a zem ostatních žánrů (`buildValley`, `buildFieldGround`) malovaly zem sady a slepý soudce četl supermarket
 * jako „outdoor road over pale hills“ a obchoďák střelnice jako „washed-out, sparse open space“. Ty sítě jsou
 * mřížky s barvou ve vrcholech, dílce se spárami neunesou, a trať běžce má stovky metrů – proto tytéž dílce
 * (`INTERIOR_LAYOUTS`) jako textura: jedna perioda kladení v 256 × 256 px opakovaná po zemi. Síť nese UV
 * v metrech (`x`, `z` před ohnutím po trati) a bílé vrcholy, takže barvu dá jen dlažba; `repeat` textury
 * převádí metry na periody.
 *
 * Čistá funkce povrchu: žádná náhoda, odstíny dílců z `hash` jako v aréně.
 *
 * simplified: perioda 2–4 dílce × 4–8 řad se opakuje, takže se odstín dílců vrací po 3–7 m; větší perioda je
 * větší textura – zvětšit, až by soudce nebo hráč viděl vzor.
 */

import { Color, DataTexture, LinearFilter, LinearMipmapLinearFilter, RGBAFormat, RepeatWrapping, SRGBColorSpace } from 'three';

import { type InteriorFloor, SURFACES } from '@/play/arcade/look';

import { hash } from './ground';
import { INTERIOR_LAYOUTS } from './rig/terrain/arenaFloor';

/** Strana textury (px): spára 0,03 m šachovnice má ~1,5 px, prkna 0,035 m ~3 px. */
const SIZE_PX = 256;
/** K jaké šířce periody (m) se počet dílců v řadě blíží – sudý počet, ať šachovnice navazuje. */
const PERIOD_M = 6.4;
/** Nejméně řad v periodě (odstíny) a nejvíc řad, ve kterých se hledá návrat posunu vazby. */
const MIN_ROWS = 4;
const MAX_CYCLE = 8;
/** Kolik smí posun vazby po periodě chybět do celého dílce (podíl dílce). */
const BOND_SLACK = 0.08;
/** Šikmý pohled běžce a střelnice po zemi: bez anizotropie se spáry o pár metrů dál slijí. */
const ANISOTROPY = 8;

export interface Tiling {
  /** Dílců v řadě a řad v periodě. */
  readonly columns: number;
  readonly rows: number;
  /** Rozměr periody (m) podél x a z. */
  readonly width: number;
  readonly depth: number;
}

/** Perioda kladení povrchu: celý počet dílců, po kterém dlažba navazuje i se šachovnicí a posunem vazby. */
export function interiorTiling(floor: InteriorFloor): Tiling {
  const {
    size: [w, d],
    bond,
  } = INTERIOR_LAYOUTS[floor];
  const columns = Math.max(2, 2 * Math.floor(PERIOD_M / w / 2));
  // Vazba se po `cycle` řadách vrátí (skoro) na začátek: 0 → 1, ½ → 2, 0,37 → 8, 0,31 → 3.
  let cycle = 1;
  while (cycle < MAX_CYCLE && Math.abs(cycle * bond - Math.round(cycle * bond)) > BOND_SLACK) cycle += 1;
  const rows = cycle * Math.ceil(MIN_ROWS / cycle);
  return { columns, rows, width: columns * w, depth: rows * d };
}

const maps = new Map<InteriorFloor, DataTexture>();

/**
 * Textura dlažby povrchu (sdílená, jedna na povrch): dílce v odstínu 0,86–1,06× jako v aréně, tu a tam tmavší,
 * šachovnice střídá dílec s barvou na půl cesty ke spáře, spáry na konci dílce i řady.
 */
export function interiorFloorMap(floor: InteriorFloor): DataTexture {
  const cached = maps.get(floor);
  if (cached !== undefined) return cached;
  const { size, bond, seam: gap, checker } = INTERIOR_LAYOUTS[floor];
  const [w, d] = size;
  const { width, depth } = interiorTiling(floor);
  const stone = new Color(SURFACES[floor].color);
  const seam = new Color(SURFACES[floor].edge);
  const other = checker === true ? stone.clone().lerp(seam, 0.5) : stone;
  const data = new Uint8Array(SIZE_PX * SIZE_PX * 4);
  const face = new Color();
  const rgb = { r: 0, g: 0, b: 0 };
  for (let j = 0; j < SIZE_PX; j += 1) {
    const z = ((j + 0.5) / SIZE_PX) * depth;
    const row = Math.floor(z / d);
    const top = z - row * d > d - gap;
    const shift = ((row * bond) % 1) * w;
    for (let i = 0; i < SIZE_PX; i += 1) {
      const along = (((i + 0.5) / SIZE_PX) * width + shift) % width;
      const k = Math.floor(along / w);
      if (top || along - k * w > w - gap) face.copy(seam);
      else {
        face.copy((row + k) % 2 === 1 ? other : stone).multiplyScalar(0.86 + 0.2 * hash(row, k));
        if (hash(row * 97 + k, 5) < 0.08) face.lerp(seam, 0.35);
      }
      face.getRGB(rgb, SRGBColorSpace);
      const at = (j * SIZE_PX + i) * 4;
      data[at] = Math.min(255, Math.round(rgb.r * 255));
      data[at + 1] = Math.min(255, Math.round(rgb.g * 255));
      data[at + 2] = Math.min(255, Math.round(rgb.b * 255));
      data[at + 3] = 255;
    }
  }
  const texture = new DataTexture(data, SIZE_PX, SIZE_PX, RGBAFormat);
  texture.colorSpace = SRGBColorSpace;
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  texture.magFilter = LinearFilter;
  texture.minFilter = LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.anisotropy = ANISOTROPY;
  texture.repeat.set(1 / width, 1 / depth);
  texture.needsUpdate = true;
  maps.set(floor, texture);
  return texture;
}
