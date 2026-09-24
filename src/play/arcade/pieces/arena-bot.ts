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
import { ARENA, DIRECTIONS, arenaAxis, directionOfAxis } from './arena';

const REACTION = 8;
/** Větší buňka blíž (okraj k okraji) než tohle = utíkat. */
const DANGER = 5 * UNIT;
/** Potrava blíž než tohle k větší buňce se nehoní. */
const RISKY = 4 * UNIT;
/** Od stěny se odpuzuje v tomhle pásu. */
const WALL_BAND = 4 * UNIT;

const toward = (value: number, target: number, step: number): number => (value < target ? Math.min(target, value + step) : Math.max(target, value - step));

/** Poloha „teď“: viděný stav + vstupy, které v něm ještě nejsou (jako ovládání, bez stěn a kolizí). */
function predict(state: Int32Array, player: number, recent: readonly ArcadeInput[]): { x: number; z: number } {
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
  return { x, z };
}

const botParams = z.object({ half: z.int().min(5 * UNIT).max(40 * UNIT).default(ARENA.half) }).strict();

export const arenaBot: BotPiece<z.infer<typeof botParams>> = {
  id: 'arena_bot',
  params: botParams,
  roles: ['player', 'enemy', 'collectible'],
  reactionTicks: REACTION,
  cost: () => ({ bodies: 0, rules: 0 }),
  decide: ({ state, player, recent }, params): ArcadeInput => {
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
      if (role !== ROLE.enemy && role !== ROLE.collectible && role !== ROLE.chaser) continue;
      const w = state[base + BODY.w] as number;
      const at = { x: (state[base + BODY.x] as number) + (state[base + BODY.vx] as number) * lag, z: (state[base + BODY.z] as number) + (state[base + BODY.vz] as number) * lag, w };
      // Pronásledovatel doplňku `+chaser` (P26D) se sníst nedá, ať je hráč jakkoli velký.
      if ((w > size && role === ROLE.enemy) || role === ROLE.chaser) threats.push(at);
      else if (w < size) food.push(at);
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
