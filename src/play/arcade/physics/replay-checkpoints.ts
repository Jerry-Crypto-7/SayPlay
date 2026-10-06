/** Lab oracle: the same recorded inputs and quantized kernel state in both runtimes. */
import { ARCADE_LIMITS, HEADER, NO_INPUT, RUN_STATE, type ArcadeWorld, type InputEvent } from '../contract';
import { hashArcade, instantiate, loadProgram, outcomeOf } from '../kernel';
import { step } from '../kernel';
import { ARCADE_LIBRARY } from '../library';
import { releasePhysics } from './step';
import { loadRapier } from './world';

export interface ReplayCheckpoint {
  readonly tick: number;
  readonly hash: string;
  readonly outcome: ReturnType<typeof outcomeOf>;
  /** Complete Int32 kernel state, including bodies, counters and PRNG state. */
  readonly state: readonly number[];
}
export interface CheckpointReplay {
  readonly world: ArcadeWorld;
  readonly inputs: readonly InputEvent[];
  readonly checkpoints: readonly number[];
}

export async function replayCheckpoints({ world, inputs, checkpoints }: CheckpointReplay): Promise<readonly ReplayCheckpoint[]> {
  if (checkpoints.some(tick => !Number.isInteger(tick) || tick < 0 || tick > ARCADE_LIMITS.maxTicks)) throw new Error('Invalid replay checkpoint');
  if (inputs.some((input, index) => !Number.isInteger(input.tick) || input.tick < 0 || index > 0 && input.tick <= inputs[index - 1]!.tick)) throw new Error('Replay inputs must have strictly increasing ticks');
  await loadRapier();
  const wanted = [...new Set(checkpoints)].sort((a, b) => a - b);
  const state = instantiate(world), program = loadProgram(world, ARCADE_LIBRARY);
  const result: ReplayCheckpoint[] = [];
  let next = 0;
  try {
    for (const checkpoint of wanted) {
      while (state[HEADER.tick]! < checkpoint) {
        if (state[HEADER.runState] !== RUN_STATE.running) throw new Error(`Run ended before checkpoint ${checkpoint}`);
        const tick = state[HEADER.tick]!;
        while (next < inputs.length && inputs[next]!.tick < tick) next++;
        const event = inputs[next];
        step(state, event?.tick === tick ? event : NO_INPUT, program);
      }
      result.push({ tick: state[HEADER.tick]!, hash: hashArcade(state), outcome: outcomeOf(state), state: Array.from(state) });
    }
    return result;
  } finally { releasePhysics(state); }
}
