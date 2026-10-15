/**
 * Zrychlení (P46C): po kroku základního ovládání obal (`tickPowerup`) přidá rychlosti
 * hrdiny daný podíl. Platí jen pro ovládání, které rychlost každý tik nastaví znovu
 * (běžec, poletování, pohled shora) – u ovládání se zrychlováním by se podíl sčítal
 * tik po tiku. Které žánry ho dostanou, rozhoduje rozmístění.
 */

import { z } from 'zod';

import { BODY, bodyBase } from '../contract';

export const speedParams = z
  .object({
    /** O kolik procent je hrdina rychlejší. */
    pct: z.int().min(5).max(100),
    /** I do stran (pohled shora); bez něj jen vpřed (`vz`), ať běžec nepřestřelí pruh. */
    lateral: z.literal(true).optional(),
  })
  .strict();
export type SpeedParams = z.infer<typeof speedParams>;

export function boostSpeed(state: Int32Array, player: number, params: SpeedParams): void {
  const p = bodyBase(player);
  state[p + BODY.vz] = (state[p + BODY.vz] as number) + Math.trunc(((state[p + BODY.vz] as number) * params.pct) / 100);
  if (params.lateral === true) state[p + BODY.vx] = (state[p + BODY.vx] as number) + Math.trunc(((state[p + BODY.vx] as number) * params.pct) / 100);
}
