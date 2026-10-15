/**
 * Pravidla z knihovny (P25A): spouštěč → efekty. Společná všem arkádovým
 * hrám; stav nemění sama, efekty aplikuje jádro (`kernel.ts`).
 */

import { z } from 'zod';

import { guardParams, guardedHit } from '../abilities/state';
import {
  ARCADE_HZ,
  ARCADE_LIMITS,
  type ArcadeEffect,
  BODY,
  COMBO,
  COUNTER,
  FLAG,
  HEADER,
  POWERUPS,
  POWERUP_TICKS,
  ROLE,
  type RulePiece,
  type ScoreBonusParams,
  bodyBase,
  graceOf,
  powerupCode,
} from '../contract';
import { scoreFactor } from '../powerups/double';

const roleOf = (state: Int32Array, body: number): number => state[bodyBase(body) + BODY.role] as number;

const hitParams = z
  .object({
    role: z.enum(['obstacle', 'chaser', 'hazard', 'enemy']),
    effect: z.enum(['lose', 'damage']),
    /** Milost po zásahu v ticích (P36A T2): po ztrátě života tolik tiků další zásah nic nebere. Bez ní jako dřív. */
    grace: z.int().min(1).max(ARCADE_LIMITS.maxTicks).optional(),
    /** Co po ztrátě života (P36A T2): překážka zmizí (výchozí, jako dřív), nebo se hráč vrátí na místo návratu (checkpoint). */
    after: z.enum(['despawn', 'respawn']).optional(),
    /** Ochrana akcí hrdiny (P46A T5): v aktivním dashi (`dash` = slot A/B) nebo s nabitým štítem náraz nic nebere. */
    guard: guardParams.optional(),
  })
  .strict();

const solidBody = (state: Int32Array, body: number): boolean => ((state[bodyBase(body) + BODY.flags] as number) & FLAG.solid) !== 0;

/**
 * Náraz do role → prohra, nebo ztráta života: překážka zmizí, aby nebrala život
 * každý tik, nebo (`after: 'respawn'`, hrot skákačky) se hráč vrátí na checkpoint.
 * S `grace` hráč v milosti nepřijde o nic: nepevnou věcí projde, pevná zmizí,
 * ať ho na trati nezastaví (běžec by za ní stál, dokud milost nedoběhne).
 */
export const hit: RulePiece<z.infer<typeof hitParams>> = {
  id: 'hit',
  params: hitParams,
  roles: ['player', 'obstacle', 'chaser', 'hazard', 'enemy'],
  trigger: 'contact',
  cost: () => ({ bodies: 0, rules: 1 }),
  fire: ({ state, player, other }, params) => {
    if (roleOf(state, other) !== ROLE[params.role]) return [];
    return guardedHit(state, params.guard, other, crash(state, player, other, params));
  },
};

function crash(state: Int32Array, player: number, other: number, params: z.infer<typeof hitParams>): ArcadeEffect[] {
  if (params.effect === 'lose') return [{ kind: 'lose' }];
  const despawn = params.after !== 'respawn';
  if (params.grace !== undefined && graceOf(state, player) > 0) return despawn && solidBody(state, other) ? [{ kind: 'despawn', body: other }] : [];
  return [
    params.grace === undefined ? { kind: 'damage', amount: 1 } : { kind: 'damage', amount: 1, grace: params.grace },
    despawn ? { kind: 'despawn', body: other } : { kind: 'respawn' },
  ];
}

const pickupParams = z
  .object({
    points: z.int().min(1).max(100).default(1),
    /** Index těla-počítadla komba (P36A T5, `COMBO`); bez něj body bez násobiče jako dřív. */
    combo: z.int().min(1).max(ARCADE_LIMITS.maxBodies - 1).optional(),
    /** Power-upy (P46C): počítadlo a druh každého tělesa role `powerup` podle indexu; bez nich jako dřív. */
    powerup: z
      .object({
        keeper: z.int().min(1).max(ARCADE_LIMITS.maxBodies - 1),
        at: z.array(z.tuple([z.int().min(1).max(ARCADE_LIMITS.maxBodies - 1), z.enum(POWERUPS)])).min(1).max(8),
      })
      .strict()
      .optional(),
    /** `false` = sbírá jen power-upy: věci světa sbírá jiné pravidlo (aréna `arena_eat`). */
    items: z.literal(false).optional(),
  })
  .strict();

/**
 * Násobič dalšího sebrání: o 1 výš, když předchozí přišlo nejvýš `COMBO.window`
 * tiků zpátky a hráč mezitím nepřišel o život, jinak ×1. Čte ho i zásah střelou (`shot_hit`).
 */
export function nextMultiplier(state: Int32Array, keeper: number): number {
  const base = bodyBase(keeper);
  const last = state[base + BODY.aux1] as number;
  const health = state[HEADER.counters + COUNTER.health] as number;
  const inRow = last > 0 && (state[HEADER.tick] as number) + 1 - last <= COMBO.window && health >= (state[base + BODY.x] as number);
  return inRow ? Math.min(COMBO.max, Math.max(1, state[base + BODY.aux0] as number) + 1) : 1;
}

