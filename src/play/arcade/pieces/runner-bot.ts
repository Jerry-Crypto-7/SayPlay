/**
 * Robot běžce (P25A, T4) – věrohodný hráč pro ověření hratelnosti.
 *
 * Vidí stav 8 tiků starý (`reactionTicks`) a neextrapoluje ho: skáče a
 * uhýbá podle toho, co viděl, tedy o 8 tiků pozdě, stejně jako člověk.
 * Překážky čte z geometrie, ne z názvu modelu: plovoucí nad výškou skluzu =
 * podklouznout, nižší než vrchol skoku = přeskočit, jinak jen jiným pruhem.
 */

import { z } from 'zod';

import { type ArcadeInput, BODY, BUTTON, type BotPiece, FLAG, HEADER, NO_INPUT, ROLE, UNIT, bodyBase } from '../contract';
import { JUMP_PEAK, RUNNER } from './runner';

/** Skok, když je překážka podle zastaralého pohledu 24 tiků daleko – skutečně ~16, uprostřed okna. */
export const JUMP_AT_TICKS = 24;
export const SLIDE_AT_TICKS = 22;
/** Rezerva nad překážkou, kterou robot ještě považuje za přeskočitelnou. */
const JUMP_MARGIN = 200;
/** Překážky do 1 m od sebe v ose z jsou jedna řada. */
export const ROW_SPAN = 1000;

type LaneStatus = 0 | 1 | 2;
const FREE: LaneStatus = 0;
const ACTION: LaneStatus = 1;
const BLOCKED: LaneStatus = 2;

// Místní kopie importů – robot běží každý tik ověření (viz `kernel.ts`).
const S = BODY;
const F = FLAG;
const HD = HEADER;
const RL = ROLE;
const RN = RUNNER;
const PEAK = JUMP_PEAK;
const baseOf = bodyBase;

const read = (state: Int32Array, base: number, slot: keyof typeof BODY): number => state[base + S[slot]] as number;

/** Jak robot překážku mine z geometrie: plovoucí nad výškou skluzu podklouzne, dost nízkou přeskočí, jinak jen jiným pruhem (`null`). */
export const obstacleAction = (y: number, top: number): 'jump' | 'slide' | null => (y >= RN.slideH ? 'slide' : top + JUMP_MARGIN <= PEAK ? 'jump' : null);

export interface Row {
  readonly z: number;
  /** Stav pruhu −1, 0, 1 a akce, kterou pruh žádá. */
  readonly lanes: readonly { readonly status: LaneStatus; readonly action: 'jump' | 'slide' | null }[];
}

/** Nejbližší řada překážek, kterou hráč podle pohledu ještě neminul. */
export function nextRow(state: Int32Array, player: number): Row | null {
  const p = baseOf(player);
  const pz = read(state, p, 'z');
  const count = state[HD.bodyCount] as number;
  let rowZ = Number.POSITIVE_INFINITY;
  for (let i = 0; i < count; i += 1) {
    const base = baseOf(i);
    if (i === player || read(state, base, 'role') !== RL.obstacle || (read(state, base, 'flags') & F.alive) === 0) continue;
    const z = read(state, base, 'z');
    if (z + (read(state, base, 'd') + RN.playerD) / 2 > pz) rowZ = Math.min(rowZ, z);
  }
  if (rowZ === Number.POSITIVE_INFINITY) return null;

  const lanes = [-1, 0, 1].map(() => ({ status: FREE, action: null as 'jump' | 'slide' | null }));
  for (let i = 0; i < count; i += 1) {
    const base = baseOf(i);
    if (i === player || read(state, base, 'role') !== RL.obstacle || (read(state, base, 'flags') & F.alive) === 0) continue;
    if (Math.abs(read(state, base, 'z') - rowZ) > ROW_SPAN) continue;
    const y = read(state, base, 'y');
    const action = obstacleAction(y, y + read(state, base, 'h'));
    lanes.forEach((lane, index) => {
      const laneX = (index - 1) * RN.laneWidth;
      if (Math.abs(read(state, base, 'x') - laneX) * 2 >= read(state, base, 'w') + RN.playerW) return;
      if (action === null || (lane.action !== null && lane.action !== action)) {
        lane.status = BLOCKED;
        lane.action = null;
      } else if (lane.status === FREE) {
        lane.status = ACTION;
        lane.action = action;
      }
    });
  }
  return { z: rowZ, lanes };
}

