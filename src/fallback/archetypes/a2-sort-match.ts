/**
 * A2 — Sort & Match (`ARCHETYPES.md` §6).
 *
 * N předmětů, N označených soketů, táhni každý na správný. Špatné umístění se
 * vrátí a připíše chybu.
 *
 * `match_rule` není kosmetika: určuje atributovou doménu **i** párování, takže
 * čtyři pravidla dají čtyři různé světy. Kdyby měnilo jen popisek, násobilo by
 * doménu n-tic čtyřmi, aniž by se cokoliv lišilo — a enumerace 288 n-tic by
 * tvrdila pokrytí, které nemá.
 */

import {
  createStreams,
  nextInt,
  ticksForSeconds,
  type Archetype,
  type Game,
  type GameView,
  type Intent,
  type Trace,
} from '../loop';
import { MANIFESTS, type CapabilityToken, type Manifest } from '../manifests';

export type MatchRule = 'color' | 'shape' | 'size' | 'category';

export type A2Params = {
  readonly n_items: number;
  readonly match_rule: MatchRule;
  readonly order: 'any' | 'strict';
  /** `null` = ∞ z §6. */
  readonly mistakes_allowed: number | null;
  readonly timer: number | null;
};

export type A2State = {
  readonly params: A2Params;
  readonly tick: number;
  /** Hodnota atributu předmětu a soketu. Obojí je permutace 0..n-1, párování je bijekce. */
  readonly itemValues: readonly number[];
  readonly socketValues: readonly number[];
  readonly itemPlaced: readonly boolean[];
  readonly socketFilled: readonly boolean[];
  readonly placed: number;
  readonly mistakes: number;
  readonly timeLeftTicks: number | null;
  readonly alive: boolean;
  readonly won: boolean;
};

const MANIFEST: Manifest = MANIFESTS.find((entry) => entry.id === 'sort_match')!;

/** Domény atributů. Jména jdou do HUD, index je hodnota, na kterou se páruje. */
export const RULE_VALUES: Readonly<Record<MatchRule, readonly string[]>> = {
  color: ['sand', 'moss', 'warm', 'deep', 'shell', 'accent'],
  shape: ['cube', 'wedge', 'cylinder', 'arch', 'slab', 'pyramid'],
  size: ['tiny', 'small', 'medium', 'large', 'huge', 'giant'],
  category: ['tool', 'vessel', 'lamp', 'garment', 'weapon', 'mineral'],
};

const RULE_SALT: Readonly<Record<MatchRule, number>> = {
  color: 11,
  shape: 29,
  size: 47,
  category: 73,
};

function shuffled(count: number, seed: number): number[] {
  const streams = createStreams(seed);
  const values = Array.from({ length: count }, (_, index) => index);
  for (let i = count - 1; i > 0; i -= 1) {
    const j = nextInt(streams.shuffle, 0, i);
    [values[i], values[j]] = [values[j], values[i]];
  }
  return values;
}

export function a2Create(params: A2Params, seed: number): A2State {
  // Pravidlo vstupuje do seedu, takže `color` a `shape` nad stejným seedem dají
  // jiné párování — jinak by se čtyři pravidla lišila jen popiskem.
  const itemValues = shuffled(params.n_items, seed + RULE_SALT[params.match_rule]);
  const socketValues = shuffled(params.n_items, seed + RULE_SALT[params.match_rule] * 3 + 1);

  return {
    params,
    tick: 0,
    itemValues,
    socketValues,
    itemPlaced: itemValues.map(() => false),
    socketFilled: socketValues.map(() => false),
    placed: 0,
    mistakes: 0,
    timeLeftTicks: params.timer === null ? null : ticksForSeconds(params.timer),
    alive: true,
    won: false,
  };
}

function indexOf(prefix: string, id: string, count: number): number {
  if (!id.startsWith(prefix)) return -1;
  const index = Number.parseInt(id.slice(prefix.length), 10);
  return Number.isInteger(index) && index >= 0 && index < count ? index : -1;
}

