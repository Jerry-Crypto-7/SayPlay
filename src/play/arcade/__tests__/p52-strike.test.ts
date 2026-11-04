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
import { ABILITIES, type AbilityId, type ArcadeWorld, BODY, COUNTER, FLAG, HEADER, ROLE, bodyBase, nativeRule, underlyingRule } from '../contract';
import { instantiate } from '../kernel';
import { ARCADE_LIBRARY } from '../library';
import { loadRapier } from '../physics/world';
import { WAVE_COUNTER, type WaveParams, arenaWaves } from '../pieces/waves';
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

const wins = (spec: GameSpecV1, profile: BotProfile, seeds: readonly number[] = SEEDS): number =>
  seeds.filter((seed) => runBot(worldOf(spec, seed), ARCADE_LIBRARY, { profile }).outcome === 'won').length / seeds.length;

/** Brána obtížnosti (P41): novice 0,3–0,7, intermediate aspoň 0,8. */
function expectBalanced(spec: GameSpecV1): void {
  expect(wins(spec, 'intermediate'), 'intermediate').toBeGreaterThanOrEqual(0.8);
  const novice = wins(spec, 'novice');
  expect(novice, 'novice').toBeGreaterThanOrEqual(0.3);
  expect(novice, 'novice').toBeLessThanOrEqual(0.7);
}