/**
 * Sebraný předmět → body a předmět zmizí. S `combo` body krát násobič a počítadlo si sebrání zapíše.
 * Power-up (P46C) zapíše časovaný stav do počítadla; aktivní 2× zdvojí body vedle komba.
 */
export const pickup: RulePiece<z.infer<typeof pickupParams>> = {
  id: 'pickup',
  params: pickupParams,
  roles: ['player', 'collectible', 'powerup'],
  trigger: 'contact',
  cost: () => ({ bodies: 0, rules: 1 }),
  fire: ({ state, other }, params) => {
    const role = roleOf(state, other);
    if (role === ROLE.powerup && params.powerup !== undefined) {
      const id = params.powerup.at.find(([body]) => body === other)?.[1];
      if (id === undefined) return [];
      return [
        { kind: 'powerup', keeper: params.powerup.keeper, power: powerupCode(id), ticks: POWERUP_TICKS[id] },
        { kind: 'despawn', body: other },
      ];
    }
    if (role !== ROLE.collectible || params.items === false) return [];
    const factor = scoreFactor(state, params.powerup?.keeper);
    if (params.combo === undefined) {
      return [
        { kind: 'score', amount: params.points * factor },
        { kind: 'despawn', body: other },
      ];
    }
    const multiplier = nextMultiplier(state, params.combo);
    return [
      { kind: 'score', amount: params.points * multiplier * factor },
      { kind: 'despawn', body: other },
      { kind: 'combo', body: params.combo, multiplier },
    ];
  },
};

const scoreBonusParams = z
  .object({
    lives: z.int().min(0).max(9),
    limit: z.int().min(1).max(ARCADE_LIMITS.maxTicks),
    target: z.int().min(0).max(9999),
  })
  .strict() satisfies z.ZodType<ScoreBonusParams>;

/**
 * Skóre, které rozhoduje (P36A T5). Bonus na konci výhry přičte jádro
 * (`endBonus` v `kernel.ts`, čte parametry tohohle pravidla). Pravidlo samo
 * hlídá cílové skóre: dosažený `target` = výhra hned, v průchodu čítačů. Výhra
 * jinou cestou pod cílem po bonusu je prohra – to rozhodne jádro.
 */
export const scoreBonus: RulePiece<z.infer<typeof scoreBonusParams>> = {
  id: 'score_bonus',
  params: scoreBonusParams,
  roles: ['player'],
  trigger: 'counter',
  cost: () => ({ bodies: 1, rules: 1 }),
  fire: ({ state }, params) => (params.target > 0 && (state[HEADER.counters + COUNTER.score] as number) >= params.target ? [{ kind: 'win' }] : []),
};

const noParams = z.object({}).strict();

/** Leží ještě nějaká sbíraná věc? */
function itemLeft(state: Int32Array): boolean {
  const count = state[HEADER.bodyCount] as number;
  for (let i = 0; i < count; i += 1) {
    const base = bodyBase(i);
    if (((state[base + BODY.flags] as number) & FLAG.alive) !== 0 && state[base + BODY.role] === ROLE.collectible) return true;
  }
  return false;
}

const finishParams = z.object({ allItems: z.boolean().optional() }).strict();

/**
 * Dotek cíle (páska na konci trati) → výhra. S `allItems` (P35 T3, „collect 5
 * carrots and reach the burrow“) až tehdy, když žádná sbíraná věc nezbyla.
 */
export const finish: RulePiece<z.infer<typeof finishParams>> = {
  id: 'finish',
  params: finishParams,
  roles: ['player', 'goal'],
  trigger: 'contact',
  cost: () => ({ bodies: 1, rules: 1 }),
  fire: ({ state, other }, params) => (roleOf(state, other) === ROLE.goal && (params.allItems !== true || !itemLeft(state)) ? [{ kind: 'win' }] : []),
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

const fallOutParams = z
  .object({
    belowY: z.int(),
    effect: z.enum(['lose', 'respawn']),
    /**
     * Odpuštění (P37A T7, poletování s `feel: 2`): pád platí, až když ovládání
     * napočítá v `aux0` hráče aspoň tolik tiků na zemi. Bez něj hned jako dřív.
     */
    afterTicks: z.int().min(1).max(ARCADE_HZ).optional(),
  })
  .strict();

/** Pád pod úroveň (spodní stěna hráče pod `belowY`) → prohra, nebo návrat na checkpoint. */
export const fallOut: RulePiece<z.infer<typeof fallOutParams>> = {
  id: 'fall_out',
  params: fallOutParams,
  roles: ['player'],
  trigger: 'tick',
  cost: () => ({ bodies: 0, rules: 1 }),
  fire: ({ state, player }, params) => {
    const base = bodyBase(player);
    if ((state[base + BODY.y] as number) >= params.belowY) return [];
    return params.afterTicks === undefined || (state[base + BODY.aux0] as number) >= params.afterTicks ? [{ kind: params.effect }] : [];
  },
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

export const RULES = { hit, pickup, finish, out_of_health: outOfHealth, time_limit: timeLimit, fall_out: fallOut, checkpoint, score_bonus: scoreBonus } as const;