function a2Advance(state: A2State, intents: readonly Intent[]): A2State {
  if (state.won || !state.alive) return state;

  const tick = state.tick + 1;
  const timeLeftTicks = state.timeLeftTicks === null ? null : state.timeLeftTicks - 1;

  const itemPlaced = [...state.itemPlaced];
  const socketFilled = [...state.socketFilled];
  let placed = state.placed;
  let mistakes = state.mistakes;

  for (const intent of intents) {
    if (intent.kind !== 'drag') continue;
    const item = indexOf('item', intent.from, state.params.n_items);
    const socket = indexOf('socket', intent.to, state.params.n_items);
    if (item < 0 || socket < 0 || itemPlaced[item]) continue;

    // Ve `strict` se smí sahat jen na nejnižší nepoložený předmět. Přeskočení
    // pořadí je chyba, ne ignorovaný tah — jinak by `order` nic neznamenal.
    const outOfOrder =
      state.params.order === 'strict' && itemPlaced.findIndex((done) => !done) !== item;
    const correct = state.socketValues[socket] === state.itemValues[item] && !socketFilled[socket];

    if (outOfOrder || !correct) {
      mistakes += 1;
      continue;
    }

    itemPlaced[item] = true;
    socketFilled[socket] = true;
    placed += 1;
  }

  const overMistakes =
    state.params.mistakes_allowed !== null && mistakes > state.params.mistakes_allowed;

  return {
    ...state,
    tick,
    itemPlaced,
    socketFilled,
    placed,
    mistakes,
    timeLeftTicks,
    alive: !overMistakes && (timeLeftTicks === null || timeLeftTicks > 0),
    won: placed >= state.params.n_items,
  };
}

function a2View(state: A2State): GameView {
  return {
    archetype: 'sort_match',
    title: MANIFEST.title,
    goal: `Sort ${state.params.n_items} pieces by the rule ${state.params.match_rule}`,
    phase: state.won ? 'won' : state.alive ? 'running' : 'lost',
    tick: state.tick,
    counters: [
      { label: 'placed', value: state.placed, max: state.params.n_items },
      { label: 'mistakes', value: state.mistakes, max: state.params.mistakes_allowed },
    ],
    timeLeftTicks: state.timeLeftTicks,
    message: null,
    sceneLayout: MANIFEST.sceneLayout,
    // Tahle hra se hraje tahem do soketu, ne chozenim po mrizce.
    avatar: null,
  };
}

export function a2Game(params: A2Params): Game<A2State> {
  return {
    manifest: MANIFEST,
    goal: `Sort ${params.n_items} pieces by the rule ${params.match_rule}`,
    create: (seed) => a2Create(params, seed),
    advance: a2Advance,
    project: a2View,
  };
}

export function a2Tuples(): A2Params[] {
  const tuples: A2Params[] = [];
  for (const n_items of MANIFEST.params.n_items as number[]) {
    for (const match_rule of MANIFEST.params.match_rule as MatchRule[]) {
      for (const order of MANIFEST.params.order as A2Params['order'][]) {
        for (const mistakes_allowed of MANIFEST.params.mistakes_allowed as (number | null)[]) {
          for (const timer of MANIFEST.params.timer as (number | null)[]) {
            tuples.push({ n_items, match_rule, order, mistakes_allowed, timer });
          }
        }
      }
    }
  }
  return tuples;
}

/**
 * Vítězná stopa: předměty v indexovém pořadí, každý na svůj soket, jeden tah za
 * tik. Sedí i na `strict`, protože indexové pořadí je právě to vynucené.
 */
export function a2Solve(params: A2Params, seed: number): Trace | null {
  const state = a2Create(params, seed);
  const trace: Intent[][] = [];

  for (let item = 0; item < params.n_items; item += 1) {
    const socket = state.socketValues.indexOf(state.itemValues[item]);
    if (socket < 0) return null;
    trace.push([{ kind: 'drag', from: `item${item}`, to: `socket${socket}` }]);
  }

  return trace;
}

export const A2_USES: readonly CapabilityToken[] = [
  'GOAL_ARRANGE',
  'GOAL_SEQUENCE',
  'ACT_PLAYER_DIRECT',
  'STATE_DISCRETE',
  'STATE_COUNTER',
  'STATE_TIMER',
  'IN_DRAG',
];

export const A2: Archetype<A2Params, A2State> = {
  id: 'sort_match',
  manifest: MANIFEST,
  uses: A2_USES,
  tuples: a2Tuples,
  game: a2Game,
  solve: a2Solve,
};
