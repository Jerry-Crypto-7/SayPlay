/**
 * Pravidla letícího předmětu (P25G): společná střelbě i hodu. Projektil
 * ukončuje jádro (`hit` spouštěč), tahle pravidla jen říkají, co to znamená.
 */

import { z } from 'zod';

import { BODY, COUNTER, FLAG, HEADER, ROLE, type RulePiece, bodyBase } from '../contract';

const noParams = z.object({}).strict();

const isFoe = (role: number): boolean => role === ROLE.target || role === ROLE.enemy;

/** Živé terče a nepřátelé; `projectiles` navíc počítá projektily ve vzduchu. */
export function census(state: Int32Array): { foes: number; projectiles: number } {
  let foes = 0;
  let projectiles = 0;
  const count = state[HEADER.bodyCount] as number;
  for (let i = 0; i < count; i += 1) {
    const base = bodyBase(i);
    if (((state[base + BODY.flags] as number) & FLAG.alive) === 0) continue;
    const role = state[base + BODY.role] as number;
    if (isFoe(role)) foes += 1;
    else if (role === ROLE.projectile) projectiles += 1;
  }
  return { foes, projectiles };
}

/** Zásah terče nebo nepřítele → bod a tělo zmizí. Zásah zdi a minutí nic. */
export const shotHit: RulePiece<z.infer<typeof noParams>> = {
  id: 'shot_hit',
  params: noParams,
  roles: ['projectile', 'target', 'enemy'],
  trigger: 'hit',
  cost: () => ({ bodies: 0, rules: 1 }),
  fire: ({ state, other }) =>
    other >= 0 && isFoe(state[bodyBase(other) + BODY.role] as number)
      ? [
          { kind: 'score', amount: 1 },
          { kind: 'despawn', body: other },
        ]
      : [],
};

/** Žádný živý terč ani nepřítel → výhra. */
export const cleared: RulePiece<z.infer<typeof noParams>> = {
  id: 'cleared',
  params: noParams,
  roles: ['target', 'enemy'],
  trigger: 'counter',
  cost: () => ({ bodies: 0, rules: 1 }),
  fire: ({ state }) => (census(state).foes === 0 ? [{ kind: 'win' }] : []),
};

/**
 * Munice (hody) došla, nic neletí a terče zbyly → prohra. Čeká na poslední
 * projektil ve vzduchu: ten ještě může trefit poslední terč.
 */
export const outOfAmmo: RulePiece<z.infer<typeof noParams>> = {
  id: 'out_of_ammo',
  params: noParams,
  roles: ['projectile', 'target', 'enemy'],
  trigger: 'counter',
  cost: () => ({ bodies: 0, rules: 1 }),
  fire: ({ state }) => {
    if ((state[HEADER.counters + COUNTER.ammo] as number) > 0 || (state[HEADER.counters + COUNTER.reserve] as number) > 0) return [];
    const { foes, projectiles } = census(state);
    return foes > 0 && projectiles === 0 ? [{ kind: 'lose' }] : [];
  },
};

export const SHOT_RULES = { shot_hit: shotHit, cleared, out_of_ammo: outOfAmmo } as const;
