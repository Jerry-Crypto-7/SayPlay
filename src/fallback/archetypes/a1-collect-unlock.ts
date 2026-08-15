/**
 * A1 — Collect & Unlock (`ARCHETYPES.md` §6).
 *
 * Posbírej N předmětů v ohraničené aréně, práh otevře bránu, projdi do cíle.
 *
 * Stav je **celočíselný a konečný**: pole mřížky, počítadlo, dva příznaky a
 * odpočet v ticích. Není to úspornost — `STATE_CONTINUOUS` je v manifestu
 * zakázaný, a jediný způsob, jak to doložit strojově, je nemít v stavu jediné
 * neceločíselné číslo.
 */

import {
  createStreams,
  facingFromDelta,
  nextInt,
  ticksForSeconds,
  type Archetype,
  type Facing,
  type Game,
  type GameView,
  type Intent,
  type Trace,
} from '../loop';
import { MANIFESTS, type CapabilityToken, type Manifest } from '../manifests';

export type A1Params = {
  readonly n_collect: number;
  readonly arena: 'small' | 'medium';
  readonly timer: number | null;
  readonly hazard_count: number;
  readonly hazard_behavior: 'static' | 'patrol';
};

export type Cell = readonly [number, number];

export type A1State = {
  readonly params: A1Params;
  readonly size: number;
  readonly tick: number;
  readonly avatar: Cell;
  readonly facing: Facing;
  /** Zbývající sběratelné předměty. Pole, ne množina — stav musí být porovnatelný. */
  readonly items: readonly Cell[];
  readonly collected: number;
  readonly gate: Cell;
  readonly goal: Cell;
  readonly hazards: readonly Cell[];
  readonly gateOpen: boolean;
  readonly alive: boolean;
  readonly won: boolean;
  readonly timeLeftTicks: number | null;
};

const MANIFEST: Manifest = MANIFESTS.find((entry) => entry.id === 'collect_unlock')!;

/** Perioda hlídkující překážky v ticích: dvě pole po dvou ticích. */
const PATROL_PERIOD = 4;

const ARENA_SIZE: Record<A1Params['arena'], number> = { small: 7, medium: 9 };

function key([x, y]: Cell): number {
  return x * 100 + y;
}

function sameCell(a: Cell, b: Cell): boolean {
  return a[0] === b[0] && a[1] === b[1];
}

/** Kde překážka stojí v daném tiku. Statická nikde neuhne, hlídkující kmitá. */
function hazardAt(home: Cell, behavior: A1Params['hazard_behavior'], tick: number): Cell {
  if (behavior === 'static') return home;
  const offset = Math.floor(tick / 2) % 2;
  return [home[0] + offset, home[1]];
}

function hazardCellsAt(state: A1State, tick: number): Cell[] {
  return state.hazards.map((home) => hazardAt(home, state.params.hazard_behavior, tick));
}

/**
 * Rozmístění světa. Deterministické ze seedu, ale **záměrně ne libovolné**:
 * start, brána a cíl jsou pevné rohy, takže prázdná stopa nikdy nevyhraje.
 * Zákaz insta-win je konstrukční, ne kontrola po faktu.
 */
export function a1Create(params: A1Params, seed: number): A1State {
  const size = ARENA_SIZE[params.arena];
  const streams = createStreams(seed);

  const avatar: Cell = [0, 0];
  const goal: Cell = [size - 1, size - 1];
  const gate: Cell = [size - 2, size - 1];
  const reserved = new Set([key(avatar), key(goal), key(gate)]);

  // Hlídkující překážka se posouvá o jedno pole doprava, takže se drží mimo
  // poslední sloupec — jinak by vyjela z arény.
  const free: Cell[] = [];
  for (let x = 0; x < size; x += 1) {
    for (let y = 0; y < size; y += 1) {
      if (!reserved.has(key([x, y]))) free.push([x, y]);
    }
  }

  const items: Cell[] = [];
  const pool = [...free];
  for (let i = 0; i < params.n_collect; i += 1) {
    items.push(pool.splice(nextInt(streams.spawn, 0, pool.length - 1), 1)[0]);
  }

  const hazardPool = pool.filter(([x]) => params.hazard_behavior === 'static' || x < size - 1);
  const hazards: Cell[] = [];
  for (let i = 0; i < params.hazard_count; i += 1) {
    hazards.push(hazardPool.splice(nextInt(streams.hazard, 0, hazardPool.length - 1), 1)[0]);
  }

  return {
    params,
    size,
    tick: 0,
    avatar,
    facing: 'north',
    items,
    collected: 0,
    gate,
    goal,
    hazards,
    gateOpen: params.n_collect === 0,
    alive: true,
    won: false,
    timeLeftTicks: params.timer === null ? null : ticksForSeconds(params.timer),
  };
}

