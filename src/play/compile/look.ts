/**
 * `look` hry z tématu specu (P23-A, T8).
 *
 * Prohlížeč rodinu kulis volí sám (`chooseFamily(look, seed)` ve `Viewer.tsx`)
 * a čte `look.palette` a `look.atmosphere` **jako řetězce**. Kompilátor proto
 * rodinu nevybírá vedle něj, ale skládá `look` tak, aby v něm `chooseFamily`
 * našel slovo, které chce – první známé slovo v `palette` rozhoduje, a před
 * `theme.setting` se předsadí materiál z tabulky herních prostředí (sopka →
 * `ember` → works). Prostředí bez známého slova nechá volbu na seedu, jako
 * u emise modelu. Předvolba světla jde z `theme.mood`; do `atmosphere` se
 * nepíše, protože `fog`/`storm` by v ní přebily paletu.
 */

import { chooseFamily } from '@/geom/family-choice';
import { FAMILIES, familyById, type Family } from '@/geom/families';
import type { LookPart } from '@/ir/worlddoc';
import { type LookPreset } from '@/worldstream/look';

import type { GameSpecV1 } from '../spec';

/** Slovo prostředí → materiál, který `BY_MATERIAL` ve `family-choice.ts` zná. */
const SETTING_MATERIAL: Readonly<Record<string, string>> = {
  volcanic: 'ember',
  volcano: 'ember',
  lava: 'ember',
  sewer: 'iron',
  tunnel: 'iron',
  factory: 'iron',
  foundry: 'iron',
  workshop: 'iron',
  garage: 'iron',
  spaceship: 'chrome',
  station: 'chrome',
  lab: 'chrome',
  laboratory: 'chrome',
  supermarket: 'chrome',
  mall: 'chrome',
  office: 'chrome',
  arctic: 'ice',
  forest: 'moss',
  jungle: 'moss',
  garden: 'moss',
  swamp: 'moss',
  meadow: 'moss',
  park: 'moss',
  farm: 'moss',
  kitchen: 'brick',
  restaurant: 'brick',
  bakery: 'brick',
  village: 'brick',
  town: 'brick',
  city: 'brick',
  castle: 'stone',
  temple: 'stone',
  ruins: 'stone',
  cave: 'stone',
  cavern: 'stone',
  beach: 'sand',
  desert: 'sand',
};

/** Slovo nálady → předvolba světla z `look.ts`. */
const MOOD_PRESET: Readonly<Record<string, LookPreset>> = {
  dark: 'night',
  night: 'night',
  scary: 'night',
  spooky: 'night',
  eerie: 'night',
  creepy: 'night',
  dangerous: 'dusk',
  tense: 'dusk',
  frantic: 'dusk',
  fast: 'dusk',
  urgent: 'dusk',
  mysterious: 'fog',
  puzzling: 'fog',
  quiet: 'fog',
  stormy: 'storm',
  wild: 'storm',
  chaotic: 'storm',
};

const words = (text: string): string[] => text.toLowerCase().match(/[a-z]+/g) ?? [];

function firstKnown<T>(text: string, table: Readonly<Record<string, T>>): T | null {
  for (const word of words(text)) if (Object.hasOwn(table, word)) return table[word] as T;
  return null;
}

export interface GameLook {
  readonly look: LookPart;
  readonly family: Family;
  readonly preset: LookPreset;
}

export function buildLook(spec: GameSpecV1, seed: number, playerEntity: string, gridSpan: number): GameLook {
  const { setting, mood } = spec.theme;
  const material = firstKnown(setting, SETTING_MATERIAL);
  const preset = firstKnown(mood, MOOD_PRESET) ?? 'day';
  const palette = material === null ? setting : `${material} ${setting}`;
  const atmosphere = `${mood} ${setting}`;
  const family = familyById(chooseFamily({ palette, atmosphere }, seed)) ?? (FAMILIES[0] as Family);
  const look: LookPart = {
    // Klíče `modules` musí být entity (`findDanglingReferences`); `lightRig` čte popis stavby jako řetězec.
    modules: { [playerEntity]: { family: family.id, palette: family.palette } },
    palette,
    lightRig: preset,
    atmosphere,
    materialRoles: { [playerEntity]: family.palette },
    camera: { kind: 'orbit', target: playerEntity, elevation: 0.55, distance: Math.max(12, gridSpan * 1.4) },
    audio: { ambience: mood, reverb: 0.3 },
  };
  return { look, family, preset };
}
