/**
 * Vzácnost sebrané věci (P66 T3, kontrakt `hooks/contract.ts`): běžná / vzácná / epická, váhy 70 / 25 / 5,
 * skóre ×1 / ×3 / ×10.
 *
 * **Vzácnost dostane věc při vzniku, ne při sebrání.** Losy jsou hotové při stavbě (`drawRarities`, stream
 * `rarity`) a nese je pravidlo `hooks`; k-tá věc, která ve hře vznikne (tělo úrovně v tiku 0, kopie ze `spawn`,
 * přepnutím objevená věc), dostane k-tý los na konci tiku, kdy vznikla. Sebrat ji jde nejdřív v dalším tiku
 * (kontakty jsou před efekty tiku), takže pořadí sebrání vzácnost nezmění.
 *
 * **Kde ji věc nese:** v bitech odrazu `flags` (`RESTITUTION_SHIFT`), které nefyzikální těleso nikdy nepoužije –
 * stejně jako milost hráče (`GRACE_SHIFT`). Kód 0 = ještě nelosovaná, 1–3 = `RARITY` + 1. Fyzikální věc nese
 * v těch bitech odraz, vzácnost nedostane. Bity stavu cíle to být nemůžou: chytání v nich nese propadlé ovoce.
 *
 * **Sebrání** pozná jádro podle dvojice efektů, kterou vydává každé pravidlo sběru (`pickup`, `arena_eat`): kladné
 * `score` a hned za ním `despawn` sbírané věci. Body té dvojice se vynásobí, nález se připíše do počítadla háčků.
 */

import { createStreams, nextInt } from '@/sim/rng';

import { type ArcadeEffect, BODY, FLAG, HEADER, RESTITUTION_SHIFT, ROLE, bodyBase } from '../contract';
import { FOUND_BITS, HOOK_SLOTS, RARITY, RARITY_SCORE, RARITY_WEIGHTS, type Rarity } from './contract';

/**
 * Losů na jednu hru. simplified: k-tá věc nad tolik dostane los `k mod RARITY_DRAWS` (sběr arény ~40 věcí za hru);
 * zvednout, až žánr postaví hru s víc věcmi.
 */
export const RARITY_DRAWS = 128;

/** Slot počítadla háčků: kolik losů vzácnosti už věci dostaly (mimo sloty kontraktu `HOOK_SLOTS`). */
export const RARITY_SLOTS = { drawn: BODY.aux0 } as const;

const MASK = 0x3;
const FOUND_MASK = (1 << FOUND_BITS) - 1;

/** Losy vzácnosti hry `seed` jako řetězec číslic `RARITY` (0 = běžná), ze streamu `rarity`. */
export function drawRarities(seed: number): string {
  const stream = createStreams(seed).rarity;
  let draws = '';
  for (let k = 0; k < RARITY_DRAWS; k += 1) {
    const roll = nextInt(stream, 0, 99);
    draws += roll < RARITY_WEIGHTS.common ? '0' : roll < RARITY_WEIGHTS.common + RARITY_WEIGHTS.rare ? '1' : '2';
  }
  return draws;
}

const codeOf = (state: Int32Array, body: number): number => ((state[bodyBase(body) + BODY.flags] as number) >> RESTITUTION_SHIFT) & MASK;

/** Vzácnost věci `body`, nebo `undefined` (není to nefyzikální sbíraná věc, nebo ještě nedostala los). */
export function rarityOf(state: Int32Array, body: number): Rarity | undefined {
  const base = bodyBase(body);
  if (state[base + BODY.role] !== ROLE.collectible || ((state[base + BODY.flags] as number) & FLAG.physics) !== 0) return undefined;
  const code = codeOf(state, body);
  return code === 0 ? undefined : RARITY[code - 1];
}

/** Živé sbírané věci bez losu dostanou další losy v pořadí indexu (konec tiku, kdy vznikly). */
export function assignRarities(state: Int32Array, keeper: number, draws: string): void {
  const drawn = bodyBase(keeper) + RARITY_SLOTS.drawn;
  for (let i = 0; i < (state[HEADER.bodyCount] as number); i += 1) {
    const base = bodyBase(i);
    const flags = state[base + BODY.flags] as number;
    if (state[base + BODY.role] !== ROLE.collectible || (flags & (FLAG.alive | FLAG.physics)) !== FLAG.alive || codeOf(state, i) !== 0) continue;
    const k = state[drawn] as number;
    state[base + BODY.flags] = flags | ((Number(draws[k % draws.length]) + 1) << RESTITUTION_SHIFT);
    state[drawn] = k + 1;
  }
}

/** Sebraná věc dvojice efektů od `i` (kladné `score`, hned `despawn` sbírané věci s losem), nebo `undefined`. */
export function collectedAt(state: Int32Array, effects: readonly ArcadeEffect[], i: number): { readonly body: number; readonly rarity: Rarity } | undefined {
  const score = effects[i];
  const next = effects[i + 1];
  if (score?.kind !== 'score' || score.amount <= 0 || next?.kind !== 'despawn') return undefined;
  if (next.body < 0 || next.body >= (state[HEADER.bodyCount] as number)) return undefined;
  const rarity = rarityOf(state, next.body);
  return rarity === undefined ? undefined : { body: next.body, rarity };
}

/** Body navíc za sebranou věc vzácnosti `rarity` k už připsaným `amount` (násobič `RARITY_SCORE`). */
export const rarityBonus = (amount: number, rarity: Rarity): number => amount * (RARITY_SCORE[rarity] - 1);

/** Nalezené věci podle vzácnosti v počítadle háčků – pro výsledek hry. */
export function foundOf(state: Int32Array, keeper: number): Readonly<Record<Rarity, number>> {
  const packed = state[bodyBase(keeper) + HOOK_SLOTS.found] as number;
  return { common: packed & FOUND_MASK, rare: (packed >>> FOUND_BITS) & FOUND_MASK, epic: (packed >>> (2 * FOUND_BITS)) & FOUND_MASK };
}

/** Připíše nález vzácnosti `rarity`; počet se zastaví na stropu bitů (1023). */
export function addFound(state: Int32Array, keeper: number, rarity: Rarity): void {
  const at = bodyBase(keeper) + HOOK_SLOTS.found;
  const shift = RARITY.indexOf(rarity) * FOUND_BITS;
  if ((((state[at] as number) >>> shift) & FOUND_MASK) < FOUND_MASK) state[at] = (state[at] as number) + (1 << shift);
}
