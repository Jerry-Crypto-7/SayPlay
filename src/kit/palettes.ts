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

/**
 * Role, které scéna kreslí. Jména jsou sémantická, ne barevná — `goal` zůstane
 * `goal`, i kdyby zítra zmodral.
 */
export type SceneRole =
  | 'avatar'
  | 'agent'
  | 'collectible'
  | 'goal'
  | 'gate'
  | 'trigger'
  | 'prop'
  | 'wall'
  | 'floor'
  | 'zone';

/**
 * Sémantická paleta scény — jedna kopie pro celý produkt.
 *
 * Do T9 žila tahle mapa v `components/viewer/WorldScene.tsx` s komentářem, že
 * sjednocení patří sem. Odstíny drží slovník kitu (`PALETTES.harbor`,
 * `PALETTES.frost`), takže postavená scéna a ručně skládaný layout nevypadají
 * jako dva různé produkty.
 *
 * **Vybírané s ohledem na barvoslepost, ne až dodatečně.** Nejčastější vada je
 * záměna červené a zelené (deuteranopie a protanopie, cca 8 % mužů), a přesně
 * takovou trojici tu paleta měla: `agent` oranžový, `collectible` žlutý,
 * `goal` zelený. Cíl je proto **modrý** — modrožlutá osa zůstává čitelná i pro
 * ně a odliší se i luminancí. Zóna je proti němu tlumená a poloprůhledná.
 *
 * **Žádný fialový ani purpurový odstín** (globální pravidlo designu). Hlídá to
 * strojově `src/app/__tests__/theme.test.ts`, ne tenhle komentář.
 */
export const SCENE_ROLES = {
  /** Hráč. Tyrkys z palety `harbor` — jediná sytá studená barva mezi entitami. */
  avatar: '#2f9e8f',
  /** Co se hýbe samo a nechceš do toho vrazit. */
  agent: '#e2622c',
  /** Ke sebrání. */
  collectible: '#e6c14a',
  /** Cíl. Modrý schválně — proti oranžovému agentovi a žlutému sběru je to
   *  jediná dvojice, kterou nezamění ani červeno-zelená vada. */
  goal: '#56b4e9',
  /** Brána nebo dveře. Neutrální, protože samy o sobě nic neslibují. */
  gate: '#8d9ba1',
  /** Tlaková deska a spouštěče. */
  trigger: '#cbbc98',
  /** Kulisa. Nejtmavší z entit, aby nepřetahovala pozornost. */
  prop: '#5f6f74',
  wall: '#31444b',
  floor: '#203034',
  /** Vyznačená plocha. Kreslí se poloprůhledně pod entitami, proto tlumená. */
  zone: '#3f7f99',
} as const satisfies Record<SceneRole, string>;

/**
 * Barvy rozhraní — HUD, text, stavy hry, plocha stránky.
 *
 * Je to **zdroj** hodnot; `src/app/theme.css` je nese jako CSS proměnné a
 * `src/app/__tests__/theme.test.ts` jde červeně, jakmile se obojí rozejde.
 * Import CSS do TypeScriptu tady schválně není — styl se z Reactu nenačítá,
 * načítá ho kořenový layout.
 */
export const UI_TOKENS = {
  /** Plocha stránky. Stejná barva má i mlha ve scéně, jinak by vzdálený kus zbělal. */
  background: '#0b1114',
  text: '#dfe8ea',
  /** Druhotný text — počítadla, jednotky, popisky. */
  muted: '#9fb0b3',
  /** Výhra. */
  positive: '#8fbf4a',
  /** Prohra a chyby. */
  negative: '#e2622c',
  accent: '#2f9e8f',
} as const;

export type UiToken = keyof typeof UI_TOKENS;

/**
 * Varianta rozhraní pro červeno-zelenou barvoslepost.
 *
 * Mění se **jen dvojice, která nese význam sama o sobě** — výhra a prohra.
 * Zelená a oranžová jsou pro deuteranopa skoro totéž, takže by stav hry sdělovala
 * pouze slovem. Modrá a rumělková se liší i pro ně, a liší se i luminancí, takže
 * fungují i na černobílém snímku.
 *
 * Zapíná se atributem `data-palette="cvd"` na `<html>`. **Přepínač v UI k tomu
 * zatím není** — T9 ho nežádá; tohle je ta polovina, která musí existovat dřív,
 * než bude co přepínat, a e2e ji ověřuje nastavením atributu.
 */
export const UI_TOKENS_CVD = {
  ...UI_TOKENS,
  positive: '#56b4e9',
  negative: '#d55e00',
} as const satisfies Record<UiToken, string>;


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
