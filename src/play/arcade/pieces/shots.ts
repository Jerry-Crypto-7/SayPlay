/**
 * Pravidla letícího předmětu (P25G): společná střelbě i hodu. Projektil
 * ukončuje jádro (`hit` spouštěč), tahle pravidla jen říkají, co to znamená.
 */

import { z } from 'zod';

import { type ArcadeEffect, BODY, COUNTER, FLAG, HEADER, ROLE, type RulePiece, bodyBase } from '../contract';
import { SHOOTER, gunOf, gunTick } from './shooter';

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

const blasterParams = z
  .object({
    template: z.int().min(0),
    /** `forward` = po trati (+z), `heading` = směrem pohybu (aréna). */
    aim: z.enum(['forward', 'heading']),
  })
  .strict();

/** Zásobník blasteru je jeden – bez rezervy se nikdy nepřebíjí. */
const BLASTER_GUN = { magazine: 50, reloadTicks: 1 } as const;

/**
 * Zbraň doplňku `+shoot` (P26D): spoušť z čítače `trigger`, zásobník a rozestup
 * ran stejnou funkcí `gunTick` jako střelnice; střela z prostředku hráče.
 * `gun` střelnice to být nemůže – spoušť čte z `aux1`, kde běžec drží skluz.
 */
export const blaster: RulePiece<z.infer<typeof blasterParams>> = {
  id: 'blaster',
  params: blasterParams,
  roles: ['player', 'projectile'],
  trigger: 'tick',
  cost: () => ({ bodies: 0, rules: 1 }),
  fire: ({ state, player }, params) => {
    const base = bodyBase(player);
    const before = gunOf(state);
    const { fired, next } = gunTick(before, state[HEADER.counters + COUNTER.trigger] === 1, { template: params.template, ...BLASTER_GUN });
    const effects: ArcadeEffect[] = [];
    if (next.ammo !== before.ammo) effects.push({ kind: 'count', counter: 'ammo', amount: next.ammo - before.ammo });
    if (next.cooldown !== before.cooldown) effects.push({ kind: 'count', counter: 'cooldown', amount: next.cooldown - before.cooldown });
    if (!fired) return effects;
    const vx = state[base + BODY.vx] as number;
    const vz = state[base + BODY.vz] as number;
    const speed = Math.hypot(vx, vz);
    const [dx, dz] = params.aim === 'forward' || speed === 0 ? [0, 1] : [vx / speed, vz / speed];
    const carried = params.aim === 'forward' ? Math.max(0, vz) : 0;
    effects.push({
      kind: 'spawn',
      template: params.template,
      x: state[base + BODY.x] as number,
      y: (state[base + BODY.y] as number) + Math.floor(((state[base + BODY.h] as number) - SHOOTER.bulletSize) / 2),
      z: (state[base + BODY.z] as number) + Math.trunc((dz * (state[base + BODY.d] as number)) / 2),
      vx: Math.trunc(dx * SHOOTER.bulletSpeed),
      vy: 0,
      vz: Math.trunc(dz * SHOOTER.bulletSpeed) + carried,
    });
    return effects;
  },
};

export const SHOT_RULES = { shot_hit: shotHit, cleared, out_of_ammo: outOfAmmo, blaster } as const;
