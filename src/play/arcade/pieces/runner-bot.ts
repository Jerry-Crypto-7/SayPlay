/**
 * Robot běžce (P25A, T4) – věrohodný hráč pro ověření hratelnosti.
 *
 * Vidí stav 8 tiků starý (`reactionTicks`) a neextrapoluje ho: skáče a
 * uhýbá podle toho, co viděl, tedy o 8 tiků pozdě, stejně jako člověk.
 * Překážky čte z geometrie, ne z názvu modelu: plovoucí nad výškou skluzu =
 * podklouznout, nižší než vrchol skoku = přeskočit, jinak jen jiným pruhem.
 */

import { z } from 'zod';

import { type ArcadeInput, BODY, BUTTON, type BotPiece, FLAG, HEADER, NO_INPUT, ROLE, bodyBase } from '../contract';
import { JUMP_PEAK, RUNNER } from './runner';

/** Skok, když je překážka podle zastaralého pohledu 24 tiků daleko – skutečně ~16, uprostřed okna. */
const JUMP_AT_TICKS = 24;
const SLIDE_AT_TICKS = 22;
/** Rezerva nad překážkou, kterou robot ještě považuje za přeskočitelnou. */
const JUMP_MARGIN = 200;
/** Překážky do 1 m od sebe v ose z jsou jedna řada. */
const ROW_SPAN = 1000;

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
    const top = y + read(state, base, 'h');
    const action = y >= RN.slideH ? 'slide' : top + JUMP_MARGIN <= PEAK ? 'jump' : null;
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

const botParams = z.object({}).strict();

export const runnerBot: BotPiece<z.infer<typeof botParams>> = {
  id: 'runner_bot',
  params: botParams,
  roles: ['player', 'obstacle'],
  reactionTicks: 8,
  cost: () => ({ bodies: 0, rules: 0 }),
  decide: ({ state, player, recent }): ArcadeInput => {
    const p = baseOf(player);
    const row = nextRow(state, player);
    if (row === null) return NO_INPUT;

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

    const status = (l: number) => (row.lanes[l + 1] as Row['lanes'][number]).status;
    let best = lane;
    for (const candidate of [-1, 0, 1]) {
      const better = status(candidate) < status(best) || (status(candidate) === status(best) && Math.abs(candidate - lane) < Math.abs(best - lane));
      if (better) best = candidate;
    }
    if (best < lane) return { buttons: BUTTON.LEFT, axis: 0 };
    if (best > lane) return { buttons: BUTTON.RIGHT, axis: 0 };

    const vz = Math.max(1, read(state, p, 'vz'));
    const ticksTo = (row.z - read(state, p, 'z')) / vz;
    const need = (row.lanes[lane + 1] as Row['lanes'][number]).action;
    const grounded = (read(state, p, 'flags') & F.grounded) !== 0;
    if (need === 'jump' && ticksTo <= JUMP_AT_TICKS && grounded && !tapped) return { buttons: BUTTON.TAP, axis: 0 };
    if (need === 'slide' && ticksTo <= SLIDE_AT_TICKS && !slid) return { buttons: BUTTON.DOWN, axis: 0 };
    return NO_INPUT;
  },
};
