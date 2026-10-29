/**
 * Šipky (P66 T9): ťuk na kus s volnou cestou ho pošle pryč, ťuk na zatarasený kus stojí srdce; kola s rostoucí
 * mřížkou, výhra až po finále. Hlídá společné brány žánru P66:
 * - robot vyhraje, nečinný hráč prohraje, slabý robot (`mistakes`) prohraje – hra je vyhratelná i prohratelná;
 * - dvě přehrání téhož záznamu = týž hash, publikační brána (`verifyArcade`) projde na 10 semínkách;
 * - kombo za sérii bez nárazu jde přes `COMBO_SOURCES` nové hry (`hookedComboSources`, od `genre.v6`) – zatím
 *   netestovaná cesta, tady ji drží svět i hlášky háčků;
 * - klávesnice: šipky vlevo / vpravo posunou kurzor po kusech, mezerník ťukne na kus pod ním.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { arcadeWorldOf } from '../compile';
import { ARCADE_HZ, type ArcadeEffect, type ArcadeWorld, BODY, BUTTON, COMBO, COUNTER, FLAG, HEADER, type InputEvent, NO_INPUT, bodyBase, bodyHp, nativeRule } from '../contract';
import { hooksOf, roundOf } from '../hooks';
import { instantiate, loadProgram, outcomeOf, replay, step } from '../kernel';
import { ARCADE_LIBRARY, MODE_GENERATORS } from '../library';
import { ARROWS_RULES, type ArrowsTapParams, cursorOf, gridOfRound } from '../pieces/arrows';
import { arrowsBot, arrowsChoices } from '../pieces/arrows-bot';
import { ARROWS, arrowsSeconds, cellAt, dirOf, occupancy, roundGrids, totalPieces } from '../pieces/arrows-level';
import { axisOfCell } from '../pieces/lanes';
import { runBot, verifyArcade } from '../verify';
import { compileWith, readGenreSpec } from '../../genre/index';
import { arrowsGenre } from '../../genre/arrows';
import type { GenreModule, GenreSpec } from '../../genre/contract';
import { readGameSpec, type GameSpecV1 } from '../../spec';

const SEEDS = Array.from({ length: 10 }, (_, index) => index + 1);
/** Za horizont ověření: nečinný hráč prohraje na hodinách hry, ne až na horizontu. */
const LONG = 2 * ARCADE_HZ * 90;

/** Hra parkoviště jako ruční spec e2e (`e2e/fixtures/p66-arrows-spec.json`); `rounds` mění jen počet kol. */
function specOf(rounds?: number): GameSpecV1 {
  const content: GenreSpec = {
    genre: 'arrows',
    mode: 'default',
    hero: 'parking attendant',
    setting: 'parking lot',
    cast: [{ label: 'car', does: 'scenery' }],
    ...(rounds === undefined ? {} : { params: { rounds } }),
  };
  const read = readGenreSpec(content);
  if (!read.ok) throw new Error(read.issues.join('; '));
  return compileWith(arrowsGenre as GenreModule, read.value);
}

function worldOf(seed: number, rounds?: number): ArcadeWorld {
  const made = arcadeWorldOf(specOf(rounds), seed);
  if (!made.ok) throw new Error(made.issues.join('; '));
  return made.world;
}

const tapParams = (world: ArcadeWorld): ArrowsTapParams => nativeRule(world.rules, 'arrows_tap')!.params as ArrowsTapParams;
const keeperOf = (world: ArcadeWorld): number => hooksOf(world.rules)!.keeper as number;
const health = (state: Int32Array): number => state[HEADER.counters + COUNTER.health] as number;
const score = (state: Int32Array): number => state[HEADER.counters + COUNTER.score] as number;
const items = (state: Int32Array): number => state[HEADER.counters + COUNTER.items] as number;
const alive = (state: Int32Array, body: number): boolean => ((state[bodyBase(body) + BODY.flags] as number) & FLAG.alive) !== 0;

/** Hráč nad živým stavem: ťuky a klávesy po jednom tiku, efekty tiku zpět. */
function player(world: ArcadeWorld) {
  const program = loadProgram(world, ARCADE_LIBRARY);
  const state = instantiate(world);
  const tick = (input = NO_INPUT): readonly ArcadeEffect[] => step(state, input, program);
  const choices = () => arrowsChoices(state, { keeper: keeperOf(world), grids: tapParams(world).grids });
  const tapCell = (cell: number) => tick({ buttons: BUTTON.TAP, axis: axisOfCell(cell) });
  const bodyIn = (cell: number): number => {
    const round = roundOf(state, keeperOf(world));
    return (occupancy(state, round, gridOfRound(tapParams(world).grids, round))[cell] as number) - 1;
  };
  return { state, tick, choices, tapCell, bodyIn };
}

