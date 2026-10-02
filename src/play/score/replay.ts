/**
 * Přehrání běhu se skóre (P36B T1, T5): týž průchod jako `replayLive` – vstupy
 * i živé změny od tiku 0 –, jen na konci přečte i čítače skóre a životů,
 * které `ReplayResult` jádra nenese. Jádro (`src/play/arcade/**`) se nemění;
 * hash vychází týž jako z `replay` / `replayLive`.
 */

import { ARCADE_LIMITS, COUNTER, HEADER, type InputEvent, NO_INPUT, type ArcadeWorld } from '@/play/arcade/contract';
import { type ArcadeLibrary, type ArcadeOutcome, hashArcade, outcomeOf } from '@/play/arcade/kernel';
import { ARCADE_LIBRARY } from '@/play/arcade/library';
import { type LiveEntry, type LivePatch, startLive, stepLive } from '@/play/arcade/live';
import { releasePhysics } from '@/play/arcade/physics/step';

import type { Par } from './stars';

export interface ScoredRun {
  readonly hash: string;
  readonly outcome: ArcadeOutcome;
  readonly tick: number;
  readonly score: number;
  readonly lives: number;
}

const NO_PATCHES: readonly LivePatch[] = [];

/** Vstupy musí být seřazené podle tiku (jako u `replay`); živé změny se seřadí samy. */
export function scoredReplay(
  world: ArcadeWorld,
  inputs: readonly InputEvent[],
  patches: readonly LiveEntry[],
  library: ArcadeLibrary = ARCADE_LIBRARY,
  horizon: number = ARCADE_LIMITS.maxTicks,
): ScoredRun {
  const run = startLive(world, library);
  const sorted = [...patches].sort((a, b) => a.tick - b.tick);
  let next = 0;
  let nextPatch = 0;
  for (let tick = 0; tick < horizon && outcomeOf(run.state) === 'running'; tick += 1) {
    while (next < inputs.length && (inputs[next] as InputEvent).tick < tick) next += 1;
    while (nextPatch < sorted.length && (sorted[nextPatch] as LiveEntry).tick < tick) nextPatch += 1;
    const due: LivePatch[] = [];
    while (nextPatch < sorted.length && (sorted[nextPatch] as LiveEntry).tick === tick) due.push((sorted[nextPatch++] as LiveEntry).patch);
    const event = inputs[next];
    stepLive(world, run, event !== undefined && event.tick === tick ? event : NO_INPUT, due.length === 0 ? NO_PATCHES : due);
  }
  // Běh, který dojel na horizont, konec neohlásil: svět Rapieru uvolnit hned (jako `replay` jádra).
  releasePhysics(run.state);
  return {
    hash: hashArcade(run.state),
    outcome: outcomeOf(run.state),
    tick: run.state[HEADER.tick] as number,
    score: run.state[HEADER.counters + COUNTER.score] as number,
    lives: run.state[HEADER.counters + COUNTER.health] as number,
  };
}

/** Par = vítězný běh robota ověřovače; běh, který nevyhrál, par nedá. */
export function parOf(world: ArcadeWorld, botInputs: readonly InputEvent[], library: ArcadeLibrary = ARCADE_LIBRARY): Par | null {
  const run = scoredReplay(world, botInputs, [], library);
  return run.outcome === 'won' ? { score: run.score, ticks: run.tick } : null;
}
