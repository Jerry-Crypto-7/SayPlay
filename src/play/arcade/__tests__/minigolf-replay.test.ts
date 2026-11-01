/**
 * Minigolf (P68 T6): replay od tiku 0. Dvě přehrání téhož záznamu = týž hash a shodné kontrolní body stavu po každé
 * ráně i po vrácení míčku z mimo dráhy; tentýž záznam posunutý o tik = jiný hash.
 */
import { describe, expect, it } from 'vitest';

import { type ArcadeWorld, BUTTON, HEADER, type InputEvent, NO_INPUT } from '../contract';
import { buildWorld, instantiate, loadProgram, replay, step } from '../kernel';
import { ARCADE_LIBRARY } from '../library';
import { replayCheckpoints } from '../physics/replay-checkpoints';
import { minigolfParts, outOfBoundsOf, strokesOf } from '../pieces/minigolf';
import { minigolfAxisToward, minigolfChargeFor } from '../pieces/minigolf-roll';

const parts = minigolfParts(5, { shape: 'L', obstacles: 3, moving: true });
const layout = (parts.control.params as { layout: { route: [number, number][] } }).layout;

function worldOf(): ArcadeWorld {
  const built = buildWorld({ seed: 5, control: parts.control, rules: parts.rules, bot: parts.bot, level: parts.level }, ARCADE_LIBRARY);
  if (!built.ok) throw new Error(built.issues.join('; '));
  return built.world;
}

const stroke = (tick: number, axis: number, charge: number): InputEvent[] => [
  ...Array.from({ length: charge }, (_, k) => ({ tick: tick + k, buttons: BUTTON.HOLD, axis })),
  { tick: tick + charge, buttons: BUTTON.TAP, axis },
];

const tee = parts.level.bodies[0] as { x: number; z: number };
const [cx, cz] = layout.route[0] as [number, number];
const [hx, hz] = layout.route.at(-1) as [number, number];
const toCorner = minigolfAxisToward(cx - tee.x, cz - tee.z);
const toHole = minigolfAxisToward(hx - cx, hz - cz);
/** Rána do mantinelu přes práh přeskoku (mimo dráhu), rána k rohu trasy, rána k jamce. */
const TAPS = [61, 260, 520] as const;
const toCornerCharge = minigolfChargeFor(toCorner, Math.hypot(cx - tee.x, cz - tee.z));
const inputs: InputEvent[] = [...stroke(1, 500, 60), ...stroke(TAPS[1] - toCornerCharge, toCorner, toCornerCharge), ...stroke(TAPS[2] - 30, toHole, 30)];

/** Tik, ve kterém se míček vrátil z mimo dráhy (čítač mimo dráhu skočil na 1). */
function returnTick(world: ArcadeWorld): number {
  const state = instantiate(world);
  const program = loadProgram(world, ARCADE_LIBRARY);
  const byTick = new Map(inputs.map((event) => [event.tick, event]));
  while ((state[HEADER.tick] as number) < 200) {
    step(state, byTick.get(state[HEADER.tick] as number) ?? NO_INPUT, program);
    if (outOfBoundsOf(state) === 1) return state[HEADER.tick] as number;
  }
  throw new Error('the ball never left the course');
}

describe('minigolf replay from tick 0', () => {
  it('plays the same record to the same hash twice', () => {
    const world = worldOf();
    const first = replay(world, inputs, ARCADE_LIBRARY);
    const second = replay(world, inputs, ARCADE_LIBRARY);
    expect(second).toEqual(first);
    expect(first.tick).toBeGreaterThan(TAPS[2]);
  });

  it('matches checkpoints after every stroke and after the return from out of bounds', async () => {
    const world = worldOf();
    const back = returnTick(world);
    expect(back).toBeGreaterThan(TAPS[0]);
    expect(back).toBeLessThan(TAPS[0] + 30);
    const checkpoints = [TAPS[0] + 1, TAPS[0] + 5, back, back + 1, TAPS[1] + 1, TAPS[1] + 20, TAPS[2] + 1];
    const first = await replayCheckpoints({ world, inputs, checkpoints });
    const second = await replayCheckpoints({ world, inputs, checkpoints });
    expect(second).toEqual(first);
    const atReturn = first.find((checkpoint) => checkpoint.tick === back)!;
    const state = Int32Array.from(atReturn.state);
    expect(strokesOf(state)).toBe(2);
    expect(outOfBoundsOf(state)).toBe(1);
    expect(strokesOf(Int32Array.from(first.at(-1)!.state))).toBe(4);
  });

  it('gives another hash when the same record is one tick late', () => {
    const world = worldOf();
    const late = inputs.map((event) => ({ ...event, tick: event.tick + 1 }));
    const horizon = TAPS[0] + 6;
    expect(replay(world, late, ARCADE_LIBRARY, horizon).hash).not.toBe(replay(world, inputs, ARCADE_LIBRARY, horizon).hash);
    const end = TAPS[1] + 10;
    expect(replay(world, late, ARCADE_LIBRARY, end).hash).not.toBe(replay(world, inputs, ARCADE_LIBRARY, end).hash);
  });
});