/** Konec přehrání záznamu se stavem. */
function finalState(world: ArcadeWorld, inputs: readonly InputEvent[], horizon = ARCADE_HZ * 90): Int32Array {
  const program = loadProgram(world, ARCADE_LIBRARY);
  const state = instantiate(world);
  let next = 0;
  for (let tick = 0; tick < horizon && outcomeOf(state) === 'running'; tick += 1) {
    while (next < inputs.length && (inputs[next] as InputEvent).tick < tick) next += 1;
    const event = inputs[next];
    step(state, event !== undefined && event.tick === tick ? event : NO_INPUT, program);
  }
  return state;
}

/** Svět se slabým robotem: týž svět, robot s `mistakes` ‰ ťuků na zatarasený kus. */
const weakened = (world: ArcadeWorld, mistakes: number): ArcadeWorld => ({ ...world, bot: { id: 'arrows_bot', params: { ...world.bot.params, mistakes } } });

describe('arrows genre is playable (P66 T9)', () => {
  it('compiles a valid spec through the arrows generator; T12 routes sentences to it (ready, cues)', () => {
    // P66 T12: živý pro výběr – narážky v modulu, buňka receptu v `PRESETS` (`p66-staged.test.ts`).
    expect(arrowsGenre.availability('default')).toBe('ready');
    expect(arrowsGenre.cues.length).toBeGreaterThan(0);
    expect(MODE_GENERATORS.arrows_grid?.id).toBe('arrows_grid');
    const spec = specOf();
    expect(readGameSpec(spec).ok).toBe(true);
    expect(spec.control).toBe('arrows');
    expect(spec.genre).toEqual({ id: 'arrows', mode: 'default', compilerVersion: 'genre.v6' });
    expect(spec.roles.find((role) => role.id === 'piece')).toMatchObject({ kind: 'target', label: 'car', count: totalPieces(ARROWS.rounds.default) });
    expect(spec.tutorial.goalLine.length).toBeLessThanOrEqual(50);
    expect(readGenreSpec({ genre: 'arrows', mode: 'default', hero: 'fox', setting: 'pen', params: { rounds: 6 } }).ok).toBe(false);
    // Ruční spec e2e je přesně překlad žánru – fixture se od modulu tiše neodchýlí.
    expect(JSON.parse(readFileSync(join(process.cwd(), 'e2e/fixtures/p66-arrows-spec.json'), 'utf8'))).toEqual(spec);
  });

  it('reads the pieces from the sentence: the thing it sends away comes first, a car without one', () => {
    for (const [sentence, label] of [
      ['tap the cars so they drive out of the jammed parking lot', 'car'],
      ['a shepherd frees the sheep from the pen', 'sheep'],
      ['clear the boats out of the harbor', 'boat'],
    ] as const) {
      expect(arrowsGenre.draftFill(sentence, null).cast?.[0], sentence).toEqual({ label, does: 'scenery' });
    }
    const plain = compileWith(arrowsGenre as GenreModule, { genre: 'arrows', mode: 'default', hero: 'fox', setting: 'forest' });
    expect(plain.roles.find((role) => role.id === 'piece')?.label).toBe('car');
  });

  it('the bot wins every round, a player who does nothing loses on the clock, two replays end in one hash', () => {
    for (const seed of SEEDS) {
      const world = worldOf(seed);
      const bot = runBot(world);
      expect(bot.outcome, `seed ${seed}`).toBe('won');
      const end = finalState(world, bot.inputs);
      expect(items(end)).toBe(totalPieces(ARROWS.rounds.default));
      expect(health(end)).toBe(3);
      expect(replay(world, bot.inputs, ARCADE_LIBRARY).hash).toBe(replay(world, bot.inputs, ARCADE_LIBRARY).hash);
      const idle = replay(world, [], ARCADE_LIBRARY, LONG);
      expect(idle.outcome, `seed ${seed}`).toBe('lost');
      expect(idle.tick).toBe(arrowsSeconds(ARROWS.rounds.default) * ARCADE_HZ + 1);
      expect(idle.tick).toBeLessThan(ARCADE_HZ * 90);
    }
  });

  it('a weak bot that taps blocked pieces loses its hearts on every seed', () => {
    for (const seed of SEEDS) {
      const run = runBot(weakened(worldOf(seed), 600));
      expect(run.outcome, `seed ${seed}`).toBe('lost');
      expect(health(finalState(weakened(worldOf(seed), 600), run.inputs))).toBe(0);
    }
  });

  it('passes the publish gate on 10 seeds, for 2 to 5 rounds', () => {
    for (const seed of SEEDS) {
      const verdict = verifyArcade(worldOf(seed));
      expect(verdict.failures, `seed ${seed}`).toEqual([]);
      expect(verdict.publishEligible).toBe(true);
    }
    for (const rounds of [ARROWS.rounds.min, 4, ARROWS.rounds.max]) {
      expect(verifyArcade(worldOf(3, rounds)).failures, `${rounds} rounds`).toEqual([]);
    }
  });

  it('a tap on a free piece sends exactly that piece away and scores; a tap on a blocked one costs a heart and keeps it', () => {
    const game = player(worldOf(4));
    game.tick();
    const { free, blocked } = game.choices();
    expect(free.length).toBeGreaterThan(0);
    expect(blocked.length).toBeGreaterThan(0);
    const stuck = blocked[0]!;
    const stuckBody = game.bodyIn(stuck);
    game.tapCell(stuck);
    expect(health(game.state)).toBe(2);
    expect(alive(game.state, stuckBody)).toBe(true);
    expect(items(game.state)).toBe(0);
    const cell = free[0]!;
    const body = game.bodyIn(cell);
    const others = Array.from({ length: game.state[HEADER.bodyCount] as number }, (_, index) => index).filter((index) => index !== body && alive(game.state, index));
    const effects = game.tapCell(cell);
    expect(alive(game.state, body)).toBe(false);
    expect(others.every((index) => alive(game.state, index))).toBe(true);
    expect(items(game.state)).toBe(1);
    expect(score(game.state)).toBe(ARROWS.points);
    expect(health(game.state)).toBe(2);
    // Létající skóre háčků visí nad odletěným kusem.
    expect(effects).toContainEqual({ kind: 'score_pop', amount: ARROWS.points, body });
    // Ťuk do prázdné buňky (té, odkud kus odletěl) nedělá nic.
    const before = game.state.slice();
    game.tapCell(cell);
    expect(health(game.state)).toBe(health(before));
    expect(score(game.state)).toBe(score(before));
  });

  it('only the running round counts: pieces of the next round cannot be tapped, the next grid starts after the break', () => {
    const world = worldOf(5);
    const game = player(world);
    const keeper = keeperOf(world);
    const grids = tapParams(world).grids;
    expect(grids).toEqual(roundGrids(ARROWS.rounds.default).map(({ cols, rows }) => ({ cols, rows })));
    game.tick();
    // Kus prvního kola v buňce, kterou druhé kolo taky má, je jen jeho; kusy kola 1 v ní nic nedělají.
    const clears: number[] = [];
    const starts: number[] = [];
    for (let tick = 1; tick < 3000 && outcomeOf(game.state) === 'running'; tick += 1) {
      const { free } = game.choices();
      const effects = free.length > 0 && tick % 3 === 0 && (game.state[bodyBase(keeper) + BODY.y] as number) === 0 ? game.tapCell(free[0]!) : game.tick();
      for (const effect of effects) {
        if (effect.kind === 'round_clear') clears.push(effect.round);
        if (effect.kind === 'round_start') starts.push(effect.round);
      }
    }
    expect(outcomeOf(game.state)).toBe('won');
    expect(clears).toEqual([0, 1, 2]);
    expect(starts).toEqual([1, 2]);
    expect(items(game.state)).toBe(totalPieces(ARROWS.rounds.default));
  });

  it('every piece of a round sits on its own cell with its own arrow code, round by round', () => {
    const world = worldOf(6);
    const state = instantiate(world);
    const grids = tapParams(world).grids;
    const perRound = grids.map(() => 0);
    for (let body = 1; body < (state[HEADER.bodyCount] as number); body += 1) {
      if (state[bodyBase(body) + BODY.role] !== 10) continue;
      const code = bodyHp(state, body);
      const round = Math.floor((code - 1) / 4);
      expect(cellAt(grids[round]!, state[bodyBase(body) + BODY.x] as number, state[bodyBase(body) + BODY.z] as number)).toBeGreaterThanOrEqual(0);
      expect(dirOf(state, body)).toBeLessThan(4);
      perRound[round] += 1;
    }
    expect(perRound).toEqual(roundGrids(ARROWS.rounds.default).map((grid) => grid.pieces));
  });
});

