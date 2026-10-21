/**
 * Ovládání pruhů (P54C T4): pět pruhů vedle sebe, které sdílí chytání, bouchání,
 * obrana pruhů a krájení. Osa −1000..1000 vybere pruh po pásmech šířky 400
 * (osa 0 = bez vstupu, pruh drží), šipky ho posunou o jeden. `TAP` je akce
 * v pruhu, `HOLD` držení; co akce udělá, rozhoduje pravidlo žánru – ovládání
 * jen zapíše pruh a akci do těla hráče.
 *
 * Tělo hráče: `aux0` = pruh proti startovnímu (−2..2, `laneOf` vrací 0–4), `aux1` = −1 ťuk
 * v tomto tiku, jinak počet tiků držení. Generátor žánru staví hráče do pruhu `LANE_START`
 * (`x = 0`); `aux0` počáteční tělo nastavit neumí (`BodyInit`), proto je 0 právě start (P54C T5).
 */

import { z } from 'zod';

import { AXIS_MIN, type ArcadeState, BODY, BUTTON, type ControlPiece, UNIT, bodyBase } from '../contract';

export const LANES = {
  count: 5,
  /** Šířka pásma osy na jeden pruh: 5 × 400 = celý rozsah −1000..1000. */
  band: 400,
  /** Rozestup pruhů ve světě. */
  width: 2 * UNIT,
  /** Rychlost přesunu mezi pruhy za tik: sousední pruh za 5 tiků. */
  speed: 400,
} as const;

/** Prostřední pruh: start hráče a pruh se středem `x = 0`. */
export const LANE_START = 2;

/** Osa → pruh 0–4 po pásmech od −1000; krajní 1000 patří poslednímu pruhu. */
export const laneOfAxis = (axis: number): number => Math.min(LANES.count - 1, Math.max(0, Math.floor((axis - AXIS_MIN) / LANES.band)));

/** Pruh → osa ve středu jeho pásma. Střed prostředního pásma je 0 = bez vstupu, proto 1. */
export function axisOfLane(lane: number): number {
  const center = AXIS_MIN + LANES.band * lane + LANES.band / 2;
  return center === 0 ? 1 : center;
}

/** Střed pruhu ve světě (osa x). */
export const laneX = (lane: number): number => (lane - LANE_START) * LANES.width;

/** Pruh pod `x` ve světě (nejbližší střed, krajní pruhy berou i to, co je za nimi). */
export const laneOfX = (x: number): number => Math.min(LANES.count - 1, Math.max(0, Math.round(x / LANES.width) + LANE_START));

/** Pruh, ve kterém hráč je nebo kam se přesouvá. */
export const laneOf = (state: ArcadeState, player: number): number => (state[bodyBase(player) + BODY.aux0] as number) + LANE_START;

/** Pruh ťuku v tomto tiku, jinak `null`. */
export const tappedIn = (state: ArcadeState, player: number): number | null => ((state[bodyBase(player) + BODY.aux1] as number) === -1 ? laneOf(state, player) : null);

/** Kolik tiků po stisku hráč drží (0 = nedrží). */
export const heldTicks = (state: ArcadeState, player: number): number => Math.max(0, state[bodyBase(player) + BODY.aux1] as number);

const lanesParams = z.object({}).strict();

export const lanesControl: ControlPiece<z.infer<typeof lanesParams>> = {
  id: 'lanes',
  params: lanesParams,
  roles: ['player'],
  cost: () => ({ bodies: 0, rules: 0 }),
  step: (state, player, input) => {
    const base = bodyBase(player);
    let lane = laneOf(state, player);
    if (input.axis !== 0) lane = laneOfAxis(input.axis);
    if ((input.buttons & BUTTON.LEFT) !== 0) lane = Math.max(0, lane - 1);
    if ((input.buttons & BUTTON.RIGHT) !== 0) lane = Math.min(LANES.count - 1, lane + 1);
    state[base + BODY.aux0] = lane - LANE_START;
    const dx = laneX(lane) - (state[base + BODY.x] as number);
    state[base + BODY.vx] = Math.max(-LANES.speed, Math.min(LANES.speed, dx));
    const held = state[base + BODY.aux1] as number;
    state[base + BODY.aux1] = (input.buttons & BUTTON.TAP) !== 0 ? -1 : (input.buttons & BUTTON.HOLD) !== 0 ? Math.max(0, held) + 1 : 0;
  },
};
