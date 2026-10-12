/**
 * Zvuk každé události sběrnice efektů (P37B T5). Snímky „před“ (T1) ukázaly,
 * že dopad, zánik nepřítele, zrod těla a změna stavu cíle jsou jen vidět –
 * 16 z 22 her hrálo tři sekundy bez jediného zvuku. Tabulka je úplná podle
 * typu (`Record`), test hlídá, že žádný druh nezůstane němý.
 *
 * Sebrání, zásah hráče, výhru a prohru ozvučují i efekty jádra (`presetsFor`
 * v `ArcadePlay`); dvojí zvuk v jednom tiku spolkne `playSfx` (`SFX_REPEAT_MS`).
 */

import { ROLE } from '@/play/arcade/contract';
import type { SfxPreset } from '@/play/audio';

import type { VisualEvent, VisualEventKind } from './bus';

export const BUS_SFX: Readonly<Record<VisualEventKind, SfxPreset>> = {
  pickup: 'pickup',
  hit: 'hit',
  death: 'pop',
  win: 'win',
  lose: 'lose',
  stateChange: 'chime',
  land: 'land',
  spawn: 'spawn',
  // Blízké minutí (P45C T15): krátký „whoosh“ – šum skluzu, který hrozba nechala za sebou.
  nearMiss: 'slide',
};

/** Zvuk jedné události: zásah jiného těla než hráče je úder, ne bolest hráče. */
export const busPresetOf = (event: Pick<VisualEvent, 'kind' | 'role'>): SfxPreset => (event.kind === 'hit' && event.role !== ROLE.player ? 'strike' : BUS_SFX[event.kind]);

/** Zvuky jednoho tiku sběrnice: konec běhu přehluší zbytek, jinak každý zvuk nejvýš jednou. */
export function busPresets(events: readonly VisualEvent[]): SfxPreset[] {
  if (events.some((event) => event.kind === 'lose')) return ['lose'];
  if (events.some((event) => event.kind === 'win')) return ['win'];
  return [...new Set(events.map(busPresetOf))];
}
