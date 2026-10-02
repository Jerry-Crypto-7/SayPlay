/**
 * Dotykové zóny plošinovky a souboje (P36C T2) – jedno místo pro vstup
 * (`usePlatformInput`, `useDuelInput`) i pro zóny, které se na startu ukážou
 * (`TouchZones`). Zóna je pruh obrazovky zleva doprava v podílech šířky.
 */

import type { IconName } from '../ui/icons';

export interface TouchZone {
  /** Levá hrana jako podíl šířky plochy (0..1). */
  readonly from: number;
  readonly to: number;
  readonly label: string;
  /** Ikona před popiskem; `up` = šipka nahoru (otočená `chevron-right`). */
  readonly icon?: IconName | 'up';
}

/** Plošinovka: levá čtvrtina drží vlevo, druhá vpravo, pravá polovina skáče – palec vlevo běží, palec vpravo skáče. */
export const PLATFORM_ZONES = [
  { from: 0, to: 0.25, label: 'Run', icon: 'chevron-left' },
  { from: 0.25, to: 0.5, label: 'Run', icon: 'chevron-right' },
  { from: 0.5, to: 1, label: 'Jump', icon: 'up' },
] as const satisfies readonly TouchZone[];

/** Souboj: levá půlka uhne, pravá udeří. */
export const DUEL_ZONES = [
  { from: 0, to: 0.5, label: 'Dodge' },
  { from: 0.5, to: 1, label: 'Strike' },
] as const satisfies readonly TouchZone[];

/** Index zóny pod prstem; `at` je poloha prstu jako podíl šířky plochy. */
export function zoneAt(zones: readonly TouchZone[], at: number): number {
  const index = zones.findIndex((zone) => at < zone.to);
  return index === -1 ? zones.length - 1 : index;
}

/**
 * Nápověda pro dotyk tam, kde ji text hry neřekne. Plošinovka píše „Arrows or
 * A/D to move, Space or tap to jump.“ – na telefonu šipky nejsou a „tap“ skáče
 * jen v pravé půlce. Ostatní ovládání nápovědu hry jen zbaví kláves (`touchHint`).
 */
export const ZONE_HINTS: Readonly<Partial<Record<string, string>>> = {
  platform: 'Hold left to run, tap right to jump.',
};