/** Tiků na přejezd o jeden pruh. */
const LANE_TICKS = Math.ceil(RN.laneWidth / RN.laneSpeed);
/** Tiků rezervy mezi návratem z pruhu s mincí a přední hranou řady (u pruhu se skokem či skluzem `JUMP_AT_TICKS`). */
const COIN_SPARE = 8;

/** Tělo napříč a podél (střed, celé rozměry). */
export interface Footprint {
  readonly x: number;
  readonly z: number;
  readonly w: number;
  readonly d: number;
}

/**
 * Těla, která zraní: nepřítel a hrozba. Střely ne – vlastní od cizích robot nerozliší. Pronásledovatel ne: protijedoucí
 * se stáčí za hráčem a uhnutí mu načasuje doplněk (`chaseStep` v `addons.ts`) – vyhýbat se jeho pruhu předem srazilo
 * útěk `run.escape` (intermediate 0,95 → 0,7 na 20 semínkách).
 */
export const HOSTILE: readonly number[] = [RL.enemy, RL.hazard];

/** Živá těla rolí `roles`. */
export function footprintsOf(state: Int32Array, roles: readonly number[]): Footprint[] {
  const found: Footprint[] = [];
  for (let i = 0; i < (state[HD.bodyCount] as number); i += 1) {
    const base = baseOf(i);
    if (!roles.includes(read(state, base, 'role')) || (read(state, base, 'flags') & F.alive) === 0) continue;
    found.push({ x: read(state, base, 'x'), z: read(state, base, 'z'), w: read(state, base, 'w'), d: read(state, base, 'd') });
  }
  return found;
}

/** Pruhy −1, 0, 1, které tělo napříč zasahuje, pokud ho hráč v `pz` ještě neminul a leží před řadou `rowZ`. */
function lanesAhead(body: Footprint, pz: number, rowZ: number): number[] {
  if (body.z + (body.d + RN.playerD) / 2 <= pz || body.z >= rowZ) return [];
  return [-1, 0, 1].filter((lane) => Math.abs(body.x - lane * RN.laneWidth) * 2 < body.w + RN.playerW);
}

/**
 * Poslední věc ke sběru v pruhu −1, 0, 1 (`z`, nebo `null`), kterou hráč v `pz` ještě neminul a která leží před
 * řadou `rowZ`: mince běžce leží uprostřed mezery mezi řadami (`runner.ts`), často v pruhu, který řada zavře.
 */
export function lastCoins(coins: readonly Footprint[], pz: number, rowZ: number): (number | null)[] {
  const last: (number | null)[] = [null, null, null];
  for (const coin of coins) for (const lane of lanesAhead(coin, pz, rowZ)) last[lane + 1] = Math.max(last[lane + 1] ?? coin.z, coin.z);
  return last;
}

/**
 * Pruhy (bit `pruh + 1`) s tělem, které zraní (`HOSTILE`), od hráče v `pz` do řady `rowZ`. Nepřítele doplňku
 * (`+shoot`, `shoot_at`) robot běžce nevidí – ve svém pruhu ho sestřelí, ale do jeho pruhu za mincí by vjel bokem
 * (změřeno: golden `runner.default` se střelbou na semínku 1 prohrál).
 */
export function hostileLanes(hostile: readonly Footprint[], pz: number, rowZ: number): number {
  let lanes = 0;
  for (const body of hostile) for (const lane of lanesAhead(body, pz, rowZ)) lanes |= 1 << (lane + 1);
  return lanes;
}

/**
 * Pruh, kam robot běžce z pruhu `lane` míří (sdílí ho plánovač pruhů, `lanes.ts`): nejprůchodnější pruh řady
 * (`status` po pruzích −1, 0, 1: volno < skok či skluz < zavřeno) nejblíž `lane`. Před ním – nejbližší první – pruh
 * s věcí ke sběru před řadou (`last`, P46B R1), když k poslední dojede a z jejího pruhu se do nejlepšího pruhu řady
 * ještě stihne vrátit: `lag` tiků zastaralého pohledu, přejezd a rezerva (u pruhu se skokem či skluzem okno akce)
 * před přední hranou řady `rowZ`. `pz`, `vz` = hráč podle pohledu. Přes pruhy v `avoid` (bit `pruh + 1`) za mincí nejede.
 */
