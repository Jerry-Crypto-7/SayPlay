/**
 * Krádež (P46A T5): po dobu aktivního okna hrdina sebere věc nebo ukradne
 * nepříteli, co nese („rabbit steals carrots“), v dosahu úderu. Úlovek
 * zvedne čítač `items` a skóre a zmizí – okradený nepřítel uteče ze hry.
 */

import { z } from 'zod';

import { ARCADE_LIMITS, type ArcadeEffect, BODY, FLAG, HEADER, ROLE, type RulePiece, bodyBase } from '../contract';
import { abilityActive } from './state';
import { inStrikeReach } from './strike';

const grabParams = z
  .object({ keeper: z.int().min(1).max(ARCADE_LIMITS.maxBodies - 1), slot: z.int().min(0).max(1), verb: z.literal('grab') })
  .strict();

const isLoot = (role: number): boolean => role === ROLE.collectible || role === ROLE.enemy;

export const grabRule: RulePiece<z.infer<typeof grabParams>> = {
  id: 'ability_grab',
  params: grabParams,
  roles: ['player', 'collectible'],
  trigger: 'tick',
  cost: () => ({ bodies: 0, rules: 1 }),
  fire: ({ state, player }, params) => {
    if (abilityActive(state, params.keeper, params.slot) === 0) return [];
    const effects: ArcadeEffect[] = [];
    for (let i = 0; i < (state[HEADER.bodyCount] as number); i += 1) {
      const b = bodyBase(i);
      if (i === player || !isLoot(state[b + BODY.role] as number) || ((state[b + BODY.flags] as number) & FLAG.alive) === 0) continue;
      if (!inStrikeReach(state, player, i)) continue;
      effects.push({ kind: 'score', amount: 1 }, { kind: 'count', counter: 'items', amount: 1 }, { kind: 'despawn', body: i });
    }
    return effects;
  },
};
