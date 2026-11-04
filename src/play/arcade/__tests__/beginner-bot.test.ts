import { readFileSync } from 'node:fs';

import { beforeAll, describe, expect, it } from 'vitest';

import { canonicalHash } from '@/ir/worlddoc';
import { draftGameSpecWithMeta } from '@/play/draft';

import { BEGINNER, runBeginner } from '../beginner-bot';
import { arcadeWorldOf } from '../compile';
import type { ArcadeObservation, ArcadeWorld } from '../contract';
import { replay } from '../kernel';
import { ARCADE_LIBRARY } from '../library';
import { loadRapier } from '../physics/world';
import { runBot } from '../verify';

interface Picked { readonly genre: string; readonly text: string }
const before = JSON.parse(readFileSync('evals/play/p70a/before.json', 'utf8')) as { picks: Picked[] };
/** První věta každého žánru měření P70A (rychlá hra ji do toho žánru opravdu posílá). */
const perGenre = [...new Map(before.picks.map((pick) => [pick.genre, pick])).values()];

function worldOf(text: string, seed: number): ArcadeWorld {
  const made = arcadeWorldOf(draftGameSpecWithMeta(text, 1).spec, seed);
  if (!made.ok) throw new Error(made.issues.join('; '));
  return made.world;
}

beforeAll(async () => {
  await loadRapier();
});

describe('beginner bot (P70A T1)', () => {
  it('is deterministic per seed, leaves the world alone and replays to the same hash', () => {
    const world = worldOf('a bunny runs through the forest jumping over logs', 3);
    const untouched = canonicalHash(world);
    const first = runBeginner(world, undefined, { seed: 7 });
    const second = runBeginner(world, undefined, { seed: 7 });
    expect(second).toEqual(first);
    expect(replay(world, first.inputs, ARCADE_LIBRARY).hash).toBe(first.hash);
    expect(canonicalHash(world)).toBe(untouched);
    expect(runBeginner(world, undefined, { seed: 8 }).inputs).not.toEqual(first.inputs);
    expect(first.errorWindows).toBeGreaterThan(0);
  });

  it('sees the world 350–500 ms late, not as late as the winning bot', () => {
    const world = worldOf('a bunny runs through the forest jumping over logs', 3);
    const piece = ARCADE_LIBRARY.bots[world.bot.id]!;
    const lags: number[] = [];
    const library = { ...ARCADE_LIBRARY, bots: { ...ARCADE_LIBRARY.bots, [world.bot.id]: {
      ...piece,
      decide(observation: ArcadeObservation, params: unknown) {
        lags.push(observation.recent.length);
        return piece.decide(observation, params);
      },
    } } };
    runBeginner(world, library, { seed: 1 });
    const settled = lags.slice(BEGINNER.reactionMaxTicks);
    expect(Math.min(...settled)).toBeGreaterThanOrEqual(BEGINNER.reactionMinTicks);
    expect(Math.max(...settled)).toBeLessThanOrEqual(BEGINNER.reactionMaxTicks);
    expect(BEGINNER.reactionMinTicks).toBeGreaterThan(piece.reactionTicks);
  });

  // Bot, který vyhraje tam, kde vítězný robot ne, je rozbitý: měří chybu robota, ne obtížnost hry.
  it.each(perGenre.map((pick) => [pick.genre, pick.text] as const))('the winning bot wins at least as often as the beginner in %s', (_genre, text) => {
    const wins = { beginner: 0, perfect: 0 };
    for (const seed of [1, 2]) {
      const world = worldOf(text, seed);
      if (runBeginner(world, undefined, { seed }).outcome === 'won') wins.beginner += 1;
      if (runBot(world).outcome === 'won') wins.perfect += 1;
    }
    expect(wins.perfect).toBeGreaterThanOrEqual(wins.beginner);
  });
});