export function laneChoice(status: readonly number[], lane: number, rowZ: number, pz: number, vz: number, lag: number, last: readonly (number | null)[], avoid = 0): number {
  const rank = (l: number): number => status[l + 1] as number;
  const hostile = (l: number): number => (avoid >> (l + 1)) & 1;
  // Mezi stejně průchodnými pruhy ten bez těla, které zraní, pak nejbližší.
  const bestFrom = (from: number): number => {
    let best = from;
    for (const candidate of [-1, 0, 1]) {
      const [a, b] = [rank(candidate) * 2 + hostile(candidate), rank(best) * 2 + hostile(best)];
      if (a < b || (a === b && Math.abs(candidate - from) < Math.abs(best - from))) best = candidate;
    }
    return best;
  };
  for (const candidate of [lane, lane - 1, lane + 1, lane - 2, lane + 2]) {
    const coin = last[candidate + 1];
    if (coin === null || coin === undefined || (coin - pz) / vz < lag + LANE_TICKS * Math.abs(candidate - lane)) continue;
    let crossed = 0;
    for (let l = Math.min(lane, candidate); l <= Math.max(lane, candidate); l += 1) crossed |= 1 << (l + 1);
    if ((crossed & avoid) !== 0) continue;
    const back = bestFrom(candidate);
    const spare = rank(back) === ACTION ? JUMP_AT_TICKS : COIN_SPARE;
    if (back === candidate || (rowZ - UNIT - coin) / vz >= lag + LANE_TICKS * Math.abs(back - candidate) + spare) return candidate;
  }
  return bestFrom(lane);
}

export const NO_COINS: readonly (number | null)[] = [null, null, null];

const botParams = z.object({}).strict();

export const runnerBot: BotPiece<z.infer<typeof botParams>> = {
  id: 'runner_bot',
  params: botParams,
  roles: ['player', 'obstacle'],
  reactionTicks: 8,
  cost: () => ({ bodies: 0, rules: 0 }),
  decide: ({ state, player, recent }): ArcadeInput => {
    const p = baseOf(player);
    // Za poslední řadou trať volná: mince ve finále bere dál.
    const row: Row = nextRow(state, player) ?? { z: Number.POSITIVE_INFINITY, lanes: [-1, 0, 1].map(() => ({ status: FREE, action: null })) };

    // Pruh, do kterého robot míří, včetně stisků, které ještě nevidí.
    let lane = read(state, p, 'aux0');
    let tapped = false;
    let slid = false;
    for (const input of recent) {
      if ((input.buttons & BUTTON.LEFT) !== 0) lane = Math.max(-1, lane - 1);
      if ((input.buttons & BUTTON.RIGHT) !== 0) lane = Math.min(1, lane + 1);
      tapped ||= (input.buttons & BUTTON.TAP) !== 0;
      slid ||= (input.buttons & BUTTON.DOWN) !== 0;
    }

    const vz = Math.max(1, read(state, p, 'vz'));
    const pz = read(state, p, 'z');
    // Hrozby chování robot nevidí – tah do pruhu s mincí přebije plánovač pruhů (`planLanes`). Stojící hráč (start)
    // čas k řadě nezná: mince až v pohybu.
    const last = read(state, p, 'vz') > 0 ? lastCoins(footprintsOf(state, [RL.collectible]), pz, row.z) : NO_COINS;
    const avoid = hostileLanes(footprintsOf(state, HOSTILE), pz, row.z);
    const best = laneChoice(row.lanes.map((l) => l.status), lane, row.z, pz, vz, recent.length, last, avoid);
    if (best < lane) return { buttons: BUTTON.LEFT, axis: 0 };
    if (best > lane) return { buttons: BUTTON.RIGHT, axis: 0 };

    const ticksTo = (row.z - pz) / vz;
    const need = (row.lanes[lane + 1] as Row['lanes'][number]).action;
    const grounded = (read(state, p, 'flags') & F.grounded) !== 0;
    if (need === 'jump' && ticksTo <= JUMP_AT_TICKS && grounded && !tapped) return { buttons: BUTTON.TAP, axis: 0 };
    if (need === 'slide' && ticksTo <= SLIDE_AT_TICKS && !slid) return { buttons: BUTTON.DOWN, axis: 0 };
    return NO_INPUT;
  },
};
