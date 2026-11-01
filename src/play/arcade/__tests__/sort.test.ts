/**
 * Třídění (P66 T8): hra z věty se otevře, robot ji vyhraje, nečinný i slabý robot prohrají, přehrání se shoduje
 * a publikační brána projde. K tomu pravidla, která rozhodují bez dozoru: odkladiště (plné = prohra, věc přeskočí
 * do nádoby, která přijede), hodiny kola, kola háčků, kombo (pravidlo nového žánru je zdroj komba od `genre.v6`)
 * a vzácnost věcí. Řešitelnost úrovní drží `sort-level.test.ts`.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { arcadeWorldOf, compileArcade } from '../compile';
import { ARCADE_HZ, type ArcadeEffect, type ArcadeInput, type ArcadeWorld, BODY, BUTTON, FLAG, HEADER, type InputEvent, NO_INPUT, bodyBase, nativeRule, targetStateOf } from '../contract';
import { completeHooks, foundOf, hooksOf } from '../hooks';
import { buildWorld, instantiate, loadProgram, outcomeOf, replay, step } from '../kernel';
import { ARCADE_LIBRARY } from '../library';
import { LANE_START, axisOfLane, laneOf } from '../pieces/lanes';
import { type SortGame, boardOfState, sortPartsOf } from '../pieces/sort';
import { slipAt } from '../pieces/sort-bot';
import { SORT, SORT_BUFFERED, SORT_LAYOUT, type SortRound, firstLane, rowZ, slotX } from '../pieces/sort-level';
import { runBot, verifyArcade } from '../verify';
import { readGenreSpec } from '../../genre/index';
import { SORT_DEFAULTS, sortGenre } from '../../genre/sort';
import type { GameSpecV1 } from '../../spec';

const IDEA = { genre: 'sort', mode: 'default', hero: 'fox', setting: 'toy shop', cast: [{ label: 'teddy bear', does: 'collect' }, { label: 'rubber duck', does: 'collect' }, { label: 'ball', does: 'collect' }] };
const FIXTURE = JSON.parse(readFileSync(join(process.cwd(), 'e2e/fixtures/p66-sort-spec.json'), 'utf8')) as GameSpecV1;
const SEEDS = Array.from({ length: 20 }, (_, index) => index + 1);

function specOf(input: object = IDEA): GameSpecV1 {
  const read = readGenreSpec(input);
  if (!read.ok) throw new Error(read.issues.join('; '));
  return sortGenre.compile(read.value as never);
}

function worldOf(seed: number, spec: GameSpecV1 = FIXTURE): ArcadeWorld {
  const made = arcadeWorldOf(spec, seed);
  if (!made.ok) throw new Error(made.issues.join('; '));
  return made.world;
}

const gameOf = (world: ArcadeWorld): SortGame => nativeRule(world.rules, 'sort_tap')!.params as unknown as SortGame;

/** Ťuk do fronty `queue` kola `round`. */
const tapOf = (game: SortGame, round: number, queue: number): ArcadeInput => ({ buttons: BUTTON.TAP, axis: axisOfLane(firstLane((game.rounds[round] as SortGame['rounds'][number]).queues) + queue) });

/** Odehraje záznam a vrátí stav i efekty každého tiku. */
function play(world: ArcadeWorld, inputs: readonly InputEvent[], horizon = 6000): { readonly state: Int32Array; readonly ticks: (readonly ArcadeEffect[])[] } {
  const program = loadProgram(world, ARCADE_LIBRARY);
  const state = instantiate(world);
  const ticks: (readonly ArcadeEffect[])[] = [];
  let next = 0;
  for (let tick = 0; tick < horizon && outcomeOf(state) === 'running'; tick += 1) {
    while (next < inputs.length && (inputs[next] as InputEvent).tick < tick) next += 1;
    const event = inputs[next];
    ticks.push(step(state, event !== undefined && event.tick === tick ? event : NO_INPUT, program));
  }
  return { state, ticks };
}