describe('arrows combo comes through the new-genre combo sources (P66 T9, genre.v6)', () => {
  it('the compiled world hands its combo keeper to arrows_tap and to the hooks', () => {
    const world = worldOf(2);
    const combo = tapParams(world).combo;
    expect(combo).toBeDefined();
    expect(hooksOf(world.rules)?.combo).toBe(combo);
    expect(ARROWS_RULES.arrows_tap!.params.safeParse({ ...tapParams(world), combo: 1 }).success).toBe(true);
  });

  it('flights in a row multiply the score and call the combo out; a bump drops it back to ×1', () => {
    const game = player(worldOf(2));
    game.tick();
    const callouts: string[] = [];
    const gains: number[] = [];
    for (let flight = 0; flight < 4; flight += 1) {
      const before = score(game.state);
      const effects = game.tapCell(game.choices().free[0]!);
      gains.push(score(game.state) - before);
      for (const effect of effects) if (effect.kind === 'callout') callouts.push(effect.callout);
      if (effects.some((effect) => effect.kind === 'round_clear')) break;
    }
    expect(gains.slice(0, 3)).toEqual([ARROWS.points, 2 * ARROWS.points, 3 * ARROWS.points]);
    expect(callouts).toEqual(expect.arrayContaining(['combo_2', 'combo_3']));
    expect(COMBO.max).toBeGreaterThanOrEqual(3);
  });

  it('after a bump the next flight scores ×1 again', () => {
    const game = player(worldOf(4));
    game.tick();
    game.tapCell(game.choices().free[0]!);
    game.tapCell(game.choices().free[0]!);
    const blocked = game.choices().blocked[0];
    expect(blocked).toBeDefined();
    game.tapCell(blocked!);
    const before = score(game.state);
    game.tapCell(game.choices().free[0]!);
    expect(score(game.state) - before).toBe(ARROWS.points);
  });
});

