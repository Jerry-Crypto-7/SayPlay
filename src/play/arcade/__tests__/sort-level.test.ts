/**
 * Úrovně třídění (P66 T8, pin): generátor staví kolo od vyřešeného stavu pozpátku, takže každá úroveň musí jít
 * vyřešit. Úroveň, která by občas vyšla neřešitelná, projde okem na pěti semínkách – tady ji chytí řešič na 200
 * semínkách přes všechny meze (2–5 kol, 30–60 věcí) a táž řešení zahraná skutečným jádrem vyhrají.
 *
 * Řešič (`solveBoard`) je na generátoru nezávislý: řešení generátoru nezná, prohledá tahy kola podle pravidel hry.
 */

import { describe, expect, it } from 'vitest';

import { arcadeWorldOf } from '../compile';
import { type ArcadeInput, type ArcadeWorld, BUTTON, NO_INPUT, nativeRule } from '../contract';
import { inBreak, roundOf } from '../hooks';
import { instantiate, loadProgram, outcomeOf, step } from '../kernel';
import { ARCADE_LIBRARY } from '../library';
import { axisOfLane } from '../pieces/lanes';
import { type SortGame } from '../pieces/sort';
import {
  SORT,
  SORT_STAGES,
  type SortBoard,
  binsPerRound,
  boardOfRound,
  firstLane,
  solveBoard,
  sortRound,
  sortRounds,
  stageOf,
  tapQueue,
  visibleBins,
} from '../pieces/sort-level';
import { sortGenre } from '../../genre/sort';

const SEEDS = Array.from({ length: 200 }, (_, index) => index + 1);
/** Semínko → meze hry: kola 2–5 a věci 30 / 45 / 60 se střídají, ať 200 her pokryje všechny kombinace. */
const configOf = (seed: number): { readonly items: number; readonly rounds: number } => ({ items: [30, 45, 60][seed % 3] as number, rounds: 2 + (seed % 4) });

function worldOf(seed: number): ArcadeWorld {
  const { items, rounds } = configOf(seed);
  const spec = sortGenre.compile({ genre: 'sort', mode: 'default', hero: 'fox', setting: 'toy shop', params: { items, rounds } });
  const made = arcadeWorldOf(spec, seed);
  if (!made.ok) throw new Error(made.issues.join('; '));
  return made.world;
}

/** Zahraje řešení kol (`plans[kolo]` = fronty v pořadí ťuků) skutečným jádrem, ťuk každý tik mimo přestávku. */
function playPlans(world: ArcadeWorld, plans: readonly (readonly number[])[]): { readonly outcome: string; readonly tick: number } {
  const game = nativeRule(world.rules, 'sort_tap')!.params as unknown as SortGame;
  const program = loadProgram(world, ARCADE_LIBRARY);
  const state = instantiate(world);
  const next = plans.map(() => 0);
  for (let tick = 0; tick < 20_000 && outcomeOf(state) === 'running'; tick += 1) {
    let input: ArcadeInput = NO_INPUT;
    if (!inBreak(state, game.keeper)) {
      const round = roundOf(state, game.keeper);
      const queue = plans[round]?.[next[round] as number];
      if (queue !== undefined) {
        next[round] = (next[round] as number) + 1;
        input = { buttons: BUTTON.TAP, axis: axisOfLane(firstLane((game.rounds[round] as SortGame['rounds'][number]).queues) + queue) };
      }
    }
    step(state, input, program);
  }
  return { outcome: outcomeOf(state), tick: state[0] as number };
}

/** Kolo z ručně psaných front (čelo první) a pořadí nádob. */
const handBoard = (queues: readonly (readonly number[])[], bins: readonly number[], show: number, slots: number): SortBoard =>
  boardOfRound({ bins, show, queues, kinds: Math.max(...bins) + 1 }, slots);

describe('sort levels are solvable by construction (P66 T8 pin)', () => {
  it('the solver clears every round of 200 generated games, across 2–5 rounds and 30–60 items', () => {
    const unsolved: string[] = [];
    let rounds = 0;
    for (const seed of SEEDS) {
      const { items, rounds: count } = configOf(seed);
      sortRounds(seed, items, count).forEach((round, index) => {
        rounds += 1;
        if (solveBoard(boardOfRound(round)) === null) unsolved.push(`seed ${seed} round ${index + 1}`);
      });
    }
    expect(unsolved).toEqual([]);
    expect(rounds).toBe(700);
  });

  it('the same solutions played through the real kernel win all 200 games', () => {
    const lost: string[] = [];
    for (const seed of SEEDS) {
      const { items, rounds } = configOf(seed);
      const plans = sortRounds(seed, items, rounds).map((round) => solveBoard(boardOfRound(round)) ?? []);
      const end = playPlans(worldOf(seed), plans);
      if (end.outcome !== 'won') lost.push(`seed ${seed}: ${end.outcome} at tick ${end.tick}`);
    }
    expect(lost).toEqual([]);
  });

  it('the solver refuses a round with no way through and solves its mirror', () => {
    // Vidět je jen nádoba druhu 0; druh 1 musí do odkladiště se dvěma místy, druhý odložený ho zaplní.
    expect(solveBoard(handBoard([[1, 1, 1, 0, 0, 0]], [0, 1], 1, 2))).toBeNull();
    expect(solveBoard(handBoard([[0, 0, 0, 1, 1, 1]], [0, 1], 1, 2))).toEqual([0, 0, 0, 0, 0, 0]);
    // Druhou frontou se jde kolem: nejdřív nádobu 0, pak se odložené druhy 1 samy přesunou.
    expect(solveBoard(handBoard([[1, 1, 1], [0, 0, 0]], [0, 1], 1, 2))).not.toBeNull();
  });
});