/** Malý svět z ručních kol, s počítadlem komba jako hra žánru (`withCombo`); ťuky v ticích `at`. */
function handWorld(rounds: readonly SortRound[], slots: number): ArcadeWorld {
  const parts = sortPartsOf(1, rounds, slots);
  expect(parts.issues).toEqual([]);
  const combo = parts.level.bodies.length;
  const counter = { role: 'thing' as const, kind: 'player', x: 0, y: 0, z: 0, w: 1, h: 1, d: 1, solid: false, template: true };
  const rules = completeHooks(parts.rules.map((rule) => (rule.id === 'sort_tap' ? { ...rule, params: { ...rule.params, combo } } : rule)));
  const built = buildWorld({ seed: 1, control: parts.control, rules, bot: parts.bot, level: { ...parts.level, bodies: [...parts.level.bodies, counter] } }, ARCADE_LIBRARY);
  if (!built.ok) throw new Error(built.issues.join('; '));
  return built.world;
}

/** Jedno kolo: vidět je jen nádoba druhu 0, fronta 0 nese druh 1, fronta 1 druh 0. */
const SHELF_ROUND: SortRound = { bins: [0, 1], show: 1, queues: [[1, 1, 1], [0, 0, 0]], kinds: 2 };
const taps = (world: ArcadeWorld, queues: readonly number[], gap = 2): InputEvent[] => queues.map((queue, index) => ({ tick: 1 + index * gap, ...tapOf(gameOf(world), 0, queue) }));

