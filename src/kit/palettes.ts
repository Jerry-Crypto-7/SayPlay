import type { BufferGeometry } from 'three';

import { SWATCHES, srgbHexToLinear, type SwatchName } from './pieces/primitives';

export type Palette = Readonly<Record<SwatchName, string>>;

/**
 * Palety pro ručně skládané layouty. Kus se vyrobí jednou v základních
 * odstínech (`SWATCHES`) a paleta ho **přebarví** — proto má každá paleta
 * všech šest slotů a proto se sloty nesmí přejmenovat bez zásahu do kitu.
 *
 * **Žádný fialový ani purpurový odstín**, globální pravidlo designu. Hlídá to
 * strojově test v `__tests__/layouts.test.ts`, ne jen tenhle komentář.
 */
export const PALETTES = {
  harbor: {
    shell: '#8d9ba1',
    deep: '#31444b',
    accent: '#2f9e8f',
    warm: '#c8823c',
    sand: '#cbbc98',
    moss: '#5f8a6b',
  },
  kiln: {
    shell: '#c9a189',
    deep: '#5c3a2e',
    accent: '#e0762f',
    warm: '#b4552c',
    sand: '#e6cfa8',
    moss: '#7d8b4a',
  },
  thicket: {
    shell: '#7d8a72',
    deep: '#2f3d2e',
    accent: '#8fbf4a',
    warm: '#a5713a',
    sand: '#cfc79a',
    moss: '#3f6b3a',
  },
  foundry: {
    shell: '#9aa3a8',
    deep: '#2b3237',
    accent: '#e2622c',
    warm: '#8a5a33',
    sand: '#b9b2a3',
    moss: '#4f6a5c',
  },
  dunes: {
    shell: '#d9c8a4',
    deep: '#7a6748',
    accent: '#3fa8a0',
    warm: '#d08a3c',
    sand: '#efe2c2',
    moss: '#8f9a5e',
  },
  frost: {
    shell: '#c3d2da',
    deep: '#3d525e',
    accent: '#4aa3c9',
    warm: '#c98a5e',
    sand: '#dfe3e0',
    moss: '#6d8f86',
  },
} as const satisfies Record<string, Palette>;

export type PaletteName = keyof typeof PALETTES;

function colorKey(rgb: readonly [number, number, number]): string {
  // Atribut je `Float32Array`, takže se porovnává až po zaokrouhlení na float32.
  // Bez `fround` by se hodnoty lišily o poslední bity a žádná by se netrefila.
  return rgb.map((channel) => Math.fround(channel)).join(',');
}

const BASE_BY_COLOR: ReadonlyMap<string, SwatchName> = new Map(
  (Object.keys(SWATCHES) as SwatchName[]).map((name) => [
    colorKey(srgbHexToLinear(SWATCHES[name])),
    name,
  ]),
);

/**
 * Přebarví geometrii kusu paletou. Mění atribut `color` na místě.
 *
 * Každý vrchol musí nést některý ze základních odstínů — kit je uzavřená
 * množina, takže barva mimo ni je vada, ne případ k tichému přeskočení.
 */
export function repaint(geometry: BufferGeometry, palette: Palette): void {
  const color = geometry.getAttribute('color');
  const substitutes = new Map<SwatchName, readonly [number, number, number]>(
    (Object.keys(palette) as SwatchName[]).map((name) => [name, srgbHexToLinear(palette[name])]),
  );

  for (let i = 0; i < color.count; i += 1) {
    const swatch = BASE_BY_COLOR.get(colorKey([color.getX(i), color.getY(i), color.getZ(i)]));
    if (swatch === undefined) {
      throw new Error(
        `vrchol ${i} nenese žádný odstín kitu (${color.getX(i)}, ${color.getY(i)}, ${color.getZ(i)})`,
      );
    }
    const [r, g, b] = substitutes.get(swatch)!;
    color.setXYZ(i, r, g, b);
  }

  color.needsUpdate = true;
}
