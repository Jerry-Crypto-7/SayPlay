/**
 * Ovládání pruhů (P54C T4): osa → pruh 0–4 po pásmech šířky 400, šipky o jeden
 * pruh, ťuk a držení v těle hráče. Sdílí ho chytání, bouchání, obrana a krájení,
 * takže chyba na hraně pásma by se propsala do čtyř žánrů naráz.
 */

import { describe, expect, it } from 'vitest';

import { AXIS_MAX, AXIS_MIN, BODY, BODY_STRIDE, BUTTON, HEADER_SIZE, type ArcadeInput, bodyBase } from '../contract';
import { ARCADE_LIBRARY } from '../library';
import { LANES, LANE_START, axisOfLane, heldTicks, laneOf, laneOfAxis, laneX, lanesControl, tappedIn } from '../pieces/lanes';

const PLAYER = 0;

/** Tělo hráče, jak ho postaví `buildWorld`: `x = 0` a pracovní sloty nulové (`BodyInit` `aux0` nemá). */
function freshState(): Int32Array {
  return new Int32Array(HEADER_SIZE + 2 * BODY_STRIDE);
}

/** Krok ovládání a posun hráče o jeho rychlost, jak to po ovládání udělá jádro. */
function play(inputs: readonly ArcadeInput[], state = freshState()): Int32Array {
  const base = bodyBase(PLAYER);
  for (const input of inputs) {
    lanesControl.step(state, PLAYER, input, {});
    state[base + BODY.x] = (state[base + BODY.x] as number) + (state[base + BODY.vx] as number);
  }
  return state;
}

const idle = (ticks: number): ArcadeInput[] => Array.from({ length: ticks }, () => ({ buttons: 0, axis: 0 }));

describe('lanes control (P54C T4)', () => {
  it('maps the axis to five bands of 400, edges included', () => {
    expect(LANES.count).toBe(5);
    const cases: readonly (readonly [number, number])[] = [
      [AXIS_MIN, 0], [-601, 0], [-600, 1], [-201, 1], [-200, 2], [199, 2], [200, 3], [599, 3], [600, 4], [AXIS_MAX, 4],
    ];
    for (const [axis, lane] of cases) expect(laneOfAxis(axis), `axis ${axis}`).toBe(lane);
  });

  it('gives every lane a non-zero axis inside its own band', () => {
    for (let lane = 0; lane < LANES.count; lane += 1) {
      expect(axisOfLane(lane)).not.toBe(0);
      expect(laneOfAxis(axisOfLane(lane))).toBe(lane);
    }
  });

  // P54C T5: dřív byl pruh v `aux0` absolutní, takže nově postavený hráč (aux0 = 0) bez vstupu odjel do pruhu 0.
  it('starts in the middle lane and stays there without input', () => {
    const state = play(idle(30));
    expect(laneOf(state, PLAYER)).toBe(LANE_START);
    expect(state[bodyBase(PLAYER) + BODY.x]).toBe(laneX(LANE_START));
  });

  it('moves the hero to the lane the axis picks and keeps it when the axis lets go', () => {
    const state = play([{ buttons: 0, axis: axisOfLane(4) }, ...idle(20)]);
    expect(laneOf(state, PLAYER)).toBe(4);
    expect(state[bodyBase(PLAYER) + BODY.x]).toBe(laneX(4));
  });

  it('steps one lane per arrow and stops at the edges', () => {
    const left = play([...Array.from({ length: 4 }, () => ({ buttons: BUTTON.LEFT, axis: 0 })), ...idle(30)]);
    expect(laneOf(left, PLAYER)).toBe(0);
    expect(left[bodyBase(PLAYER) + BODY.x]).toBe(laneX(0));
    const right = play([{ buttons: BUTTON.RIGHT, axis: 0 }]);
    expect(laneOf(right, PLAYER)).toBe(LANE_START + 1);
  });

  it('marks a tap for one tick and counts held ticks', () => {
    const tapped = play([{ buttons: BUTTON.TAP, axis: 0 }]);
    expect(tappedIn(tapped, PLAYER)).toBe(LANE_START);
    expect(heldTicks(tapped, PLAYER)).toBe(0);
    const after = play(idle(1), tapped);
    expect(tappedIn(after, PLAYER)).toBeNull();
    const held = play([{ buttons: BUTTON.TAP | BUTTON.HOLD, axis: 0 }, ...Array.from({ length: 15 }, () => ({ buttons: BUTTON.HOLD, axis: 0 }))]);
    expect(heldTicks(held, PLAYER)).toBe(15);
    expect(heldTicks(play(idle(1), held), PLAYER)).toBe(0);
  });

  it('is deterministic: the same inputs give the same state', () => {
    const inputs: ArcadeInput[] = [
      { buttons: 0, axis: -900 }, ...idle(3), { buttons: BUTTON.TAP, axis: 350 }, { buttons: BUTTON.RIGHT, axis: 0 },
      { buttons: BUTTON.HOLD, axis: 0 }, { buttons: BUTTON.HOLD, axis: 0 }, ...idle(12),
    ];
    expect(Array.from(play(inputs))).toEqual(Array.from(play(inputs)));
  });

  it('is registered in the arcade library under its id', () => {
    expect(ARCADE_LIBRARY.controls.lanes).toBe(lanesControl);
  });
});
