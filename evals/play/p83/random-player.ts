/**
 * P83A: neobratný porotce v aréně – náhodné šipky a tahy s pevným seedem, jak je hrál skript slepého soudu
 * (`SOUD-POLE-2026-11-10.md`: 55–59 s šipek, WASD a tahů, počítadlo zůstalo 0/3). Žádný cíl nevidí: každé okno
 * 0,33–1,5 s drží jeden směr – šipka (8 směrů), tah (libovolný úhel), nebo nic. Los z vlastního streamu `pure-rand`
 * (`createStreams(seed).ai`), takže týž svět a týž seed dají týž běh.
 */

import { ARCADE_HZ, type ArcadeWorld, COUNTER, HEADER } from '@/play/arcade/contract';
import { instantiate, loadProgram, outcomeOf, step } from '@/play/arcade/kernel';
import { ARCADE_LIBRARY } from '@/play/arcade/library';
import { releasePhysics } from '@/play/arcade/physics/step';
import { arenaAxis } from '@/play/arcade/pieces/arena';
import { createStreams, nextInt } from '@/sim/rng';

export const RANDOM_PLAYER = {
  /** Jedno držení směru: 20–90 tiků (0,33–1,5 s). */
  minHoldTicks: 20,
  maxHoldTicks: 90,
  /** Podíl oken v promile: šipky, tah; zbytek = nic nedrží. */
  arrowsPerThousand: 500,
  dragPerThousand: 350,
} as const;

export interface RandomRun {
  readonly outcome: 'won' | 'lost' | 'running';
  readonly seconds: number;
  /** Sebrané věci cíle (`COUNTER.items`) na konci. */
  readonly items: number;
}

const ARROWS: readonly (readonly [number, number])[] = [
  [1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1],
];

/** Osa náhodného hráče `seed` na každý tik prvních `ticks` tiků – týž záznam hraje jádro i prohlížeč (`a-shots.ts`). */
export function randomAxes(seed: number, ticks: number): Int32Array {
  const dice = createStreams(seed).ai;
  const axes = new Int32Array(ticks);
  let axis = 0;
  let until = 0;
  for (let tick = 0; tick < ticks; tick += 1) {
    if (tick >= until) {
      until = tick + nextInt(dice, RANDOM_PLAYER.minHoldTicks, RANDOM_PLAYER.maxHoldTicks);
      const kind = nextInt(dice, 0, 999);
      const arrow = ARROWS[nextInt(dice, 0, ARROWS.length - 1)] as readonly [number, number];
      const dx = nextInt(dice, -100, 100);
      const dz = nextInt(dice, -100, 100);
      axis =
        kind < RANDOM_PLAYER.arrowsPerThousand ? arenaAxis(arrow[0], arrow[1])
        : kind < RANDOM_PLAYER.arrowsPerThousand + RANDOM_PLAYER.dragPerThousand ? (dx === 0 && dz === 0 ? 0 : arenaAxis(dx, dz))
        : 0;
    }
    axes[tick] = axis;
  }
  return axes;
}

/** Odehraje `world` náhodným hráčem `seed` nejvýš `seconds` sekund. */
export function runRandom(world: ArcadeWorld, seed: number, seconds = 60): RandomRun {
  const program = loadProgram(world, ARCADE_LIBRARY);
  const state = instantiate(world);
  const axes = randomAxes(seed, seconds * ARCADE_HZ);
  for (let tick = 0; tick < axes.length && outcomeOf(state) === 'running'; tick += 1) step(state, { buttons: 0, axis: axes[tick] as number }, program);
  const run: RandomRun = { outcome: outcomeOf(state), seconds: (state[HEADER.tick] as number) / ARCADE_HZ, items: state[HEADER.counters + COUNTER.items] as number };
  releasePhysics(state);
  return run;
}