describe('sort as a game (P66 T8)', () => {
  it('the e2e fixture is the compiled game of its idea, saved as genre.v6', () => {
    // Fixture je uložená hra `genre.v6` (otisk `p68-hash.test.ts` ji tak drží); P68 T1 zvedl jen verzi nových her.
    const spec = specOf();
    expect({ ...spec, genre: { ...spec.genre, compilerVersion: 'genre.v6' } }).toEqual(FIXTURE);
  });

  it('passes the publish gate on 10 seeds', () => {
    for (const seed of SEEDS.slice(0, 10)) {
      const compiled = compileArcade(FIXTURE, seed);
      expect(compiled.ok, `seed ${seed}`).toBe(true);
      const made = arcadeWorldOf(FIXTURE, seed);
      if (!made.ok) throw new Error(made.issues.join('; '));
      const verdict = verifyArcade(made.world, undefined, made.roleBindings);
      expect(verdict.failures, `seed ${seed}`).toEqual([]);
      expect(verdict.publishEligible).toBe(true);
    }
  });

  it('the bot wins every seed in 30–90 s with each round under its own clock; the idle player loses on the round clock', () => {
    for (const seed of SEEDS) {
      const world = worldOf(seed);
      const clocks = gameOf(world).rounds.map((round) => round.ticks);
      const bot = runBot(world);
      expect(bot.outcome, `seed ${seed}`).toBe('won');
      expect(bot.tick / ARCADE_HZ).toBeGreaterThanOrEqual(30);
      expect(bot.tick / ARCADE_HZ).toBeLessThanOrEqual(90);
      const { ticks } = play(world, bot.inputs);
      const starts = ticks.flatMap((effects, tick) => (effects.some((effect) => effect.kind === 'round_start') ? [tick] : []));
      const clears = ticks.flatMap((effects, tick) => (effects.some((effect) => effect.kind === 'round_clear') ? [tick] : []));
      expect(starts).toHaveLength(3);
      expect(clears).toHaveLength(3);
      clears.forEach((clear, round) => expect(clear - (starts[round] as number), `seed ${seed} round ${round + 1}`).toBeLessThan(clocks[round] as number));
      // Hodiny kol z horizontu podle věcí (T5a): 9 / 15 / 21 věcí → 1044 / 1740 / 2436 tiků, ne minuta na kolo.
      expect(clocks).toEqual([1044, 1740, 2436]);
      const idle = replay(world, [], ARCADE_LIBRARY);
      expect(idle.outcome).toBe('lost');
      expect(idle.tick).toBe(clocks[0]);
    }
  });

  it('two replays of the bot record end in the same state, and another record in another one', () => {
    const world = worldOf(3);
    const bot = runBot(world);
    const first = replay(world, bot.inputs, ARCADE_LIBRARY);
    const second = replay(world, bot.inputs, ARCADE_LIBRARY);
    expect(first.hash).toBe(second.hash);
    expect(first.hash).toBe(bot.hash);
    expect(replay(world, bot.inputs.slice(0, -1), ARCADE_LIBRARY).hash).not.toBe(first.hash);
  });

  it('a weak bot loses: one that sends a wrong item whenever it can loses all 10 seeds, one that slips every other tap most of them', () => {
    const weak = (world: ArcadeWorld, mistakes: number) => runBot({ ...world, bot: { id: 'sort_bot', params: { ...world.bot.params, mistakes } } });
    const worlds = SEEDS.slice(0, 10).map((seed) => worldOf(seed));
    expect(worlds.map((world) => weak(world, 1000).outcome)).toEqual(new Array(10).fill('lost'));
    expect(worlds.filter((world) => weak(world, 500).outcome === 'lost').length).toBeGreaterThanOrEqual(6);
  });

  it('mistakes of the weak bot fall evenly: every n-th tap at 1000 / n per mille', () => {
    const at = (mistakes: number): number[] => Array.from({ length: 12 }, (_, tap) => tap).filter((tap) => slipAt(tap, mistakes));
    expect(at(0)).toEqual([]);
    expect(at(500)).toEqual([1, 3, 5, 7, 9, 11]);
    expect(at(334).length).toBe(4);
    expect(at(1000)).toHaveLength(12);
  });

  it('rounds 2 and 5 play too: the bot wins in time, the idle player loses', () => {
    for (const rounds of [2, 5]) {
      const world = worldOf(4, specOf({ ...IDEA, params: { rounds } }));
      expect(hooksOf(world.rules)?.rounds).toBe(rounds);
      const bot = runBot(world);
      expect(bot.outcome, `${rounds} rounds`).toBe('won');
      expect(bot.tick).toBeLessThan(90 * ARCADE_HZ);
      expect(replay(world, [], ARCADE_LIBRARY).outcome).toBe('lost');
    }
  });
});

