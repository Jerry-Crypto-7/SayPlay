/**
 * P83A: počítadlo sběru u dvou vět slepého soudu – rychlá verze (`draftGameSpecWithMeta(věta, 1)`) na semínku, které
 * dveře zkusí první (`derivedSeeds(seedFrom(věta))[0]`), jako `POST /api/play/games`. Vypíše výhru robota, začátečníka
 * (10 seedů), náhodného hráče (10 seedů, 60 s) a kolik „+1“ (vizuální `pickup` sběrnice) přišlo bez růstu cíle.
 *
 *   node --experimental-strip-types --no-warnings --import ./scripts/ts-paths.mjs evals/play/p83/a-repro.ts
 */

import { derivedSeeds, seedFrom } from '@/app/api/play/_publish';
import { createEffectsBus } from '@/components/play/arcade/effects/bus';
import { runBeginner, secondsOf } from '@/play/arcade/beginner-bot';
import { arcadeWorldOf } from '@/play/arcade/compile';
import { ARCADE_HZ, type ArcadeEffect, type ArcadeWorld, COUNTER, HEADER } from '@/play/arcade/contract';
import { instantiate, loadProgram, outcomeOf, step } from '@/play/arcade/kernel';
import { ARCADE_LIBRARY } from '@/play/arcade/library';
import { loadRapier } from '@/play/arcade/physics/world';
import { runBot } from '@/play/arcade/verify';
import { draftGameSpecWithMeta } from '@/play/draft';

import { runRandom } from './random-player';

export const JUDGE_SENTENCES = [
  'A knight must collect three golden keys in a castle while a dragon patrols the hall',
  'A small shop where I pick up three items and put them on the counter to see the total price',
] as const;

export const SEEDS = 10;

/** Svět, který dveře zveřejní jako rychlou verzi věty (první semínko, které projde); `saved` = spec uložený před P83A T2 (bez `near`). */
export function quickWorld(sentence: string, saved = false): ArcadeWorld {
  const drafted = draftGameSpecWithMeta(sentence, 1).spec;
  const { near: _near, ...before } = (drafted.controlParams?.tuning ?? {}) as Record<string, number | boolean | string>;
  const spec = saved ? { ...drafted, controlParams: { ...drafted.controlParams, tuning: before } } : drafted;
  for (const seed of derivedSeeds(seedFrom(sentence.trim()))) {
    const made = arcadeWorldOf(spec, seed);
    if (made.ok) return made.world;
  }
  throw new Error(`no world for "${sentence}"`);
}

/** „+1“ nad scénou (vizuální `pickup`) v běhu záznamu `inputs`: kolik jich bylo a kolik z nich bez růstu `items`. */
export function popsOf(world: ArcadeWorld, inputs: readonly { readonly tick: number; readonly buttons: number; readonly axis: number }[], seconds = 60): { readonly pops: number; readonly phantom: number } {
  const program = loadProgram(world, ARCADE_LIBRARY);
  const state = instantiate(world);
  let prev = state.slice();
  const listeners: ((effects: readonly ArcadeEffect[], tick: number) => void)[] = [];
  const bus = createEffectsBus({
    world,
    state: () => state,
    prev: () => prev,
    humanRun: () => true,
    subscribe: () => () => undefined,
    onEvents: (listener) => {
      listeners.push(listener);
      return () => undefined;
    },
  });
  let pops = 0;
  let phantom = 0;
  let grew = false;
  bus.subscribe((events) => {
    for (const event of events) {
      if (event.kind !== 'pickup') continue;
      pops += 1;
      if (!grew) phantom += 1;
    }
  });
  const byTick = new Map(inputs.map((input) => [input.tick, input]));
  for (let tick = 0; tick < seconds * ARCADE_HZ && outcomeOf(state) === 'running'; tick += 1) {
    prev = state.slice();
    const items = state[HEADER.counters + COUNTER.items] as number;
    const effects = step(state, byTick.get(tick) ?? { buttons: 0, axis: 0 }, program);
    grew = (state[HEADER.counters + COUNTER.items] as number) > items;
    for (const listener of listeners) listener(effects, tick);
  }
  return { pops, phantom };
}

async function main(): Promise<void> {
  await loadRapier();
  for (const sentence of JUDGE_SENTENCES) {
    const world = quickWorld(sentence);
    const bot = runBot(world);
    const beginner = Array.from({ length: SEEDS }, (_, k) => runBeginner(world, undefined, { seed: k + 1 }));
    const random = Array.from({ length: SEEDS }, (_, k) => runRandom(world, k + 1));
    const beginnerPops = popsOf(world, beginner[0]!.inputs, 60);
    console.log(JSON.stringify({
      sentence,
      bot: { outcome: bot.outcome, s: Math.round(secondsOf(bot.tick) * 10) / 10 },
      beginnerWins60: beginner.filter((run) => run.outcome === 'won' && secondsOf(run.tick) <= 60).length,
      beginner: beginner.map((run) => `${run.outcome}@${secondsOf(run.tick).toFixed(1)}`),
      randomItemsAt60: random.map((run) => run.items),
      randomAtLeastOne: random.filter((run) => run.items >= 1).length,
      beginnerSeed1Pops: beginnerPops,
    }));
  }
}

if (process.argv[1]?.endsWith('a-repro.ts')) await main();
