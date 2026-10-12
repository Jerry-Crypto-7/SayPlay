/**
 * Úder (P46A T4): po dobu aktivního okna akce zasáhne nepřítele nebo
 * pronásledovatele v dosahu před hrdinou (a kousek za ním, ať jde odrazit
 * i lišku, která ho dohání). Zasažený zmizí a hráč dostane bod. Pravidlo nese
 * `verb`, takže ověření robotem dokáže, že úder ve hře opravdu něco udělal.
 */

import { z } from 'zod';

import { ARCADE_LIMITS, type ArcadeEffect, BODY, FLAG, HEADER, ROLE, type RulePiece, UNIT, bodyBase } from '../contract';
import { abilityActive } from './state';

export const STRIKE = {
  /** Dosah před hrdinou (osa z). */
  reach: 4 * UNIT,
  /** Dosah za hrdinou. */
  back: UNIT,
  /** Přesah do stran navíc k polovinám šířek. */
  wide: UNIT / 2,
} as const;

const strikeParams = z
  .object({
    keeper: z.int().min(1).max(ARCADE_LIMITS.maxBodies - 1),
    slot: z.int().min(0).max(1),
    verb: z.literal('strike'),
  })
  .strict();

const isStruck = (role: number): boolean => role === ROLE.enemy || role === ROLE.chaser;

/** Je tělo `other` v dosahu úderu hrdiny `player`? `ahead` = za kolik tiků, když oba poletí dál svou rychlostí (robot). */
export function inStrikeReach(state: Int32Array, player: number, other: number, ahead = 0): boolean {
  const p = bodyBase(player);
  const b = bodyBase(other);
  const along = (base: number, axis: number, speed: number): number => (state[base + axis] as number) + (state[base + speed] as number) * ahead;
  const dz = along(b, BODY.z, BODY.vz) - along(p, BODY.z, BODY.vz);
  if (dz < -STRIKE.back || dz > STRIKE.reach) return false;
  const dx = Math.abs(along(b, BODY.x, BODY.vx) - along(p, BODY.x, BODY.vx));
  if (dx * 2 >= (state[b + BODY.w] as number) + (state[p + BODY.w] as number) + 2 * STRIKE.wide) return false;
  const py = state[p + BODY.y] as number;
  const by = state[b + BODY.y] as number;
  return by < py + (state[p + BODY.h] as number) + STRIKE.wide && py < by + (state[b + BODY.h] as number) + STRIKE.wide;
}

export const strikeRule: RulePiece<z.infer<typeof strikeParams>> = {
  id: 'ability_strike',
  params: strikeParams,
  roles: ['player', 'enemy'],
  trigger: 'tick',
  cost: () => ({ bodies: 0, rules: 1 }),
  fire: ({ state, player }, params) => {
    if (abilityActive(state, params.keeper, params.slot) === 0) return [];
    const effects: ArcadeEffect[] = [];
    for (let i = 0; i < (state[HEADER.bodyCount] as number); i += 1) {
      const b = bodyBase(i);
      if (i === player || !isStruck(state[b + BODY.role] as number) || ((state[b + BODY.flags] as number) & FLAG.alive) === 0) continue;
      if (!inStrikeReach(state, player, i)) continue;
      effects.push({ kind: 'score', amount: 1 }, { kind: 'despawn', body: i });
    }
    return effects;
  },
};
