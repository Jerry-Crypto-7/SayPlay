/**
 * Magnet (P46C): sbírané věci v okruhu letí k hrdinovi. Píše ho obal ovládání
 * (`tickPowerup`), protože jen ovládání smí sahat do stavu přímo; věc sebere až
 * dotek (`pickup`), stejně jako bez magnetu.
 */

import { BODY, FLAG, HEADER, ROLE, UNIT, bodyBase } from '../contract';

/** Okruh a krok přitažení za tik na každé ose (rychlejší než běžec, ať ho věc dožene). */
export const MAGNET = { radius: 4 * UNIT, pull: 300 } as const;

const clamp = (value: number, limit: number): number => Math.max(-limit, Math.min(limit, value));

/** Živé sbírané věci do `MAGNET.radius` od hrdiny posune o krok k němu. Fyzikální tělesa drží Rapier, ty nechá. */
export function pullItems(state: Int32Array, player: number): void {
  const p = bodyBase(player);
  const count = state[HEADER.bodyCount] as number;
  for (let i = 0; i < count; i += 1) {
    const b = bodyBase(i);
    const flags = state[b + BODY.flags] as number;
    if (state[b + BODY.role] !== ROLE.collectible || (flags & FLAG.alive) === 0 || (flags & FLAG.physics) !== 0) continue;
    const dx = (state[p + BODY.x] as number) - (state[b + BODY.x] as number);
    const dy = (state[p + BODY.y] as number) - (state[b + BODY.y] as number);
    const dz = (state[p + BODY.z] as number) - (state[b + BODY.z] as number);
    if (dx * dx + dy * dy + dz * dz > MAGNET.radius * MAGNET.radius) continue;
    state[b + BODY.x] = (state[b + BODY.x] as number) + clamp(dx, MAGNET.pull);
    state[b + BODY.y] = (state[b + BODY.y] as number) + clamp(dy, MAGNET.pull);
    state[b + BODY.z] = (state[b + BODY.z] as number) + clamp(dz, MAGNET.pull);
  }
}
