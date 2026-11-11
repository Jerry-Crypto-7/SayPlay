/**
 * P83A T3: sběr bez počtu ve větě se sprškou `treasure_rush` jde neobratně vyhrát do 75 s (`FIRST_MINUTE`: 8 věcí
 * ve vlně, 5 životů, jen nové hry). Před opravou začátečník 7/10 („a solar system …“) a 3/10 („A penguin … falling pianos“), po ní 10/10 a 9/10;
 * uložená hra nese své ladění a životy a hraje se jako dřív.
 */

import { beforeAll, describe, expect, it } from 'vitest';

import { derivedSeeds, seedFrom } from '@/app/api/play/_publish';
import { runBeginner, secondsOf } from '@/play/arcade/beginner-bot';
import { arcadeWorldOf } from '@/play/arcade/compile';
import { type ArcadeWorld, COUNTER, HEADER } from '@/play/arcade/contract';
import { instantiate } from '@/play/arcade/kernel';
import { loadRapier } from '@/play/arcade/physics/world';
import { runBot } from '@/play/arcade/verify';
import { draftGameSpecWithMeta } from '@/play/draft';
import { FIRST_MINUTE } from '@/play/compose/compile';

import { WIN_WITHIN_S } from '../a-judge5';
import { JUDGE_SENTENCES, SEEDS, quickWorld } from '../a-repro';

// Věta o sluneční soustavě (`JUDGE_FIVE[2]`) jde od P83C do klikací simulace, věta o obchodě od P83E do obchodu –
// první minutu arény tu drží věty, které v aréně zůstaly. Tučňák (`JUDGE_FIVE[4]`) byl arénou jen kvůli slovům
// pokynu pro AI („ignore all previous instructions …“); od P85A T2 se pokyn nečte a hraje jako tatáž věta bez něj
// (běžec, `evals/play/p85/__tests__/ai-requests.test.ts`) – arénu bez počtu drží liška.
const UNCOUNTED = ['A fox gathers glowing berries in a snowy forest while owls swoop down'] as const;
const RACCOON = 'A raccoon scrubs a mountain of dirty dishes in a busy diner kitchen.';

const livesOf = (world: ArcadeWorld): number => instantiate(world)[HEADER.counters + COUNTER.health] as number;

/** Body cíle `grow_to`, i obalené bránou skládané hry (`assembly_gate_counter`). */
function pointsOf(world: ArcadeWorld): number | undefined {
  for (const rule of world.rules) {
    const own = rule.id === 'grow_to' ? rule.params : (rule.params as { base?: { id: string; params: unknown } }).base?.id === 'grow_to' ? (rule.params as { base: { params: unknown } }).base.params : undefined;
    if (own !== undefined) return (own as { points: number }).points;
  }
  return undefined;
}

/** Svět specu uloženého před T3: 10 věcí ve vlně a tři životy. */
function savedWorld(sentence: string): ArcadeWorld {
  const drafted = draftGameSpecWithMeta(sentence, 1).spec;
  const { clock: _clock, calm: _calm, ...own } = drafted.controlParams?.tuning as Record<string, unknown>;
  const tuning = { ...own, items: 10, waves: 3 };
  const mechanics = drafted.mechanics.map((mechanic) => (mechanic.id === 'health' ? { ...mechanic, params: { ...mechanic.params, max: 3 } } : mechanic));
  const spec = { ...drafted, controlParams: { ...drafted.controlParams, tuning }, mechanics };
  for (const seed of derivedSeeds(seedFrom(sentence.trim()))) {
    const made = arcadeWorldOf(spec, seed);
    if (made.ok) return made.world;
  }
  throw new Error(`no saved world for "${sentence}"`);
}

beforeAll(async () => {
  await loadRapier();
});

describe.each(UNCOUNTED)('"%s"', (sentence) => {
  it('a new game has 8 items a wave and 5 lives, the beginner wins inside 75 s on 9 of 10 seeds and the robot plays 30-90 s', () => {
    const world = quickWorld(sentence);
    expect(pointsOf(world)).toBe(FIRST_MINUTE.items * 3);
    expect(livesOf(world)).toBe(FIRST_MINUTE.lives);
    const wins = Array.from({ length: SEEDS }, (_, k) => runBeginner(world, undefined, { seed: k + 1 })).map((run) => run.outcome === 'won' && secondsOf(run.tick) <= WIN_WITHIN_S);
    expect(wins.filter(Boolean).length, JSON.stringify(wins)).toBeGreaterThanOrEqual(9);
    const bot = runBot(world);
    expect(bot.outcome).toBe('won');
    expect(secondsOf(bot.tick)).toBeGreaterThanOrEqual(30);
    expect(secondsOf(bot.tick)).toBeLessThanOrEqual(90);
  });

  it('a saved game keeps 10 items a wave and 3 lives', () => {
    const world = savedWorld(sentence);
    expect(pointsOf(world)).toBe(30);
    expect(livesOf(world)).toBe(3);
  });
});

it('a sentence with a count keeps 3 lives', () => {
  expect(livesOf(quickWorld(JUDGE_SENTENCES[0]))).toBe(3);
});

// u34 sady P37A (`families.test.ts`): sprška přivedla bosse dřív než vlnu s pronásledovatelem, ten s bossem zůstal
// a robot bosse neporazil na žádném semínku (prohra na hodinách 88 s).
it('later waves bring no chaser, so the robot still beats the boss of "A raccoon scrubs … dishes"', () => {
  const world = quickWorld(RACCOON);
  expect(pointsOf(world)).toBe(FIRST_MINUTE.items * 3);
  const waves = world.rules.find((rule) => rule.id === 'arena_waves')!.params.waves as readonly { readonly chasers: number }[];
  expect(waves.map((wave) => wave.chasers)).toEqual(waves.map(() => 0));
  expect(runBot(world).outcome).toBe('won');
});
