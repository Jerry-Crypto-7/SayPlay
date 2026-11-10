/**
 * P83A T2: obě sbírací věty slepého soudu (rychlá verze, semínko publikace) jdou neobratně vyhrát a „+1“ se ukáže,
 * jen když roste počítadlo cíle. Před opravou: začátečník do 60 s 3/10 a 1/10, náhodný hráč ≥ 1 věc 2/10 a 1/10,
 * 12 ze 14 „+1“ bez růstu (`evals/play/p83/a-repro.md`).
 */

import { beforeAll, describe, expect, it } from 'vitest';

import { runBeginner, secondsOf } from '@/play/arcade/beginner-bot';
import { loadRapier } from '@/play/arcade/physics/world';

import { JUDGE_SENTENCES, SEEDS, popsOf, quickWorld } from '../a-repro';
import { runRandom } from '../random-player';

beforeAll(async () => {
  await loadRapier();
});

describe.each(JUDGE_SENTENCES)('"%s"', (sentence) => {
  const world = (): ReturnType<typeof quickWorld> => quickWorld(sentence);

  it('the beginner bot wins inside 60 s on every seed, and each "+1" grows the counter', () => {
    const made = world();
    const runs = Array.from({ length: SEEDS }, (_, k) => runBeginner(made, undefined, { seed: k + 1 }));
    expect(runs.map((run) => run.outcome === 'won' && secondsOf(run.tick) <= 60)).toEqual(runs.map(() => true));
    const pops = popsOf(made, runs[0]!.inputs);
    expect(pops.phantom).toBe(0);
    expect(pops.pops).toBe(3);
  });

  it('a saved game keeps its sparks, and picking one up or the field taking it back shows no "+1"', () => {
    const made = quickWorld(sentence, true);
    const pops = popsOf(made, runBeginner(made, undefined, { seed: 1 }).inputs);
    expect(pops.pops).toBeGreaterThan(0);
    expect(pops.phantom).toBe(0);
  });

  it('random arrows and drags hold at least 1 of 3 after 60 s on 8 of 10 seeds', () => {
    const made = world();
    const items = Array.from({ length: SEEDS }, (_, k) => runRandom(made, k + 1).items);
    expect(items.filter((count) => count >= 1).length, JSON.stringify(items)).toBeGreaterThanOrEqual(8);
  });
});
