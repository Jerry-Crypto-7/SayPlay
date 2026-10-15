/**
 * Robot arény (P25F, T5) – věrohodný hráč pro ověření volného pohybu.
 *
 * Svět vidí 8 tiků starý (`reactionTicks`); vlastní polohu si dopočítá z toho,
 * co od té doby zmáčkl, buňky posune o jejich rychlost. Když je větší buňka
 * blízko, utíká od ní (a od stěny, aby se nenechal zahnat do rohu); jinak
 * míří na nejbližší menší tělo, které neleží u větší buňky.
 */

import { z } from 'zod';

import { type ArcadeInput, BODY, type BotPiece, FLAG, HEADER, ROLE, UNIT, bodyBase } from '../contract';
import { ARENA, DIRECTIONS, arenaAxis, axisOfDirection, chaseParams, chaseSpeedOf, directionOfAxis, directionToward, graceLeft } from './arena';

const REACTION = 8;
/** Větší buňka blíž (okraj k okraji) než tohle = utíkat. */
const DANGER = 5 * UNIT;
/** Potrava blíž než tohle k větší buňce se nehoní. */
const RISKY = 4 * UNIT;
/** Od stěny se odpuzuje v tomhle pásu. */
const WALL_BAND = 4 * UNIT;

const toward = (value: number, target: number, step: number): number => (value < target ? Math.min(target, value + step) : Math.max(target, value - step));

/** Poloha a rychlost „teď“: viděný stav + vstupy, které v něm ještě nejsou (jako ovládání, bez stěn a kolizí). */
export function predict(state: Int32Array, player: number, recent: readonly ArcadeInput[]): { x: number; z: number; vx: number; vz: number } {
  const p = bodyBase(player);
  let x = state[p + BODY.x] as number;
  let z = state[p + BODY.z] as number;
  let vx = state[p + BODY.vx] as number;
  let vz = state[p + BODY.vz] as number;
  for (const input of recent) {
    const direction = directionOfAxis(input.axis);
    const dir = direction < 0 ? null : DIRECTIONS[direction]!;
    const rate = dir === null ? ARENA.friction : ARENA.accel;
    vx = toward(vx, dir === null ? 0 : Math.trunc((dir.dx * ARENA.speed) / 1000), rate);
    vz = toward(vz, dir === null ? 0 : Math.trunc((dir.dz * ARENA.speed) / 1000), rate);
    x += vx;
    z += vz;
  }
  return { x, z, vx, vz };
}

const botParams = z
  .object({
    half: z.int().min(5 * UNIT).max(40 * UNIT).default(ARENA.half),
    /** Útěk (P32E T1): pronásledovatelé téhle rychlosti – robot plánuje únik místo agaru. */
    chase: chaseParams.optional(),
  })
  .strict();

/** Plánovač útěku: tolik tiků dopředu po krocích `sample`; bezpečný tah drží aspoň `safe` mezeru, nad `cap` je mezera jedno. */
const PLAN = { horizon: 90, sample: 5, safe: 2500, cap: 8 * UNIT } as const;

/**
 * Útěk: 32 směrů a stání, každý tah přehraný `horizon` tiků proti
 * pronásledovatelům, kteří jdou rovnou na hráče (po ochraně, kterou ještě
 * prospí). Nejbližší věc, ke které vede bezpečný tah; jinak tah s největší
 * mezerou, a když je všude dost místa, ten, který končí blíž středu.
 *
 * Robot plánuje každý tik, takže přehrávka končí, jakmile tah nemůže vyhrát
 * (mezera pod laťkou) – volba je až na remízy stejná jako při plném přehrání všech 33 tahů.
 */
