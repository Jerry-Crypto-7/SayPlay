/**
 * P54C T14br1: každá hodnota, kterou žánr P54C přijme (meze modulu a cílové skóre hloubky), dá výhru robota
 * za 30–90 s (G1). Režisér dřív vyplnil dolní mez, kterou věta neříká, a robot vyhrál přeskákání (10 řad) za 7 s
 * a vytlačování (3 soupeři) za 19,8 s; cílové skóre vyhrálo každou hru žánru hned (přeskákání s 10 body za 0,1 s).
 * Semínka: 1 hraje režisér, ostatní byla na dolní mezi nejtěsnější (README, T14br1; meze jsou změřené na 20).
 */

import { beforeAll, describe, expect, it } from 'vitest';

import { arcadeWorldOf, preloadPhysics } from '@/play/arcade/compile';
import { loadRapier } from '@/play/arcade/physics/world';
import { runBot } from '@/play/arcade/verify';

import type { GenreId, GenreModule, GenreSpec } from '../contract';
import { GENRE_MODULES, compileWith } from '../index';

const SEEDS = [1, 2, 8, 9, 13, 20] as const;
const GENRES = ['hop', 'merge', 'push', 'crowd', 'catch', 'whack', 'defense', 'slice'] as const satisfies readonly GenreId[];

beforeAll(async () => {
  await loadRapier();
});

/** Parametry, se kterými se žánr zkouší: každý kraj každé meze modulu a nejnižší cílové skóre. */
function cases(genre: (typeof GENRES)[number]): Record<string, number>[] {
  const edges = Object.entries(GENRE_MODULES[genre].paramBounds).flatMap(([key, range]) => [{ [key]: range.min }, { [key]: range.max }]);
  return [...edges, { targetScore: 10 }];
}

describe('every accepted value of a P54C genre gives a 30–90 s bot win (P54C T14br1)', () => {
  it.each(GENRES)('%s', async (genre) => {
    for (const params of cases(genre)) {
      const spec = compileWith(GENRE_MODULES[genre] as GenreModule, { genre, mode: 'default', hero: 'robot', params } as GenreSpec);
      await preloadPhysics(spec, loadRapier);
      for (const seed of SEEDS) {
        const made = arcadeWorldOf(spec, seed);
        if (!made.ok) throw new Error(made.issues.join('; '));
        const bot = runBot(made.world);
        const label = `${genre} ${JSON.stringify(params)} seed ${String(seed)}: ${bot.outcome} at ${(bot.tick / 60).toFixed(1)} s`;
        expect(bot.outcome, label).toBe('won');
        expect(bot.tick, label).toBeGreaterThanOrEqual(30 * 60);
        expect(bot.tick, label).toBeLessThanOrEqual(90 * 60);
      }
    }
  }, 60_000);
});
