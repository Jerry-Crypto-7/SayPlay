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

import { ABILITY_SLOTS, ARCADE_LIMITS, type ArcadeEffect, BODY, FLAG, ROLE, type RulePiece, bodyBase } from '../contract';
import { FIGHT, FIGHT_PHASE, LANDED, enemiesOf, inArc, phaseOf, phaseTicksLeft, strikeDirectionOf } from '../pieces/fight';
import { HARMFUL_ROLES, abilityActive, fightDashed, partBodies } from './state';

const harmful = z.array(z.enum(HARMFUL_ROLES)).min(1).max(HARMFUL_ROLES.length);

/** Ublíží tělo `body`? Role z `roles`, nebo díl složené hry z `parts` (P47B T4) – ten má roli věci a zná se po indexu. */
const isHarm = (state: Int32Array, body: number, roles: readonly string[], parts?: readonly number[]): boolean =>
  (roles.some((role) => ROLE[role as (typeof HARMFUL_ROLES)[number]] === state[bodyBase(body) + BODY.role]) || parts?.includes(body) === true) &&
  ((state[bodyBase(body) + BODY.flags] as number) & FLAG.alive) !== 0;

const dashParams = z
  .object({ keeper: z.int().min(1).max(ARCADE_LIMITS.maxBodies - 1), slot: z.int().min(0).max(1), roles: harmful, parts: partBodies.optional(), verb: z.literal('dash') })
  .strict();

/**
 * V aktivním dashi hrdina prorazí, do čeho narazí: tělo zmizí a náraz (`hit` či díl `assembly_part` s `guard`) nic nevezme.
 * Díl složené hry je při dotyku už hotový (`assembly-parts.ts` `done`): padá z výšky a do hrdiny dorazí až po metru cesty.
 */
export const dashRule: RulePiece<z.infer<typeof dashParams>> = {
  id: 'ability_dash',
  params: dashParams,
  roles: ['player', ...HARMFUL_ROLES],
  trigger: 'contact',
  cost: () => ({ bodies: 0, rules: 1 }),
  fire: ({ state, other }, params) =>
    abilityActive(state, params.keeper, params.slot) > 0 && isHarm(state, other, params.roles, params.parts) ? [{ kind: 'despawn', body: other }] : [],
};

// Bez slovesa jen štít power-upu (P46C): hra ho neslíbila, ověření ho tedy nedokazuje.
const shieldParams = z
  .object({ keeper: z.int().min(1).max(ARCADE_LIMITS.maxBodies - 1), roles: harmful, parts: partBodies.optional(), verb: z.literal('shield').optional() })
  .strict();

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
    (state[bodyBase(params.keeper) + ABILITY_SLOTS.shield] as number) === 0 || !isHarm(state, other, params.roles, params.parts) ? [] : [{ kind: 'block', keeper: params.keeper, body: other }],
};

const blowParams = z
  .object({ keeper: z.int().min(1).max(ARCADE_LIMITS.maxBodies - 1), verb: z.enum(['dash', 'shield']), dash: z.int().min(0).max(1).optional() })
  .strict();

/**
 * Souboj v aréně (P47B T6): úder soupeře nese ovládání souboje, ne náraz. Úder, který tento tik začal a hrdinu
 * by zasáhl (týž oblouk a dosah jako v `stepEnemy`), ale nedopadl, odrazila ochrana ovládání (`blowGuarded`).
 * Pravidlo nese sloveso a za odražený úder dá bod. Dash ve slotu `dash` bere úder, dokud běží jeho okno
 * (`fightDashed`); štít bere ostatní.
 */
export const fightGuardRule: RulePiece<z.infer<typeof blowParams>> = {
  id: 'ability_fight_guard',
  params: blowParams,
  roles: ['player', 'enemy'],
  trigger: 'press',
  cost: () => ({ bodies: 0, rules: 1 }),
  fire: ({ state, player }, params) => {
    if ((params.dash !== undefined && fightDashed(state, params.keeper, params.dash)) !== (params.verb === 'dash')) return [];
    const p = bodyBase(player);
    const effects: ArcadeEffect[] = [];
    for (const i of enemiesOf(state)) {
      const b = bodyBase(i);
      if (phaseOf(state, i) !== FIGHT_PHASE.strike || phaseTicksLeft(state, i) !== FIGHT.strike || ((state[b + BODY.aux0] as number) & LANDED) !== 0) continue;
      const dx = (state[p + BODY.x] as number) - (state[b + BODY.x] as number);
      const dz = (state[p + BODY.z] as number) - (state[b + BODY.z] as number);
      if (inArc(dx, dz, strikeDirectionOf(state, i), FIGHT.strikeReach, FIGHT.strikeArc)) effects.push({ kind: 'score', amount: 1 });
    }
    return effects;
  },
};
