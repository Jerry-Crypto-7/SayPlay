/**
 * Tik power-upu (P46C) v obalu ovládání (`addon_control`): odpočet trvání, konec štítu
 * zásahem, magnet a zrychlení. Sebrání samo zapíše jádro (efekt `powerup`). Bez importu
 * doplňků, ať je `addons.ts` může volat bez kruhu – jako `abilities/state.ts`.
 */

import { z } from 'zod';

import type { AbilityControl } from '../abilities/state';
import { ARCADE_LIMITS, POWERUPS, POWERUP_SLOTS, bodyBase } from '../contract';
import { pullItems } from './magnet';
import { dropShield, shieldSpent } from './shield';
import { boostSpeed, speedParams } from './speed';

export const powerupControlParams = z
  .object({
    /** Počítadlo s `POWERUP_SLOTS` – ve světě s akcemi `abilityKeeper`. */
    keeper: z.int().min(1).max(ARCADE_LIMITS.maxBodies - 1),
    /** Zrychlení žánru; bez něj svět power-up zrychlení nemá. */
    speed: speedParams.optional(),
  })
  .strict();
export type PowerupControl = z.infer<typeof powerupControlParams>;

/** Jeden tik aktivního power-upu, po kroku základního ovládání a akcí. */
export function tickPowerup(state: Int32Array, player: number, params: PowerupControl, abilities: AbilityControl | undefined): void {
  const k = bodyBase(params.keeper);
  const left = state[k + POWERUP_SLOTS.left] as number;
  if (left === 0) return;
  const kind = POWERUPS[(state[k + POWERUP_SLOTS.kind] as number) - 1];
  const next = kind === 'shield' && shieldSpent(state, params.keeper) ? 0 : left - 1;
  state[k + POWERUP_SLOTS.left] = next;
  if (next === 0) state[k + POWERUP_SLOTS.kind] = 0;
  // Náboj patří štítu: po jeho konci, nebo když ho nový power-up nahradil, zmizí.
  if (next === 0 || kind !== 'shield') dropShield(state, params.keeper, abilities);
  if (next === 0) return;
  if (kind === 'magnet') pullItems(state, player);
  else if (kind === 'speed' && params.speed !== undefined) boostSpeed(state, player, params.speed);
}