describe('sort rules of one round', () => {
  it('a head goes to the open bin of its kind, else to the shelf; a full shelf loses', () => {
    const board = handBoard([[1, 1, 1], [0, 0, 0]], [0, 1], 1, 2);
    expect(tapQueue(board, 0)).toEqual({ moves: [{ body: 1, kind: 1, to: 'buffer', tapped: true }], outcome: null });
    expect(tapQueue(board, 0)).toEqual({ moves: [{ body: 2, kind: 1, to: 'buffer', tapped: true }], outcome: 'lose' });
  });

  it('a filled bin leaves, the next one comes in and its kind jumps over from the shelf', () => {
    const board = handBoard([[1, 1, 1], [0, 0, 0]], [0, 1], 1, 3);
    tapQueue(board, 0);
    tapQueue(board, 0);
    tapQueue(board, 1);
    tapQueue(board, 1);
    expect(visibleBins(board.bins, board.binned, board.show, board.capacity)).toEqual([{ index: 0, kind: 0, fill: 2 }]);
    const last = tapQueue(board, 1);
    expect(last.moves.map((move) => [move.body, move.to, move.tapped])).toEqual([
      [6, 'bin', true],
      [1, 'bin', false],
      [2, 'bin', false],
    ]);
    expect(visibleBins(board.bins, board.binned, board.show, board.capacity)).toEqual([{ index: 1, kind: 1, fill: 2 }]);
    expect(tapQueue(board, 0)).toEqual({ moves: [{ body: 3, kind: 1, to: 'bin', tapped: true }], outcome: 'win' });
  });

  it('bins of one kind fill in order: only the first unfilled one takes items', () => {
    expect(visibleBins([0, 1, 0, 2], [4, 0, 0], 3, 3)).toEqual([
      { index: 1, kind: 1, fill: 0 },
      { index: 2, kind: 0, fill: 1 },
      { index: 3, kind: 2, fill: 0 },
    ]);
  });

  it('an empty queue does nothing', () => {
    expect(tapQueue(handBoard([[0, 0, 0], []], [0], 1, 2), 1)).toEqual({ moves: [], outcome: null });
  });
});

describe('sort level shape', () => {
  it('is fixed by its seed: the same seed builds the same rounds, other seeds other ones', () => {
    expect(sortRounds(7, 45, 3)).toEqual(sortRounds(7, 45, 3));
    const shapes = new Set(SEEDS.slice(0, 20).map((seed) => JSON.stringify(sortRounds(seed, 45, 3))));
    expect(shapes.size).toBe(20);
  });

  it('rounds grow from the intro to the finale, each within its stage and the per-round cap', () => {
    for (const seed of SEEDS.slice(0, 40)) {
      const { items, rounds } = configOf(seed);
      const counts = binsPerRound(items, rounds);
      sortRounds(seed, items, rounds).forEach((round, index) => {
        const stage = stageOf(index, rounds);
        expect(round.bins).toHaveLength(counts[index] as number);
        expect(round.bins.length).toBeGreaterThanOrEqual(stage.least);
        expect(round.bins.length).toBeLessThanOrEqual(SORT.roundBins);
        expect(round.show).toBe(stage.show);
        expect(round.queues).toHaveLength(stage.queues);
        expect(round.kinds).toBe(Math.min(stage.kinds, round.bins.length));
        // Každá fronta začíná s věcí, žádná není hlubší než strop a věcí je přesně na nádoby.
        const all = round.queues.flat();
        expect(round.queues.every((line) => line.length > 0 && line.length <= Math.ceil(all.length / stage.queues) + 2)).toBe(true);
        expect(all).toHaveLength(round.bins.length * SORT.capacity);
        for (let kind = 0; kind < SORT.kinds; kind += 1) expect(all.filter((item) => item === kind).length).toBe(round.bins.filter((bin) => bin === kind).length * SORT.capacity);
      });
      expect(stageOf(0, rounds)).toBe(SORT_STAGES[0]);
      expect(stageOf(rounds - 1, rounds)).toBe(SORT_STAGES[2]);
    }
  });

  it('the first bins of a round are of different kinds', () => {
    for (const seed of SEEDS.slice(0, 40)) {
      const round = sortRound(seed, SORT_STAGES[2], 7);
      expect(new Set(round.bins.slice(0, round.show)).size).toBe(round.show);
    }
  });
});
