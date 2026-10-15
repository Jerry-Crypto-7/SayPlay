/**
 * Dash a štít (P46A T5): obě akce chrání hrdinu před nárazem. Náraz samotný
 * (`hit`) dostane parametr `guard` a v ochraně nic nebere; tahle pravidla
 * nesou sloveso a dělají to, co ochrana ve hře viditelně udělá – dash
 * prorazí, co hrdinu trefí, štít to odrazí a spotřebuje svůj jeden náboj.
 *
 * simplified: dash hrdinou nepohne (jen nezranitelný průraz), protože přímý
 * zápis polohy by se bil s fyzikou skákačky; skok do strany až s P46C, když
 * ho hraní ukáže jako chybějící.
 */

import { z } from 'zod';

import { ABILITY_SLOTS, ARCADE_LIMITS, BODY, FLAG, ROLE, type RulePiece, bodyBase } from '../contract';
import { HARMFUL_ROLES, abilityActive } from './state';

const harmful = z.array(z.enum(HARMFUL_ROLES)).min(1).max(HARMFUL_ROLES.length);

const isHarm = (state: Int32Array, body: number, roles: readonly string[]): boolean =>
  roles.some((role) => ROLE[role as (typeof HARMFUL_ROLES)[number]] === state[bodyBase(body) + BODY.role]) &&
  ((state[bodyBase(body) + BODY.flags] as number) & FLAG.alive) !== 0;

const dashParams = z
  .object({ keeper: z.int().min(1).max(ARCADE_LIMITS.maxBodies - 1), slot: z.int().min(0).max(1), roles: harmful, verb: z.literal('dash') })
  .strict();

/** V aktivním dashi hrdina prorazí, do čeho narazí: tělo zmizí a náraz (`hit` s `guard`) nic nevezme. */
export const dashRule: RulePiece<z.infer<typeof dashParams>> = {
  id: 'ability_dash',
  params: dashParams,
  roles: ['player', ...HARMFUL_ROLES],
  trigger: 'contact',
  cost: () => ({ bodies: 0, rules: 1 }),
  fire: ({ state, other }, params) =>
    abilityActive(state, params.keeper, params.slot) > 0 && isHarm(state, other, params.roles) ? [{ kind: 'despawn', body: other }] : [],
};

// Bez slovesa jen štít power-upu (P46C): hra ho neslíbila, ověření ho tedy nedokazuje.
const shieldParams = z.object({ keeper: z.int().min(1).max(ARCADE_LIMITS.maxBodies - 1), roles: harmful, verb: z.literal('shield').optional() }).strict();

/**
 * Nabitý štít pohltí jeden náraz: tělo zmizí a náboj spadne na 0. O náboji rozhodne
 * jádro až při použití bloku (R2), takže z dvou nárazů téhož tiku pohltí jen první;
 * náraz druhého (`hit` v `ifAlive`) projde. Pravidlo stojí před nárazy (`guardAbility`).
 */
export const shieldRule: RulePiece<z.infer<typeof shieldParams>> = {
  id: 'ability_shield',
  params: shieldParams,
  roles: ['player', ...HARMFUL_ROLES],
  trigger: 'contact',
  cost: () => ({ bodies: 0, rules: 1 }),
  fire: ({ state, other }, params) =>
    (state[bodyBase(params.keeper) + ABILITY_SLOTS.shield] as number) === 0 || !isHarm(state, other, params.roles) ? [] : [{ kind: 'block', keeper: params.keeper, body: other }],
};