describe('arrows on the keyboard (P66 T9)', () => {
  it('Space shows the cursor on the first piece, arrows move it piece by piece, Space taps the piece under it', () => {
    const world = worldOf(3);
    const game = player(world);
    const p = world.initial[HEADER.player] as number;
    game.tick({ buttons: BUTTON.TAP, axis: 0 });
    const first = cursorOf(game.state, p);
    expect(first).toBeGreaterThan(0);
    expect(items(game.state)).toBe(0);
    expect(health(game.state)).toBe(3);
    game.tick({ buttons: BUTTON.RIGHT, axis: 0 });
    const second = cursorOf(game.state, p);
    expect(second).toBeGreaterThan(first);
    game.tick({ buttons: BUTTON.LEFT, axis: 0 });
    expect(cursorOf(game.state, p)).toBe(first);
    // Kurzor na první volný kus a mezerník: odletí právě on.
    const target = game.choices().free[0]!;
    for (let guard = 0; guard < 40 && cursorOf(game.state, p) !== target + 1; guard += 1) game.tick({ buttons: BUTTON.RIGHT, axis: 0 });
    expect(cursorOf(game.state, p)).toBe(target + 1);
    const body = game.bodyIn(target);
    game.tick({ buttons: BUTTON.TAP, axis: 0 });
    expect(alive(game.state, body)).toBe(false);
    expect(items(game.state)).toBe(1);
    // Kus pod kurzorem odletěl: kurzor skočí na další kus.
    game.tick();
    const next = cursorOf(game.state, p);
    expect(next).toBeGreaterThan(0);
    expect(game.bodyIn(next - 1)).toBeGreaterThan(0);
  });

  it('the world bot is the arrows bot at a player pace, and it never taps the same piece twice', () => {
    const world = worldOf(1);
    expect(world.bot.id).toBe('arrows_bot');
    expect(arrowsBot.params.parse(world.bot.params).mistakes).toBe(0);
    const run = runBot(world);
    const taps = run.inputs.filter((input) => (input.buttons & BUTTON.TAP) !== 0);
    expect(taps).toHaveLength(totalPieces(ARROWS.rounds.default));
    for (let index = 1; index < taps.length; index += 1) expect(taps[index]!.tick - taps[index - 1]!.tick).toBeGreaterThanOrEqual(arrowsBot.reactionTicks + 1);
  });
});
