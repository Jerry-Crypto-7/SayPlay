/**
 * Úder tam, kde chyběl (P52 T5). Bludiště nemělo kam dát nepřítele (`abilities: the level has no place for an
 * enemy to strike`), takže věta „punches the skeletons in his way“ akci ztratila (dev P52 d05, d06). Nepřátelé
 * stojí na cestě ke východu (`walkerFoeCells`) a robot je cestou udeří. Hra bez úderu staví týž svět.
 */

import { beforeAll, describe, expect, it } from 'vitest';

import { canonicalHash } from '@/ir/worlddoc';

import { draftGameSpecWithMeta } from '../../draft';
import type { GameSpecV1 } from '../../spec';
import { arcadeWorldOf } from '../compile';
import { type ArcadeWorld, underlyingRule } from '../contract';
import { ARCADE_LIBRARY } from '../library';
import { loadRapier } from '../physics/world';
import { WALKER_CELL, WALKER_FOES, walkerExit, walkerFoeCells, walkerLabyrinth, walkerMaze, walkerPath } from '../pieces/walker';
import { type BotProfile, runBot, verifyArcade } from '../verify';

const SEEDS = Array.from({ length: 10 }, (_, index) => index + 1);

beforeAll(async () => {
  await loadRapier();
});

function worldOf(spec: GameSpecV1, seed: number): ArcadeWorld {
  const made = arcadeWorldOf(spec, seed);
  if (!made.ok) throw new Error(made.issues.join('; '));
  return made.world;
}

const wins = (spec: GameSpecV1, profile: BotProfile): number => SEEDS.filter((seed) => runBot(worldOf(spec, seed), ARCADE_LIBRARY, { profile }).outcome === 'won').length / SEEDS.length;

const WALKER = {
  old: 'a hero walks through a stone labyrinth and punches the skeletons in his way',
  paced: 'A ranger wanders a hedge maze and kicks the angry gnomes that block the paths.',
} as const;

describe('P52 T5: strike in walker labyrinths', () => {
  it.each(Object.entries(WALKER))('%s maze: the sentence keeps strike, verification proves it and the intermediate bot uses it', (_name, text) => {
    const spec = draftGameSpecWithMeta(text, 1).spec;
    expect(spec.control).toBe('walker');
    expect(spec.abilities).toEqual(['strike']);
    let used = 0;
    for (const seed of SEEDS) {
      const world = worldOf(spec, seed);
      expect(verifyArcade(world, ARCADE_LIBRARY).failures, `${seed}`).toEqual([]);
      const run = runBot(world, ARCADE_LIBRARY, { profile: 'intermediate' });
      if (run.firstFired[world.rules.findIndex((ref) => underlyingRule(ref).id === 'ability_strike')]! >= 0) used += 1;
    }
    expect(used / SEEDS.length).toBeGreaterThanOrEqual(0.9);
  }, 300_000);

  // Buňka bludiště je lehká už bez úderu (novice 10/10 na obou větách): úder ji nesmí posunout.
  it.each(Object.entries(WALKER))('%s maze: novice and intermediate win as often as without strike', (_name, text) => {
    const spec = draftGameSpecWithMeta(text, 1).spec;
    const { abilities: _abilities, ...plain } = spec;
    for (const profile of ['novice', 'intermediate'] as const) expect(Math.abs(wins(spec, profile) - wins(plain, profile)), profile).toBeLessThanOrEqual(0.1);
  }, 300_000);

  it('foes stand on the route to the exit, away from its ends', () => {
    for (const [seed, segments] of SEEDS.flatMap((seed) => [[seed, true], [seed, undefined]] as const)) {
      const params = walkerLabyrinth.params.parse({ size: 15, segments, collect: seed % 2 === 0 });
      const map = walkerMaze(seed, params.size);
      const path = walkerPath(map, params.size + 1, walkerExit(map, segments));
      const foes = walkerFoeCells(walkerLabyrinth.generate(seed, params)).map(({ x, z }) => path.indexOf((z / WALKER_CELL) * params.size + x / WALKER_CELL));
      expect(foes.length, `${seed}`).toBe(WALKER_FOES.count);
      for (const index of foes) {
        expect(index, `${seed}`).toBeGreaterThanOrEqual(WALKER_FOES.clear);
        expect(index, `${seed}`).toBeLessThanOrEqual(path.length - 1 - WALKER_FOES.clear);
      }
    }
  });

  it('a walker game without strike builds the same world as before', () => {
    // Otisky změřené před T5: bludiště bez akce (staré a nové) a nové s krádeží jisker.
    const old = draftGameSpecWithMeta(WALKER.old, 1).spec;
    const paced = draftGameSpecWithMeta(WALKER.paced, 1).spec;
    const plain = (spec: GameSpecV1): GameSpecV1 => ({ ...spec, abilities: undefined });
    const hashes = [plain(old), plain(paced), { ...paced, abilities: ['grab' as const] }].map((spec) => canonicalHash(worldOf(spec, 1)));
    expect(hashes).toEqual(['d4fffe5c', '0a64af08', 'a5485895']);
  });
});