function escapeDecide(state: Int32Array, player: number, recent: readonly ArcadeInput[], half: number, speed: number): ArcadeInput {
  const me = predict(state, player, recent);
  const size = state[bodyBase(player) + BODY.w] as number;
  const lag = recent.length;
  const asleep = Math.max(0, graceLeft(state) - lag);
  const chasers: { x: number; z: number; reach: number }[] = [];
  // Power-upy (P46C) útěk nevidí, sebere je jen v cestě: každá zacházka k nim prohrála hry, které
  // stará verze vyhrála (arena.escape i s mincemi, hra s logikou z režiséra na semínku 1).
  const items: { x: number; z: number }[] = [];
  for (let i = 0; i < (state[HEADER.bodyCount] as number); i += 1) {
    const base = bodyBase(i);
    if (i === player || ((state[base + BODY.flags] as number) & FLAG.alive) === 0) continue;
    const role = state[base + BODY.role];
    if (role === ROLE.chaser) chasers.push({ x: (state[base + BODY.x] as number) + (state[base + BODY.vx] as number) * lag, z: (state[base + BODY.z] as number) + (state[base + BODY.vz] as number) * lag, reach: ((state[base + BODY.w] as number) + size) / 2 });
    else if (role === ROLE.collectible) items.push({ x: state[base + BODY.x] as number, z: state[base + BODY.z] as number });
  }
  const limit = half - Math.ceil(size / 2);
  const clamp = (value: number): number => Math.max(-limit, Math.min(limit, value));

  const steps = PLAN.horizon / PLAN.sample;
  const stride = (direction: number): { readonly x: number; readonly z: number } => {
    const dir = direction < 0 ? { dx: 0, dz: 0 } : DIRECTIONS[direction]!;
    return { x: Math.trunc((dir.dx * ARENA.speed * PLAN.sample) / 1000), z: Math.trunc((dir.dz * ARENA.speed * PLAN.sample) / 1000) };
  };

  /** Nejmenší mezera (okraj k okraji, po osách jako AABB jádra) k pronásledovateli v horizontu; přehrávka končí, jakmile klesne na `floor`. */
  const clearance = (direction: number, floor: number): number => {
    const step = stride(direction);
    const at = chasers.map((c) => ({ x: c.x, z: c.z }));
    let px = me.x;
    let pz = me.z;
    let clear = Number.POSITIVE_INFINITY;
    for (let t = PLAN.sample; t <= PLAN.horizon; t += PLAN.sample) {
      px = clamp(px + step.x);
      pz = clamp(pz + step.z);
      const moving = Math.max(0, Math.min(PLAN.sample, t - asleep));
      for (let j = 0; j < at.length; j += 1) {
        const c = at[j]!;
        const dx = px - c.x;
        const dz = pz - c.z;
        // `Math.sqrt`, ne `Math.hypot`: robot plánuje každý tik a hypot je ve V8 řádově pomalejší.
        const gap = Math.sqrt(dx * dx + dz * dz);
        const run = Math.min(gap, moving * speed);
        if (gap > 0) {
          c.x += (dx * run) / gap;
          c.z += (dz * run) / gap;
        }
        clear = Math.min(clear, Math.max(Math.abs(px - c.x), Math.abs(pz - c.z)) - chasers[j]!.reach);
      }
      if (clear <= floor) return clear;
    }
    return clear;
  };

  const byDistance = [...items].sort((a, b) => (a.x - me.x) ** 2 + (a.z - me.z) ** 2 - ((b.x - me.x) ** 2 + (b.z - me.z) ** 2));
  const tried = new Set<number>();
  for (const item of byDistance) {
    const direction = directionToward(item.x - me.x, item.z - me.z);
    if (direction < 0 || tried.has(direction)) continue;
    tried.add(direction);
    if (clearance(direction, PLAN.safe - 1) >= PLAN.safe) return { buttons: 0, axis: axisOfDirection(direction) };
  }

  // Tahy od konce nejblíž středu: první, který drží `cap`, vyhrál; jinak největší mezera.
  // Laťku napřed nastaví útěk přímo od nejbližšího pronásledovatele, ať se slabé tahy utnou brzy.
  const center = (direction: number): number => {
    const step = stride(direction);
    return Math.hypot(clamp(me.x + step.x * steps), clamp(me.z + step.z * steps));
  };
  const order = Array.from({ length: 33 }, (_, k) => ({ direction: k - 1, center: center(k - 1) })).sort((a, b) => a.center - b.center);
  const nearest = chasers.reduce<(typeof chasers)[number] | null>((found, c) => (found === null || (c.x - me.x) ** 2 + (c.z - me.z) ** 2 < (found.x - me.x) ** 2 + (found.z - me.z) ** 2 ? c : found), null);
  let best = nearest === null ? order[0]!.direction : directionToward(me.x - nearest.x, me.z - nearest.z);
  let bestClear = nearest === null ? Number.NEGATIVE_INFINITY : Math.min(clearance(best, Number.NEGATIVE_INFINITY), PLAN.cap - 1);
  for (const { direction } of order) {
    const clear = clearance(direction, bestClear);
    if (clear >= PLAN.cap) return { buttons: 0, axis: axisOfDirection(direction) };
    if (clear > bestClear) {
      best = direction;
      bestClear = clear;
    }
  }
  return { buttons: 0, axis: axisOfDirection(best) };
}

