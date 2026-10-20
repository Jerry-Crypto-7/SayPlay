/**
 * Robot slučování (P54C T11) je hladový: předmět z fronty pustí nad stejný předmět, na který by dopadl jako první,
 * jinak do nejnižšího místa nádoby. Vidí stav o reakci starší – co spadlo nedávno, ještě nevidí – a hodiny pustu
 * i polohu dávkovače si dopočítá z vlastních vstupů, které stav ještě neukazuje (`replayed`), takže nepustí dvakrát.
 * Dávkovač vede osou přesně na cíl (osa je rychlost) a pustí, až na cíli je.
 */

import { z } from 'zod';

import { type ArcadeInput, type ArcadeObservation, BODY, BUTTON, type BotPiece, FLAG, HEADER, NO_INPUT, bodyBase } from '../contract';
import { MERGE, axisFor, centerY, clockOf, dropLimit, dropperStep, dropsOf, itemLevel, patienceOf, queueSchema, queued, sizeOf } from './merge-drop';

const botParams = z.object({ queue: queueSchema }).strict();
export type MergeBotParams = z.infer<typeof botParams>;

/** Jak blízko cíle (j) robot pustí. */
const AIM = 20;
/** Krok, po kterém robot hledá nejnižší místo (j). */
const SCAN = 50;

/** Stav pustu a dávkovač po vlastních vstupech, které pozorovaný stav ještě neukazuje – táž pravidla jako `merge_drop`. */
export function replayed(observation: ArcadeObservation, reach: number): { readonly clock: number; readonly drops: number; readonly x: number } {
  const { state, player } = observation;
  let clock = clockOf(state);
  let drops = dropsOf(state);
  let x = state[bodyBase(player) + BODY.x] as number;
  let tick = observation.tick;
  for (const input of observation.recent) {
    x += dropperStep(x, input.axis, reach, MERGE.speed);
    tick += 1;
    if (clock > 0) clock -= 1;
    else if ((input.buttons & BUTTON.TAP) !== 0 || -clock >= patienceOf(tick - 1)) {
      drops += 1;
      clock = MERGE.reload;
    } else clock -= 1;
  }
  return { clock, drops, x };
}

/** Těleso v nádobě, na které může padající předmět dopadnout. */
interface Resting {
  readonly body: number;
  readonly x: number;
  readonly cy: number;
  readonly half: number;
  readonly ball: boolean;
  readonly level: number;
}

function restingOf(state: ArrayLike<number>): Resting[] {
  const out: Resting[] = [];
  for (let body = 0; body < (state[HEADER.bodyCount] as number); body += 1) {
    const base = bodyBase(body);
    const flags = state[base + BODY.flags] as number;
    if ((flags & (FLAG.alive | FLAG.physics)) !== (FLAG.alive | FLAG.physics)) continue;
    out.push({ body, x: state[base + BODY.x] as number, cy: centerY(state, body), half: (state[base + BODY.w] as number) / 2, ball: (flags & FLAG.ball) !== 0, level: itemLevel(state, body) });
  }
  return out;
}

/** Kde se střed předmětu poloměru `r` puštěného v `x` poprvé zastaví a o co: výška středu a tělo (−1 = dno). */
export function landing(resting: readonly Resting[], x: number, r: number): { readonly cy: number; readonly on: number } {
  let cy = r;
  let on = -1;
  for (const item of resting) {
    const dx = Math.abs(x - item.x);
    let top: number;
    if (item.ball) {
      const reach = r + item.half;
      if (dx >= reach) continue;
      top = item.cy + Math.sqrt(reach * reach - dx * dx);
    } else {
      // Kámen je kvádr: plocha nahoře, přes roh jako koule kolem hrany.
      if (dx >= item.half + r) continue;
      const over = dx - item.half;
      top = item.cy + item.half + (over <= 0 ? r : Math.sqrt(r * r - over * over));
    }
    if (top > cy) {
      cy = top;
      on = item.body;
    }
  }
  return { cy, on };
}

/** Kam robot chce pustit předmět úrovně `level`: nad stejný předmět, na který dopadne jako první, jinak nejníž. */
export function mergeTarget(state: ArrayLike<number>, level: number, from: number): number {
  const r = sizeOf(level) / 2;
  const limit = dropLimit(sizeOf(level));
  const resting = restingOf(state);
  let best: { x: number; cy: number } | null = null;
  for (const item of resting) {
    if (item.level !== level) continue;
    const x = Math.max(-limit, Math.min(limit, item.x));
    const land = landing(resting, x, r);
    if (land.on !== item.body) continue;
    if (best === null || land.cy < best.cy || (land.cy === best.cy && Math.abs(x - from) < Math.abs(best.x - from))) best = { x, cy: land.cy };
  }
  if (best !== null) return best.x;
  let lowest = { x: from, cy: Number.POSITIVE_INFINITY };
  for (let x = -limit; x <= limit; x += SCAN) {
    const land = landing(resting, x, r);
    if (land.cy < lowest.cy || (land.cy === lowest.cy && Math.abs(x - from) < Math.abs(lowest.x - from))) lowest = { x, cy: land.cy };
  }
  return lowest.x;
}

export function mergeDecide(observation: ArcadeObservation, params: MergeBotParams): ArcadeInput {
  const reach = dropLimit(sizeOf(1));
  const now = replayed(observation, reach);
  const level = queued(params.queue, now.drops);
  const target = mergeTarget(observation.state, level, now.x);
  const there = Math.abs(now.x - target) <= AIM;
  // Předmět, který robot ještě neviděl (pozorovaný stav ho ukazuje až po reakci), nepustí; vlastní pust už ví.
  // Pust čte polohu dávkovače před pohybem tiku (pravidlo stisku běží hned za ovládáním).
  if (there && clockOf(observation.state) <= 0 && now.clock <= 0) return { axis: 0, buttons: BUTTON.TAP };
  return there ? NO_INPUT : { axis: axisFor(target, reach), buttons: 0 };
}

export const mergeBot: BotPiece<MergeBotParams> = {
  id: 'merge_bot',
  params: botParams,
  roles: ['player', 'collectible'],
  reactionTicks: 8,
  cost: () => ({ bodies: 0, rules: 0 }),
  decide: mergeDecide,
};
