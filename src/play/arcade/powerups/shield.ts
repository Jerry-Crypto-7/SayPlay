/**
 * Štít (P46C) sdílí s akcí štítu náboj (`ABILITY_SLOTS.shield`), blok i ochranu nárazů
 * (`shieldParts` v `abilities`). Sebrání náboj nabije (efekt `powerup`), první pohlcený
 * zásah ho spotřebuje a tím štít skončí; jinak doběhne `POWERUP_TICKS.shield`.
 */

import { type AbilityControl, abilityActive } from '../abilities/state';
import { ABILITY_SLOTS, bodyBase } from '../contract';

/** Blok spotřeboval náboj – štít skončil zásahem. */
export const shieldSpent = (state: Int32Array, keeper: number): boolean => state[bodyBase(keeper) + ABILITY_SLOTS.shield] === 0;

/** Po konci štítu náboj zmizí, pokud ho nedrží otevřené okno akce štítu. */
export function dropShield(state: Int32Array, keeper: number, abilities: AbilityControl | undefined): void {
  const slot = abilities?.ids.indexOf('shield') ?? -1;
  if (slot < 0 || abilityActive(state, keeper, slot) === 0) state[bodyBase(keeper) + ABILITY_SLOTS.shield] = 0;
}