function a1Advance(state: A1State, intents: readonly Intent[]): A1State {
  if (state.won || !state.alive) return state;

  const tick = state.tick + 1;
  const move = intents.find((intent) => intent.kind === 'move');

  let avatar = state.avatar;
  let facing = state.facing;
  if (move !== undefined) {
    // Jen čtyřsousedství a jen o jedno pole. Diagonála by obešla hlídku.
    const dx = Math.sign(move.dx);
    const dy = Math.sign(move.dy);
    const single = (dx === 0) !== (dy === 0);
    const target: Cell = [state.avatar[0] + dx, state.avatar[1] + dy];
    const inside =
      target[0] >= 0 && target[0] < state.size && target[1] >= 0 && target[1] < state.size;
    const blockedGate = sameCell(target, state.gate) && !state.gateOpen;
    const blockedGoal = sameCell(target, state.goal) && !state.gateOpen;
    if (single && inside && !blockedGate && !blockedGoal) {
      avatar = target;
      facing = facingFromDelta(dx, dy) ?? facing;
    }
  }

  const items = state.items.filter((item) => !sameCell(item, avatar));
  const collected = state.collected + (state.items.length - items.length);
  const gateOpen = collected >= state.params.n_collect;
  const timeLeftTicks = state.timeLeftTicks === null ? null : state.timeLeftTicks - 1;
  const alive = !hazardCellsAt(state, tick).some((hazard) => sameCell(hazard, avatar));

  return {
    ...state,
    tick,
    avatar,
    facing,
    items,
    collected,
    gateOpen,
    alive: alive && (timeLeftTicks === null || timeLeftTicks > 0),
    won: alive && sameCell(avatar, state.goal),
    timeLeftTicks,
  };
}

function a1View(state: A1State): GameView {
  return {
    archetype: 'collect_unlock',
    title: MANIFEST.title,
    goal: `Posbírej ${state.params.n_collect} a projdi bránou do cíle`,
    phase: state.won ? 'won' : state.alive ? 'running' : 'lost',
    tick: state.tick,
    counters: [
      { label: 'sebráno', value: state.collected, max: state.params.n_collect },
      { label: 'brána', value: state.gateOpen ? 1 : 0, max: 1 },
    ],
    timeLeftTicks: state.timeLeftTicks,
    message: null,
    sceneLayout: MANIFEST.sceneLayout,
  };
}

export function a1Game(params: A1Params): Game<A1State> {
  return {
    manifest: MANIFEST,
    goal: `Posbírej ${params.n_collect} a projdi bránou do cíle`,
    create: (seed) => a1Create(params, seed),
    advance: a1Advance,
    project: a1View,
  };
}

export function a1Tuples(): A1Params[] {
  const tuples: A1Params[] = [];
  for (const n_collect of MANIFEST.params.n_collect as number[]) {
    for (const arena of MANIFEST.params.arena as A1Params['arena'][]) {
      for (const timer of MANIFEST.params.timer as (number | null)[]) {
        for (const hazard_count of MANIFEST.params.hazard_count as number[]) {
          for (const hazard_behavior of MANIFEST.params
            .hazard_behavior as A1Params['hazard_behavior'][]) {
            tuples.push({ n_collect, arena, timer, hazard_count, hazard_behavior });
          }
        }
      }
    }
  }
  return tuples;
}

type Step = { readonly cell: Cell; readonly tick: number; readonly moves: readonly Intent[][] };

