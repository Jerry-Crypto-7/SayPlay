/**
 * Robot poletování (P25C, T4). Svět vidí 8 tiků starý, vlastní let si
 * dopočítá z toho, co od té doby ťukl (ví, kdy mávl). Míří na střed další
 * mezery: ťukne, když je pod ním a padá. Trubky čte z geometrie (role
 * `obstacle`, spodní a horní díl se stejným `z`).
 */

import { z } from 'zod';

import { type ArcadeInput, BODY, BUTTON, type BotPiece, FLAG, HEADER, NO_INPUT, ROLE, bodyBase, rampedSpeed } from '../contract';
import { GRAVITY } from '../kernel';
import { FLAP, FLAP_RISE, flapRampParams } from './flap';

/** Ťuk, když je hráč (odhad) aspoň tolik pod středem mezery. */
const BELOW = 250;

const S = BODY;

interface Gap {
  z: number;
  bottom: number;
  top: number;
}

/** Dvě nejbližší mezery před hráčem: trubky seskupené podle `z`. */
function gapsAhead(state: Int32Array, player: number, pz: number): Gap[] {
  const count = state[HEADER.bodyCount] as number;
  const byZ = new Map<number, Gap>();
  for (let i = 0; i < count; i += 1) {
    if (i === player) continue;
    const base = bodyBase(i);
    if (((state[base + S.flags] as number) & FLAG.alive) === 0 || state[base + S.role] !== ROLE.obstacle) continue;
    const z0 = state[base + S.z] as number;
    // Minutá trubka: zadní hrana za hráčem.
    if (z0 + ((state[base + S.d] as number) + FLAP.size) / 2 <= pz) continue;
    const gap = byZ.get(z0) ?? { z: z0, bottom: 0, top: FLAP.ceiling };
    byZ.set(z0, gap);
    const y = state[base + S.y] as number;
    if (y === 0) gap.bottom = Math.max(gap.bottom, state[base + S.h] as number);
    else gap.top = Math.min(gap.top, y);
  }
  return [...byZ.values()].sort((a, b) => a.z - b.z).slice(0, 2);
}

const middle = (gap: Gap): number => Math.floor((gap.bottom + gap.top - FLAP.size) / 2);

/**
 * Cíl výšky: střed mezery za tou nejbližší, sevřený do pásma, ve kterém
 * nejbližší mezeru ještě bezpečně proletí. Dole: pod cíl − BELOW hráč
 * neklesne. Nahoře: ťuk přijde nejvýš o jeden tik pádu nad prahem a vrchol
 * vzletu (FLAP_RISE nad místem ťuku) nesmí narazit do horní trubky. Bez výhledu o mezeru dál
 * robot visí ve středu minuté mezery a na výrazně nižší další nestihne
 * klesnout (hard/3: o 1,2 m níž na 4,2 m).
 */
function targetOf(gaps: readonly Gap[]): number {
  const [near, far] = gaps;
  if (near === undefined) return FLAP.startY;
  const low = near.bottom + BELOW + 50;
  const high = near.top - FLAP.size - FLAP_RISE + BELOW - FLAP.flapVy - 50;
  if (low > high) return middle(near);
  return Math.max(low, Math.min(high, middle(far ?? near)));
}

export const flapBot: BotPiece<z.infer<typeof flapRampParams>> = {
  id: 'flap_bot',
  params: flapRampParams,
  roles: ['player', 'obstacle'],
  reactionTicks: 8,
  cost: () => ({ bodies: 0, rules: 0 }),
  decide: ({ state, player, recent }, params): ArcadeInput => {
    const p = bodyBase(player);
    // Vlastní let „teď“: viděný stav + ťuky, které v něm ještě nejsou.
    let y = state[p + S.y] as number;
    let vy = state[p + S.vy] as number;
    for (const input of recent) {
      if ((input.buttons & BUTTON.TAP) !== 0) vy = FLAP.flapVy;
      vy -= GRAVITY;
      y += vy;
    }
    const z0 = state[p + S.z] as number;
    const pz = z0 + rampedSpeed(FLAP.speed, z0, params.ramp) * recent.length;
    // Za poslední trubkou drž výšku startu.
    const target = targetOf(gapsAhead(state, player, pz));
    // Ťuk o tik dřív, než by klesl pod práh: po dlouhém pádu jinak přestřelí.
    return y + vy - GRAVITY < target - BELOW && vy <= 0 ?{ buttons: BUTTON.TAP, axis: 0 } : NO_INPUT;
  },
};
