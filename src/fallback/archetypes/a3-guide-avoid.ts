/**
 * A3 — Guide & Avoid (`ARCHETYPES.md` §6).
 *
 * Autonomní chodec jde fixním krokem po mřížce od spawnu k cíli. Hráč ho neřídí
 * — umísťuje omezený počet nástrojů, aby ho nechal přežít. Odtud
 * `ACT_PLAYER_INDIRECT` i `ACT_AUTONOMOUS`.
 *
 * **Zákaz insta-win je konstrukční.** Na trase vždycky stojí aspoň jedna
 * překážka a u cyklické je fáze nastavená tak, aby byla aktivní právě v tiku,
 * kdy tam chodec dojde. Prázdná stopa tedy prohraje ve všech 144 n-ticích, a
 * není to tvrzení testu — je to důsledek toho, jak se svět staví.
 */

import {
  facingFromDelta,
  type Archetype,
  type Facing,
  type Game,
  type GameView,
  type Intent,
  type Trace,
} from '../loop';
import { MANIFESTS, type CapabilityToken, type Manifest } from '../manifests';

export type Cell = readonly [number, number];

export type A3Params = {
  readonly grid: number;
  readonly hazard_count: number;
  readonly tool_budget: number;
  readonly hazard_behavior: 'static' | 'cyclic';
  readonly walker_speed: number;
};

export type Hazard = {
  readonly cell: Cell;
  /** Cyklická překážka je aktivní, když `(tik + fáze) % 2 === 0`. */
  readonly phase: number;
  readonly onPath: boolean;
};

export type A3State = {
  readonly params: A3Params;
  readonly tick: number;
  readonly path: readonly Cell[];
  readonly walkerIndex: number;
  readonly facing: Facing;
  readonly hazards: readonly Hazard[];
  readonly disabled: readonly boolean[];
  readonly toolsLeft: number;
  readonly alive: boolean;
  readonly won: boolean;
};

const MANIFEST: Manifest = MANIFESTS.find((entry) => entry.id === 'guide_avoid')!;

function sameCell(a: Cell, b: Cell): boolean {
  return a[0] === b[0] && a[1] === b[1];
}

/** Fixní trasa: po řadě 0 na východ, pak posledním sloupcem na sever. */
export function a3Path(grid: number): Cell[] {
  const path: Cell[] = [];
  for (let x = 0; x < grid; x += 1) path.push([x, 0]);
  for (let y = 1; y < grid; y += 1) path.push([grid - 1, y]);
  return path;
}

/** V kterém tiku chodec vstoupí na dané pole trasy. */
function arrivalTick(index: number, speed: number): number {
  return Math.ceil(index / speed);
}

function isActive(hazard: Hazard, behavior: A3Params['hazard_behavior'], tick: number): boolean {
  return behavior === 'static' || (tick + hazard.phase) % 2 === 0;
}

export function a3Create(params: A3Params, _seed: number): A3State {
  const path = a3Path(params.grid);
  const onPathCount = Math.min(params.hazard_count, params.tool_budget);
  const hazards: Hazard[] = [];

  // Vnitřek trasy, ať se překážka netrefí na spawn ani na cíl. Rozestupy jsou
  // rovnoměrné a deterministické — svět A3 na seedu nezávisí, závisí na n-tici.
  const interior = path.length - 2;
  for (let i = 0; i < onPathCount; i += 1) {
    const index = 1 + Math.floor(((i + 1) * interior) / (onPathCount + 1));
    const tick = arrivalTick(index, params.walker_speed);
    hazards.push({
      cell: path[index],
      phase: (2 - (tick % 2)) % 2,
      onPath: true,
    });
  }

  const offPath: Cell[] = [];
  for (let x = 0; x < params.grid && offPath.length < params.hazard_count; x += 1) {
    for (let y = 1; y < params.grid - 1 && offPath.length < params.hazard_count; y += 1) {
      if (!path.some((cell) => sameCell(cell, [x, y]))) offPath.push([x, y]);
    }
  }
  for (let i = 0; i < params.hazard_count - onPathCount; i += 1) {
    hazards.push({ cell: offPath[i], phase: i % 2, onPath: false });
  }

  return {
    params,
    tick: 0,
    path,
    walkerIndex: 0,
    facing: 'east',
    hazards,
    disabled: hazards.map(() => false),
    toolsLeft: params.tool_budget,
    alive: true,
    won: false,
  };
}