/**
 * Nejkratší bezpečná cesta z pole do pole, **v čase**.
 *
 * Hledá se přes `(pole, tik mod perioda)`, ne přes `pole`. Bez času by řešitel
 * neuměl počkat, až hlídka uhne — a n-tice by vyšla jako nedohratelná kvůli
 * slabému řešiteli, ne kvůli světu. Čekání je legální tah: prázdné pole záměrů.
 */
function walk(
  state: A1State,
  from: Cell,
  fromTick: number,
  targets: readonly Cell[],
  closed: readonly Cell[],
): Step | null {
  const shut = new Set(closed.map((cell) => key(cell)));
  const blocked = (cell: Cell, tick: number): boolean =>
    shut.has(key(cell)) || hazardCellsAt(state, tick).some((hazard) => sameCell(hazard, cell));

  const goals = new Set(targets.map((cell) => key(cell)));
  const startPhase = fromTick % PATROL_PERIOD;
  const seen = new Set<number>([key(from) * PATROL_PERIOD + startPhase]);
  let frontier: { cell: Cell; tick: number; moves: Intent[][] }[] = [
    { cell: from, tick: fromTick, moves: [] },
  ];

  const deltas: readonly (readonly [number, number])[] = [
    [0, 0],
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ];

  // Strop je velkorysý: mřížka krát perioda je počet dosažitelných stavů, víc
  // tahů než to nemá smysl zkoušet.
  const limit = state.size * state.size * PATROL_PERIOD;
  for (let depth = 0; depth < limit && frontier.length > 0; depth += 1) {
    const next: typeof frontier = [];
    for (const node of frontier) {
      for (const [dx, dy] of deltas) {
        const cell: Cell = [node.cell[0] + dx, node.cell[1] + dy];
        if (cell[0] < 0 || cell[0] >= state.size || cell[1] < 0 || cell[1] >= state.size) continue;
        const tick = node.tick + 1;
        if (blocked(cell, tick)) continue;
        const id = key(cell) * PATROL_PERIOD + (tick % PATROL_PERIOD);
        if (seen.has(id)) continue;
        seen.add(id);

        const step: Intent[] = dx === 0 && dy === 0 ? [] : [{ kind: 'move', dx, dy }];
        const moves = [...node.moves, step];
        if (goals.has(key(cell))) return { cell, tick, moves };
        next.push({ cell, tick, moves });
      }
    }
    frontier = next;
  }

  return null;
}

/**
 * Vítězná stopa: nejbližší předmět po nejbližším předmětu, pak brána, pak cíl.
 *
 * Pořadí sbírání je volné, takže hladová volba stačí — časovače v doméně jsou
 * o řád delší než nejdelší cesta po mřížce 9×9.
 */
export function a1Solve(params: A1Params, seed: number): Trace | null {
  const state = a1Create(params, seed);
  const trace: Intent[][] = [];
  let remaining = [...state.items];
  let at = state.avatar;
  let tick = 0;

  // Dokud není posbíráno, brána i cíl jsou pro chůzi zavřené — hra ten krok
  // neprovede, takže by se stopa rozešla se světem hned na prvním pokusu.
  const shutUntilCollected = [state.gate, state.goal];

  while (remaining.length > 0) {
    const step = walk(state, at, tick, remaining, shutUntilCollected);
    if (step === null) return null;
    trace.push(...step.moves);
    at = step.cell;
    tick = step.tick;
    remaining = remaining.filter((item) => !sameCell(item, step.cell));
  }

  const toGate = walk(state, at, tick, [state.gate], []);
  if (toGate === null) return null;
  trace.push(...toGate.moves);

  const toGoal = walk(state, toGate.cell, toGate.tick, [state.goal], []);
  if (toGoal === null) return null;
  trace.push(...toGoal.moves);

  return trace;
}

export const A1_USES: readonly CapabilityToken[] = [
  'GOAL_COLLECT_N',
  'GOAL_REACH',
  'ACT_PLAYER_DIRECT',
  'STATE_DISCRETE',
  'STATE_COUNTER',
  'STATE_TIMER',
  'IN_MOVE',
];

export const A1: Archetype<A1Params, A1State> = {
  id: 'collect_unlock',
  manifest: MANIFEST,
  uses: A1_USES,
  tuples: a1Tuples,
  game: a1Game,
  solve: a1Solve,
};
