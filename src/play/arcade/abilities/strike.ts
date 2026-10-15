/**
 * Úder (P46A T4): po dobu aktivního okna akce zasáhne nepřítele nebo
 * pronásledovatele v dosahu před hrdinou (a kousek za ním, ať jde odrazit
 * i lišku, která ho dohání). Zasažený zmizí a hráč dostane bod. Pravidlo nese
 * `verb`, takže ověření robotem dokáže, že úder ve hře opravdu něco udělal.
 */

import { z } from 'zod';

import { ARCADE_LIMITS, type ArcadeEffect, BODY, FLAG, HEADER, ROLE, type RulePiece, UNIT, bodyBase, bodyHp } from '../contract';
import { blow, bossBeatParams } from '../pieces/boss';
import { nextMultiplier } from '../pieces/rules';
import { matches } from '../pieces/behaviours';
import { ABILITY_TIMING, abilityActive } from './state';

export const STRIKE = {
  /** Dosah před hrdinou (osa z). */
  reach: 4 * UNIT,
  /** Dosah za hrdinou. */
  back: UNIT,
  /** Přesah do stran navíc k polovinám šířek. */
  wide: UNIT / 2,
  /** Pohled shora (aréna, bludiště): dosah kolem hrdiny na všechny strany, navíc k polovinám rozměrů. */
  around: 2 * UNIT,
} as const;

/** Ovládání s pohledem shora, kde „vpřed“ není osa z: úder a krádež sahají kolem hrdiny. */
export const AROUND_CONTROLS: readonly string[] = ['move_free', 'walker'];

const strikeParams = z
  .object({
    keeper: z.int().min(1).max(ARCADE_LIMITS.maxBodies - 1),
    slot: z.int().min(0).max(1),
    verb: z.literal('strike'),
    around: z.literal(true).optional(),
    /** Boss finále (P46B T8): předloha a kořist jako u jeho pravidla pádu. */
    boss: bossBeatParams.optional(),
    /** Počítadlo komba (P46C T3): úder v sérii bere násobič jako zásah střelou. */
    combo: z.int().min(1).max(ARCADE_LIMITS.maxBodies - 1).optional(),
  })
  .strict();

const isStruck = (role: number): boolean => role === ROLE.enemy || role === ROLE.chaser;

/**
 * Je tělo `other` v dosahu úderu hrdiny `player`? `ahead` = za kolik tiků, když oba poletí dál
 * svou rychlostí (robot). `around` = pohled shora: dosah kolem hrdiny v rovině x/z.
 */
export function inStrikeReach(state: Int32Array, player: number, other: number, ahead = 0, around = false): boolean {
  const p = bodyBase(player);
  const b = bodyBase(other);
  const along = (base: number, axis: number, speed: number): number => (state[base + axis] as number) + (state[base + speed] as number) * ahead;
  if (around) {
    const near = (axis: number, speed: number, size: number): boolean =>
      Math.abs(along(b, axis, speed) - along(p, axis, speed)) * 2 < (state[b + size] as number) + (state[p + size] as number) + 2 * STRIKE.around;
    return near(BODY.x, BODY.vx, BODY.w) && near(BODY.z, BODY.vz, BODY.d);
  }
  const dz = along(b, BODY.z, BODY.vz) - along(p, BODY.z, BODY.vz);
  if (dz < -STRIKE.back || dz > STRIKE.reach) return false;
  const dx = Math.abs(along(b, BODY.x, BODY.vx) - along(p, BODY.x, BODY.vx));
  if (dx * 2 >= (state[b + BODY.w] as number) + (state[p + BODY.w] as number) + 2 * STRIKE.wide) return false;
  const py = state[p + BODY.y] as number;
  const by = state[b + BODY.y] as number;
  return by < py + (state[p + BODY.h] as number) + STRIKE.wide && py < by + (state[b + BODY.h] as number) + STRIKE.wide;
}

/**
 * Je tělo `other` v dosahu úderu v některém tiku `from..to` (robot)? Rozestupy jsou v t lineární:
 * tělo mimo dosah na obou krajích okna ze stejné strany se dosahu nedotkne ani mezi nimi, a to
 * se pozná bez smyčky (R5: krádež se ptá u každé mrkve na trati v každém tiku).
 */
export function inStrikeReachWithin(state: Int32Array, player: number, other: number, from: number, to: number, around = false): boolean {
  const p = bodyBase(player);
  const b = bodyBase(other);
  const ends = (axis: number, speed: number): [number, number] => {
    const gap = (state[b + axis] as number) - (state[p + axis] as number);
    const drift = (state[b + speed] as number) - (state[p + speed] as number);
    return [gap + drift * from, gap + drift * to];
  };
  /** Nejmenší |rozestup| v okně: nula, když mezi kraji mění znaménko. */
  const least = ([near, far]: [number, number]): number => (Math.sign(near) !== Math.sign(far) ? 0 : Math.min(Math.abs(near), Math.abs(far)));
  const sizes = (size: number): number => (state[b + size] as number) + (state[p + size] as number);
  if (around) {
    if (least(ends(BODY.x, BODY.vx)) * 2 >= sizes(BODY.w) + 2 * STRIKE.around || least(ends(BODY.z, BODY.vz)) * 2 >= sizes(BODY.d) + 2 * STRIKE.around) return false;
  } else {
    const [near, far] = ends(BODY.z, BODY.vz);
    if (Math.max(near, far) < -STRIKE.back || Math.min(near, far) > STRIKE.reach) return false;
    if (least(ends(BODY.x, BODY.vx)) * 2 >= sizes(BODY.w) + 2 * STRIKE.wide) return false;
  }
  for (let t = from; t <= to; t += 1) if (inStrikeReach(state, player, other, t, around)) return true;
  return false;
}

export const strikeRule: RulePiece<z.infer<typeof strikeParams>> = {
  id: 'ability_strike',
  params: strikeParams,
  roles: ['player', 'enemy'],
  trigger: 'tick',
  cost: () => ({ bodies: 0, rules: 1 }),
  fire: ({ state, player }, params) => {
    const active = abilityActive(state, params.keeper, params.slot);
    if (active === 0) return [];
    // Boss nezmizí naráz: jeden úder = jeden život, počítá se jen první tik okna (P46B T8).
    const boss = active === ABILITY_TIMING.strike.active ? params.boss : undefined;
    const effects: ArcadeEffect[] = [];
    // Jeden násobič na tik: všechny zásahy téhož úderu berou stejný, série roste o úder.
    const multiplier = params.combo === undefined ? 1 : nextMultiplier(state, params.combo);
    for (let i = 0; i < (state[HEADER.bodyCount] as number); i += 1) {
      const b = bodyBase(i);
      if (i === player || ((state[b + BODY.flags] as number) & FLAG.alive) === 0) continue;
      const struck = isStruck(state[b + BODY.role] as number);
      if (!struck && (boss === undefined || bodyHp(state, i) === 0 || !matches(state, i, boss.boss))) continue;
      if (!inStrikeReach(state, player, i, 0, params.around)) continue;
      if (struck) effects.push({ kind: 'score', amount: multiplier }, { kind: 'despawn', body: i });
      else if (boss !== undefined) effects.push(...blow(state, i, player, boss));
    }
    if (params.combo !== undefined && effects.some((effect) => effect.kind === 'despawn')) effects.push({ kind: 'combo', body: params.combo, multiplier });
    return effects;
  },
};
