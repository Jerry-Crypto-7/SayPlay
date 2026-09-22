/**
 * Pravidla z knihovny (P25A): spouštěč → efekty. Společná všem arkádovým
 * hrám; stav nemění sama, efekty aplikuje jádro (`kernel.ts`).
 */

import { z } from 'zod';

import { ARCADE_HZ, BODY, COUNTER, HEADER, ROLE, type RulePiece, bodyBase } from '../contract';

const roleOf = (state: Int32Array, body: number): number => state[bodyBase(body) + BODY.role] as number;

const hitParams = z.object({ role: z.enum(['obstacle', 'chaser', 'hazard', 'enemy']), effect: z.enum(['lose', 'damage']) }).strict();

/** Náraz do role → prohra, nebo ztráta života (a překážka zmizí, aby nebrala život každý tik). */
export const hit: RulePiece<z.infer<typeof hitParams>> = {
  id: 'hit',
  params: hitParams,
  roles: ['player', 'obstacle', 'chaser', 'hazard', 'enemy'],
  trigger: 'contact',
  cost: () => ({ bodies: 0, rules: 1 }),
  fire: ({ state, other }, params) => {
    if (roleOf(state, other) !== ROLE[params.role]) return [];
    return params.effect === 'lose'
      ? [{ kind: 'lose' }]
      : [
          { kind: 'damage', amount: 1 },
          { kind: 'despawn', body: other },
        ];
  },
};

const pickupParams = z.object({ points: z.int().min(1).max(100).default(1) }).strict();

/** Sebraný předmět → body a předmět zmizí. */
export const pickup: RulePiece<z.infer<typeof pickupParams>> = {
  id: 'pickup',
  params: pickupParams,
  roles: ['player', 'collectible'],
  trigger: 'contact',
  cost: () => ({ bodies: 0, rules: 1 }),
  fire: ({ state, other }, params) =>
    roleOf(state, other) === ROLE.collectible
      ? [
          { kind: 'score', amount: params.points },
          { kind: 'despawn', body: other },
        ]
      : [],
};

const noParams = z.object({}).strict();

/** Dotek cíle (páska na konci trati) → výhra. */
export const finish: RulePiece<z.infer<typeof noParams>> = {
  id: 'finish',
  params: noParams,
  roles: ['player', 'goal'],
  trigger: 'contact',
  cost: () => ({ bodies: 1, rules: 1 }),
  fire: ({ state, other }) => (roleOf(state, other) === ROLE.goal ? [{ kind: 'win' }] : []),
};

/** Životy došly → prohra. Patří k `hit` s `effect: 'damage'`. */
export const outOfHealth: RulePiece<z.infer<typeof noParams>> = {
  id: 'out_of_health',
  params: noParams,
  roles: ['player'],
  trigger: 'counter',
  cost: () => ({ bodies: 0, rules: 1 }),
  fire: ({ state }) => ((state[HEADER.counters + COUNTER.health] as number) <= 0 ? [{ kind: 'lose' }] : []),
};

const timeLimitParams = z.object({ seconds: z.int().min(10).max(90) }).strict();

/** Časový limit → prohra, když cíl nepřišel včas. */
export const timeLimit: RulePiece<z.infer<typeof timeLimitParams>> = {
  id: 'time_limit',
  params: timeLimitParams,
  roles: ['player'],
  trigger: 'tick',
  cost: () => ({ bodies: 0, rules: 1 }),
  fire: ({ state }, params) => ((state[HEADER.tick] as number) >= params.seconds * ARCADE_HZ ? [{ kind: 'lose' }] : []),
};

const fallOutParams = z.object({ belowY: z.int(), effect: z.enum(['lose', 'respawn']) }).strict();

/** Pád pod úroveň (spodní stěna hráče pod `belowY`) → prohra, nebo návrat na checkpoint. */
export const fallOut: RulePiece<z.infer<typeof fallOutParams>> = {
  id: 'fall_out',
  params: fallOutParams,
  roles: ['player'],
  trigger: 'tick',
  cost: () => ({ bodies: 0, rules: 1 }),
  fire: ({ state, player }, params) => ((state[bodyBase(player) + BODY.y] as number) < params.belowY ? [{ kind: params.effect }] : []),
};

/** Dotek checkpointu → místo návratu je na něm. */
export const checkpoint: RulePiece<z.infer<typeof noParams>> = {
  id: 'checkpoint',
  params: noParams,
  roles: ['player', 'checkpoint'],
  trigger: 'contact',
  cost: () => ({ bodies: 0, rules: 1 }),
  fire: ({ state, other }) => (roleOf(state, other) === ROLE.checkpoint ? [{ kind: 'checkpoint', body: other }] : []),
};

export const RULES = { hit, pickup, finish, out_of_health: outOfHealth, time_limit: timeLimit, fall_out: fallOut, checkpoint } as const;