/** Vlny světa: doplnění zničených a kolik pronásledovatelů která vlna přivede (`arena_waves`). */
function waves(world: ArcadeWorld): { readonly restock: number | undefined; readonly chasers: number[] } {
  const params = world.rules.map(underlyingRule).find((rule) => rule.id === 'arena_waves')?.params as { readonly restock?: number; readonly waves: readonly { readonly chasers?: number }[] };
  return { restock: params.restock, chasers: params.waves.map((wave) => wave.chasers ?? 0) };
}

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

  // Bez doplnění úder zabil jediného pronásledovatele a novice vyhrál 9/10 (bez úderu 6/10).
  it.each(Object.entries(QUEST))('%s: novice stays in the band and intermediate wins', (_name, text) => {
    expectBalanced(draftGameSpecWithMeta(text, 1).spec);
  }, 300_000);

  it('a quest with strike restocks struck chasers and brings one more in round two, only in genre.v5', () => {
    const spec = draftGameSpecWithMeta(QUEST.towers, 1).spec;
    // Kola questu: jeden pronásledovatel od startu, vlny žádného dalšího.
    expect(waves(worldOf(spec, 1))).toEqual({ restock: 1, chasers: [1, 0] });
    expect(waves(worldOf({ ...spec, abilities: undefined }, 1))).toEqual({ restock: undefined, chasers: [0, 0] });
    expect(waves(worldOf({ ...spec, genre: { ...spec.genre!, compilerVersion: 'genre.v4' } }, 1))).toEqual({ restock: undefined, chasers: [0, 0] });
  });

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

  // Bez doplnění a vln navíc vyhrál novice s dashem a úderem 9/10 (bez akcí 4/10).
  it.each(Object.entries(ARENA))('%s and strike: novice stays in the band and intermediate wins', (_name, [text, abilities]) => {
    expectBalanced(arenaSpec(text, abilities));
  }, 300_000);

  // T5-R1: úder sám zabil jediného pronásledovatele sběru a zbytek hry byl prázdný – novice 17/20 (bez akce 9/20).
  it.each([
    ['the test sentence', arenaSpec(ARENA.dash[0], ['strike'])],
    // P54C T13: d01 sbírá kapky do sklenice („in a jar“) – hraje žánr chytání; sběr s úderem drží táž věta bez sklenice.
    ['d01', draftGameSpecWithMeta('a kid catches raindrops on the porch and kicks away the hailstones', 1).spec],
  ])('collect with strike alone (%s): novice stays in the band and intermediate wins on seeds 1–20', (_name, spec) => {
    expect(spec.genre).toMatchObject({ id: 'arena', mode: 'collect' });
    expect(spec.abilities).toEqual(['strike']);
    const seeds = Array.from({ length: 20 }, (_, index) => index + 1);
    expect(wins(spec, 'intermediate', seeds), 'intermediate').toBeGreaterThanOrEqual(0.8);
    const novice = wins(spec, 'novice', seeds);
    expect(novice, 'novice').toBeGreaterThanOrEqual(0.3);
    expect(novice, 'novice').toBeLessThanOrEqual(0.7);
  }, 300_000);

  it('every chaser wave brings one more for strike with a guard, strike alone only restocks, in genre.v5', () => {
    const [text] = ARENA.dash;
    expect(waves(worldOf(arenaSpec(text, ['dash', 'strike']), 1))).toMatchObject({ restock: 0, chasers: [2, 1] });
    expect(waves(worldOf(arenaSpec(text, ['shield', 'strike']), 1))).toMatchObject({ restock: 0, chasers: [2, 1] });
    expect(waves(worldOf(arenaSpec(text, ['strike']), 1))).toMatchObject({ restock: 0, chasers: [1, 0] });
    expect(waves(worldOf(arenaSpec(text, ['dash']), 1))).toMatchObject({ restock: undefined, chasers: [1, 0] });
    for (const abilities of [['dash', 'strike'], ['strike']] as const) {
      const v4 = arenaSpec(text, abilities);
      expect(waves(worldOf({ ...v4, genre: { ...v4.genre!, compilerVersion: 'genre.v4' } }, 1))).toMatchObject({ restock: undefined, chasers: [1, 0] });
    }
  });

  it('a wave restocks the chasers the hero destroyed, a wave without restock does not', () => {
    const world = worldOf(arenaSpec(ARENA.dash[0], ['dash', 'strike']), 1);
    const state = instantiate(world);
    const player = 0;
    const params = nativeRule(world.rules, 'arena_waves')!.params as WaveParams;
    // Všechny věci první vlny sebrané a pronásledovatelé druhé vlny zničení: čeká se na třetí.
    for (let i = 0; i < (state[HEADER.bodyCount] as number); i += 1) {
      const role = state[bodyBase(i) + BODY.role];
      if (role === ROLE.collectible || role === ROLE.chaser) state[bodyBase(i) + BODY.flags] = (state[bodyBase(i) + BODY.flags] as number) & ~FLAG.alive;
    }
    state[HEADER.counters + COUNTER[WAVE_COUNTER]] = 1;
    const chasers = (rule: WaveParams): number =>
      arenaWaves.fire({ state, player, other: -1, source: -1 } as never, rule).filter((effect) => effect.kind === 'spawn' && effect.template === rule.chaser).length;
    expect(chasers(params)).toBe(1 + 2);
    const { restock: _restock, ...plain } = params;
    expect(chasers(plain)).toBe(1);
  });

  it('arena games without strike and a guard, and genre.v4, build the same world as before', () => {
    // Otisky změřené před T5 (část aréna): sběr s dashem a dvojice ve `genre.v4`; úder sám ve `genre.v4` z T5-R1.
    // Sběr jen s úderem ve `genre.v5` se v T5-R1 vědomě posunul (5c0da6ca → doplnění zničených).
    const [text] = ARENA.dash;
    const v4 = (abilities: readonly AbilityId[]): GameSpecV1 => {
      const spec = arenaSpec(text, abilities);
      return { ...spec, genre: { ...spec.genre!, compilerVersion: 'genre.v4' } };
    };
    const specs = [arenaSpec(text, ['strike']), arenaSpec(text, ['dash']), v4(['dash', 'strike']), v4(['strike'])];
    // Nová hra (`genre.v6`) přeotisknuta v P66 T10 a T10a: pravidlo háčků (létající skóre) bez počítadla; `genre.v4` beze změny.
    // Férový start (P70A T3, `genre.v8`) nese každá nová hra; otisk je bez něj, test hlídá úder a stráž.
    const plain = ({ fairStart: _fair, ...world }: ArcadeWorld): ArcadeWorld => world;
    expect(specs.map((spec) => canonicalHash(plain(worldOf(spec, 1))))).toEqual(['c369830f', '09b77a69', '6d1e1888', '250a2f1b']);
  });
});
