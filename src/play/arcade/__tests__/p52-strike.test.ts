/**
 * Úder tam, kde chyběl (P52 T5). Bludiště nemělo kam dát nepřítele (`abilities: the level has no place for an
 * enemy to strike`), takže věta „punches the skeletons in his way“ akci ztratila (dev P52 d05, d06). Nepřátelé
 * stojí na cestě ke východu (`walkerFoeCells`) a robot je cestou udeří. Hra bez úderu staví týž svět.
 */

import { beforeAll, describe, expect, it } from 'vitest';

import { canonicalHash } from '@/ir/worlddoc';

import { generatorTakes } from '../../compose/compile';
import { draftGameSpecWithMeta } from '../../draft';
import type { GameSpecV1 } from '../../spec';
import { arcadeWorldOf } from '../compile';
import { ABILITIES, type AbilityId, type ArcadeWorld, underlyingRule } from '../contract';
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

/** Seme `run` akci `id`? Tik prvního výstřelu jejího pravidla, nebo −1. */
const firedAt = (world: ArcadeWorld, run: ReturnType<typeof runBot>, id: string): number => run.firstFired[world.rules.findIndex((ref) => underlyingRule(ref).id === id)] ?? -1;

const QUEST = {
  towers: 'An elf visits the four towers one by one and chops the thorny vines at each door.',
  mines: 'A dwarf visits the old mines one by one and smashes the crystal golems inside.',
} as const;

describe('P52 T5: strike in spatial quests', () => {
  it.each(Object.entries(QUEST))('%s: the sentence keeps strike, verification proves it and the intermediate bot uses it', (_name, text) => {
    const spec = draftGameSpecWithMeta(text, 1).spec;
    expect((spec.controlParams as { readonly generator?: string }).generator).toBe('quest_spatial');
    expect(spec.abilities).toEqual(['strike']);
    let used = 0;
    for (const seed of SEEDS) {
      const world = worldOf(spec, seed);
      expect(verifyArcade(world, ARCADE_LIBRARY).failures, `${seed}`).toEqual([]);
      if (firedAt(world, runBot(world, ARCADE_LIBRARY, { profile: 'intermediate' }), 'ability_strike') >= 0) used += 1;
    }
    expect(used / SEEDS.length).toBeGreaterThanOrEqual(0.9);
  }, 300_000);

  it('a quest takes strike only', () => {
    expect(ABILITIES.filter((id) => generatorTakes('quest_spatial', id))).toEqual(['strike']);
  });
});

/** Sběr v aréně s úderem a ochranou (P47B dev v13, v40): obě akce berou pronásledovatele a každá ho zničí. */
const ARENA = {
  dash: ["a stray dog ducks the butcher's cleaver and bites his ankles", ['dash', 'strike']],
  shield: ['a gladiator blocks spears with his shield and kicks the lions back', ['shield', 'strike']],
} as const;

const arenaSpec = (text: string, abilities: readonly AbilityId[]): GameSpecV1 => ({ ...draftGameSpecWithMeta(text, 1).spec, abilities: [...abilities] });

/** Kolik vln sběru přivede pronásledovatele (počty z `arena_waves`). */
const waveChasers = (world: ArcadeWorld): number[] =>
  ((world.rules.map(underlyingRule).find((rule) => rule.id === 'arena_waves')?.params.waves ?? []) as readonly { readonly chasers?: number }[]).map((wave) => wave.chasers ?? 0);

describe('P52 T5: arena collect with strike and a guard', () => {
  it.each(Object.entries(ARENA))('%s and strike: verification proves both on seed 1 and the intermediate bot uses both', (_name, [text, abilities]) => {
    const spec = arenaSpec(text, abilities);
    expect(spec.genre).toMatchObject({ id: 'arena', mode: 'collect' });
    expect(verifyArcade(worldOf(spec, 1), ARCADE_LIBRARY).failures).toEqual([]);
    let both = 0;
    for (const seed of SEEDS) {
      const world = worldOf(spec, seed);
      const run = runBot(world, ARCADE_LIBRARY, { profile: 'intermediate' });
      if (abilities.every((id) => firedAt(world, run, `ability_${id}`) >= 0)) both += 1;
    }
    expect(both / SEEDS.length).toBeGreaterThanOrEqual(0.6);
  }, 300_000);

  it('the first chaser wave brings one more chaser only for strike with a guard in genre.v5', () => {
    const [text] = ARENA.dash;
    expect(waveChasers(worldOf(arenaSpec(text, ['dash', 'strike']), 1))).toEqual([2, 0]);
    expect(waveChasers(worldOf(arenaSpec(text, ['strike']), 1))).toEqual([1, 0]);
    expect(waveChasers(worldOf(arenaSpec(text, ['dash']), 1))).toEqual([1, 0]);
    const v4 = arenaSpec(text, ['dash', 'strike']);
    expect(waveChasers(worldOf({ ...v4, genre: { ...v4.genre!, compilerVersion: 'genre.v4' } }, 1))).toEqual([1, 0]);
  });

  it('arena games without strike and a guard, and genre.v4, build the same world as before', () => {
    // Otisky změřené před T5 (část aréna): sběr s úderem, s dashem a dvojice ve `genre.v4`.
    const [text] = ARENA.dash;
    const v4 = arenaSpec(text, ['dash', 'strike']);
    const specs = [arenaSpec(text, ['strike']), arenaSpec(text, ['dash']), { ...v4, genre: { ...v4.genre!, compilerVersion: 'genre.v4' } }];
    expect(specs.map((spec) => canonicalHash(worldOf(spec, 1)))).toEqual(['5c0da6ca', '8e3d1b45', '6d1e1888']);
  });
});