export const arenaBot: BotPiece<z.infer<typeof botParams>> = {
  id: 'arena_bot',
  params: botParams,
  roles: ['player', 'enemy', 'collectible'],
  reactionTicks: REACTION,
  cost: () => ({ bodies: 0, rules: 0 }),
  decide: ({ state, player, recent }, params): ArcadeInput => {
    // Ve vlnách (P36A T4) plánuje proti rychlosti vlny, kterou vidí.
    if (params.chase !== undefined) return escapeDecide(state, player, recent, params.half, chaseSpeedOf(params.chase, state));
    const me = predict(state, player, recent);
    const size = state[bodyBase(player) + BODY.w] as number;
    const count = state[HEADER.bodyCount] as number;
    const lag = recent.length;
    const threats: { x: number; z: number; w: number }[] = [];
    const food: { x: number; z: number }[] = [];
    for (let i = 0; i < count; i += 1) {
      if (i === player) continue;
      const base = bodyBase(i);
      if (((state[base + BODY.flags] as number) & FLAG.alive) === 0) continue;
      const role = state[base + BODY.role];
      if (role !== ROLE.enemy && role !== ROLE.collectible && role !== ROLE.chaser && role !== ROLE.powerup) continue;
      const w = state[base + BODY.w] as number;
      const at = { x: (state[base + BODY.x] as number) + (state[base + BODY.vx] as number) * lag, z: (state[base + BODY.z] as number) + (state[base + BODY.vz] as number) * lag, w };
      // Pronásledovatel doplňku `+chaser` (P26D) se sníst nedá, ať je hráč jakkoli velký.
      if ((w > size && role === ROLE.enemy) || role === ROLE.chaser) threats.push(at);
      // Power-up (P46C) se sebere při každé velikosti.
      else if (w < size || role === ROLE.powerup) food.push(at);
    }

    // Útěk: součet vektorů od blízkých větších buněk, vážený blízkostí, + odpor stěn.
    let fx = 0;
    let fz = 0;
    for (const t of threats) {
      const dx = me.x - t.x;
      const dz = me.z - t.z;
      const gap = Math.hypot(dx, dz) - (t.w + size) / 2;
      if (gap >= DANGER) continue;
      const weight = (DANGER - gap) / Math.max(1, Math.hypot(dx, dz));
      fx += dx * weight;
      fz += dz * weight;
    }
    if (fx !== 0 || fz !== 0) {
      const push = Math.hypot(fx, fz);
      const limit = params.half - size / 2;
      if (me.x > limit - WALL_BAND) fx -= push * ((me.x - (limit - WALL_BAND)) / WALL_BAND) * 2;
      if (me.x < -limit + WALL_BAND) fx += push * ((-limit + WALL_BAND - me.x) / WALL_BAND) * 2;
      if (me.z > limit - WALL_BAND) fz -= push * ((me.z - (limit - WALL_BAND)) / WALL_BAND) * 2;
      if (me.z < -limit + WALL_BAND) fz += push * ((-limit + WALL_BAND - me.z) / WALL_BAND) * 2;
      return { buttons: 0, axis: arenaAxis(Math.round(fx), Math.round(fz)) || arenaAxis(-me.x, -me.z) };
    }

    // Lov: nejbližší menší tělo, které neleží u větší buňky.
    let best: { x: number; z: number } | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const f of food) {
      if (threats.some((t) => Math.hypot(f.x - t.x, f.z - t.z) - t.w / 2 < RISKY)) continue;
      const d = Math.hypot(f.x - me.x, f.z - me.z);
      if (d < bestDistance) {
        bestDistance = d;
        best = f;
      }
    }
    if (best === null) return { buttons: 0, axis: arenaAxis(-me.x, -me.z) };
    return { buttons: 0, axis: arenaAxis(best.x - me.x, best.z - me.z) };
  },
};