function a3Advance(state: A3State, intents: readonly Intent[]): A3State {
  if (state.won || !state.alive) return state;

  const tick = state.tick + 1;
  const disabled = [...state.disabled];
  let toolsLeft = state.toolsLeft;

  // Nástroje se kladou PŘED krokem chodce. Jinak by hráč nikdy nestihl zabrat
  // pole, na které chodec vstupuje právě v tomhle tiku.
  for (const intent of intents) {
    if (intent.kind !== 'point' || toolsLeft <= 0) continue;
    const [rawX, rawY] = intent.target.split(',');
    const cell: Cell = [Number.parseInt(rawX, 10), Number.parseInt(rawY, 10)];
    if (!Number.isInteger(cell[0]) || !Number.isInteger(cell[1])) continue;

    toolsLeft -= 1;
    const hit = state.hazards.findIndex((hazard) => sameCell(hazard.cell, cell));
    if (hit >= 0) disabled[hit] = true;
  }

  const last = state.path.length - 1;
  const target = Math.min(state.walkerIndex + state.params.walker_speed, last);
  let walkerIndex = state.walkerIndex;
  let alive = true;

  // Každé pole mezi starým a novým indexem se prochází, ne přeskakuje — jinak by
  // chodec při `walker_speed` 2 překročil překážku, aniž by na ni šlápl.
  for (let index = state.walkerIndex + 1; index <= target; index += 1) {
    walkerIndex = index;
    const deadly = state.hazards.some(
      (hazard, i) =>
        !disabled[i] &&
        sameCell(hazard.cell, state.path[index]) &&
        isActive(hazard, state.params.hazard_behavior, tick),
    );
    if (deadly) {
      alive = false;
      break;
    }
  }

  const from = state.path[state.walkerIndex];
  const to = state.path[walkerIndex];
  const facing = facingFromDelta(to[0] - from[0], to[1] - from[1]) ?? state.facing;

  return {
    ...state,
    tick,
    walkerIndex,
    facing,
    disabled,
    toolsLeft,
    alive,
    won: alive && walkerIndex === last,
  };
}

function a3View(state: A3State): GameView {
  return {
    archetype: 'guide_avoid',
    title: MANIFEST.title,
    goal: 'Proveď chodce do cíle, máš omezený počet nástrojů',
    phase: state.won ? 'won' : state.alive ? 'running' : 'lost',
    tick: state.tick,
    counters: [
      { label: 'nástroje', value: state.toolsLeft, max: state.params.tool_budget },
      { label: 'pole', value: state.walkerIndex, max: state.path.length - 1 },
    ],
    timeLeftTicks: null,
    message: null,
    sceneLayout: MANIFEST.sceneLayout,
  };
}

export function a3Game(params: A3Params): Game<A3State> {
  return {
    manifest: MANIFEST,
    goal: 'Proveď chodce do cíle, máš omezený počet nástrojů',
    create: (seed) => a3Create(params, seed),
    advance: a3Advance,
    project: a3View,
  };
}

export function a3Tuples(): A3Params[] {
  const tuples: A3Params[] = [];
  for (const grid of MANIFEST.params.grid as number[]) {
    for (const hazard_count of MANIFEST.params.hazard_count as number[]) {
      for (const tool_budget of MANIFEST.params.tool_budget as number[]) {
        for (const hazard_behavior of MANIFEST.params
          .hazard_behavior as A3Params['hazard_behavior'][]) {
          for (const walker_speed of MANIFEST.params.walker_speed as number[]) {
            tuples.push({ grid, hazard_count, tool_budget, hazard_behavior, walker_speed });
          }
        }
      }
    }
  }
  return tuples;
}

/**
 * Vítězná stopa: zabrat všechny překážky na trase hned v prvním tiku, pak už
 * jen nechat chodce dojít. Nástrojů na to je z konstrukce světa vždycky dost.
 */
export function a3Solve(params: A3Params, seed: number): Trace | null {
  const state = a3Create(params, seed);
  const onPath = state.hazards.filter((hazard) => hazard.onPath);
  if (onPath.length > params.tool_budget) return null;

  const first: Intent[] = onPath.map((hazard) => ({
    kind: 'point',
    target: `${hazard.cell[0]},${hazard.cell[1]}`,
  }));

  const walkTicks = Math.ceil((state.path.length - 1) / params.walker_speed);
  return [first, ...Array.from({ length: walkTicks }, () => [] as Intent[])];
}

export const A3_USES: readonly CapabilityToken[] = [
  'GOAL_REACH',
  'ACT_PLAYER_INDIRECT',
  'ACT_AUTONOMOUS',
  'STATE_DISCRETE',
  'STATE_COUNTER',
  'REQ_PATHFIND_GRID',
  'IN_CLICK',
];

export const A3: Archetype<A3Params, A3State> = {
  id: 'guide_avoid',
  manifest: MANIFEST,
  uses: A3_USES,
  tuples: a3Tuples,
  game: a3Game,
  solve: a3Solve,
};