describe('sort hooks: combo, rarity, rounds', () => {
  it('the sort rule is the combo source of a genre.v6 game: streaks climb to ×3 and more with callouts', () => {
    const world = worldOf(2);
    const combo = gameOf(world) as SortGame & { readonly combo?: number };
    expect(combo.combo).toBeDefined();
    expect(hooksOf(world.rules)?.combo).toBe(combo.combo);
    const { ticks } = play(world, runBot(world).inputs);
    const effects = ticks.flat();
    expect(Math.max(...effects.flatMap((effect) => (effect.kind === 'combo' ? [effect.multiplier] : [])))).toBeGreaterThanOrEqual(3);
    const callouts = new Set(effects.flatMap((effect) => (effect.kind === 'callout' ? [effect.callout] : [])));
    for (const callout of ['combo_2', 'combo_3', 'round_clear']) expect(callouts.has(callout as never), callout).toBe(true);
  });

  it('a right tap raises the streak, a tap onto the shelf drops it to zero', () => {
    const world = handWorld([SHELF_ROUND], 3);
    const combo = (gameOf(world) as SortGame & { readonly combo: number }).combo;
    const { ticks } = play(world, taps(world, [1, 1, 0]));
    const streak = ticks.flat().flatMap((effect) => (effect.kind === 'combo' && effect.body === combo ? [effect.multiplier] : []));
    expect(streak).toEqual([1, 2, 0]);
  });

  it('every sorted item is a find with a rarity; rare and epic finds show up across seeds', () => {
    let rare = 0;
    let epic = 0;
    for (const seed of SEEDS.slice(0, 8)) {
      const world = worldOf(seed);
      const hooks = hooksOf(world.rules)!;
      expect(hooks.rarity).toBeDefined();
      const { state } = play(world, runBot(world).inputs);
      const found = foundOf(state, hooks.keeper as number);
      expect(found.common + found.rare + found.epic).toBe(state[HEADER.counters + 5]);
      rare += found.rare;
      epic += found.epic;
    }
    expect(rare).toBeGreaterThan(0);
    expect(epic).toBeGreaterThan(0);
  });

  it('the next round waits behind the scene until its round starts, then steps onto the board', () => {
    const world = worldOf(5);
    const game = gameOf(world);
    const second = game.rounds[1] as SortGame['rounds'][number];
    const start = instantiate(world);
    expect(start[bodyBase(second.start) + BODY.z]).toBeGreaterThanOrEqual(SORT_LAYOUT.waitZ);
    const bot = runBot(world);
    const { ticks, state } = play(world, bot.inputs, 6000);
    expect(outcomeOf(state)).toBe('won');
    const begun = ticks.findIndex((effects) => effects.some((effect) => effect.kind === 'round_start' && effect.round === 1));
    const after = play(world, bot.inputs, begun + 2).state;
    expect(after[bodyBase(second.start) + BODY.z]).toBeLessThan(SORT_LAYOUT.waitZ);
  });
});

describe('sort rules', () => {
  it('a head with no open bin goes to the shelf; the full shelf loses', () => {
    const world = handWorld([SHELF_ROUND], 2);
    const { state, ticks } = play(world, taps(world, [0, 0]));
    const first = (gameOf(world).rounds[0] as SortGame['rounds'][number]).start;
    expect(ticks.flat()).toContainEqual({ kind: 'stateChange', body: first, state: SORT_BUFFERED });
    expect(outcomeOf(state)).toBe('lost');
    expect(ticks.length).toBe(4);
  });

  it('a filled bin leaves and the shelved items of the next bin jump into it on their own', () => {
    const world = handWorld([SHELF_ROUND], 3);
    const start = (gameOf(world).rounds[0] as SortGame['rounds'][number]).start;
    const { state, ticks } = play(world, taps(world, [0, 0, 1, 1, 1, 0]));
    expect(outcomeOf(state)).toBe('won');
    const despawned = ticks.flat().flatMap((effect) => (effect.kind === 'despawn' ? [effect.body] : []));
    // Třetí věc druhu 0 doplní nádobu 0, přijede nádoba 1 a obě odložené věci druhu 1 do ní přeskočí v témž tiku.
    expect(despawned).toEqual([start + 3, start + 4, start + 5, start, start + 1, start + 2]);
    expect(state[HEADER.counters + 5]).toBe(6);
  });

  it('the round clock ends a round that is not cleared within its minute', () => {
    const world = handWorld([SHELF_ROUND], 3);
    const { state, ticks } = play(world, taps(world, [1]), 4000);
    expect(outcomeOf(state)).toBe('lost');
    expect(ticks.length).toBe(SORT.roundSeconds * ARCADE_HZ);
  });

  it('the arrows choose among the queues of the round only, and Space taps the chosen one', () => {
    const world = handWorld([{ bins: [0, 1, 2], show: 3, queues: [[0, 0, 0], [1, 1, 1], [2, 2, 2]], kinds: 3 }], 3);
    const game = gameOf(world);
    const program = loadProgram(world, ARCADE_LIBRARY);
    const state = instantiate(world);
    const player = state[HEADER.player] as number;
    expect(laneOf(state, player)).toBe(LANE_START);
    for (let press = 0; press < 4; press += 1) step(state, { buttons: BUTTON.LEFT, axis: 0 }, program);
    expect(laneOf(state, player)).toBe(firstLane(3));
    step(state, { buttons: BUTTON.TAP, axis: 0 }, program);
    expect(boardOfState(state, game, 0).binned).toEqual([1, 0, 0, 0, 0]);
    for (let press = 0; press < 4; press += 1) step(state, { buttons: BUTTON.RIGHT, axis: 0 }, program);
    expect(laneOf(state, player)).toBe(firstLane(3) + 2);
    step(state, { buttons: BUTTON.TAP, axis: 0 }, program);
    expect(boardOfState(state, game, 0).binned).toEqual([1, 0, 1, 0, 0]);
  });

  it('the next head steps to the front row and a shelved item sits on the shelf', () => {
    const world = handWorld([SHELF_ROUND], 3);
    const start = (gameOf(world).rounds[0] as SortGame['rounds'][number]).start;
    const { state } = play(world, [...taps(world, [0]), { tick: 4, buttons: 0, axis: 0 }], 5);
    const at = (body: number, slot: number): number => state[bodyBase(body) + slot] as number;
    expect(targetStateOf(state, start)).toBe(SORT_BUFFERED);
    expect([at(start, BODY.z), at(start, BODY.x)]).toEqual([SORT_LAYOUT.bufferZ, slotX(0, 3)]);
    expect(at(start + 1, BODY.z)).toBe(rowZ(0));
    expect(at(start + 2, BODY.z)).toBe(rowZ(1));
    expect((at(start + 3, BODY.flags) & FLAG.alive) !== 0).toBe(true);
  });
});

describe('sort genre module', () => {
  it('reads the listed things of the idea and drops foes', () => {
    const fill = sortGenre.draftFill('a robot sorts socks, books and apples into baskets while a cat watches', null);
    expect(fill.cast?.slice(0, 3)).toEqual([
      { label: 'sock', does: 'collect' },
      { label: 'book', does: 'collect' },
      { label: 'apple', does: 'collect' },
    ]);
    expect(fill.cast?.every((item) => item.does === 'collect' || item.does === 'scenery')).toBe(true);
  });

  it('gives five kinds that cycle over the things of the idea; one thing sorts by color, none takes the toy defaults', () => {
    const labels = (spec: GameSpecV1): string[] => spec.roles.filter((role) => role.kind === 'collectible').map((role) => role.label);
    expect(labels(FIXTURE)).toEqual(['teddy bear', 'rubber duck', 'ball', 'teddy bear', 'rubber duck']);
    const one = specOf({ ...IDEA, cast: [{ label: 'gem', does: 'collect' }] });
    expect(labels(one)).toEqual(new Array(5).fill('gem'));
    expect(one.tutorial.goalLine).toBe('Sort the gems by color!');
    expect(labels(specOf({ ...IDEA, cast: [] }))).toEqual([...SORT_DEFAULTS.items, ...SORT_DEFAULTS.items].slice(0, 5));
  });

  it('keeps items and rounds inside their bounds', () => {
    expect(readGenreSpec({ ...IDEA, params: { rounds: 6 } }).ok).toBe(false);
    expect(readGenreSpec({ ...IDEA, params: { rounds: 1 } }).ok).toBe(false);
    expect(readGenreSpec({ ...IDEA, params: { items: 61 } }).ok).toBe(false);
    expect(readGenreSpec({ ...IDEA, params: { items: 30, rounds: 5 } }).ok).toBe(true);
  });

  it('the replay path draws no wall-clock time and no global random', () => {
    for (const file of ['sort.ts', 'sort-bot.ts', 'sort-level.ts']) {
      const source = readFileSync(join(process.cwd(), 'src/play/arcade/pieces', file), 'utf8');
      expect(source, file).not.toMatch(/Math\.random|Date\.now|performance\.now/);
    }
  });
});
