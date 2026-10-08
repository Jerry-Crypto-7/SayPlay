/**
 * Malé světy pro testy chování (P45C T4–T9): `move_free` (sběr v aréně) a
 * `runner` (prázdná trať k cíli), v každém jedno živé tělo chování a obal
 * průběhu. Sdílí je testy všech chování.
 */

import type { ArcadeParts } from '../../../addons';
import { ARCADE_LIMITS, type ArcadeEffect, type ArcadeState, type ArcadeWorld, COUNTER, HEADER, type InputEvent, NO_INPUT, UNIT } from '../../../contract';
import { buildWorld, instantiate, loadProgram, step } from '../../../kernel';
import { ARCADE_LIBRARY, MODE_GENERATORS } from '../../../library';
import { withPacing } from '../../pacing';
import { RUNNER, runnerTrack } from '../../runner';
import { BEHAVIOURS, type BehaviourId, type BehaviourPhase, type BehaviourRef, type BehaviourSpace, TELEGRAPH_MIN, behaviourBodies, behaviourPhaseOf, overlaps } from '../index';

export const HEALTH = 3;

export interface Harness {
  readonly world: ArcadeWorld;
  /** Index živého těla chování. */
  readonly body: number;
  readonly space: BehaviourSpace;
}

/** Základ: sběr v aréně (nečinný hráč nevyhraje), nebo prázdná trať k cíli. */
function baseParts(space: BehaviourSpace, seed: number): ArcadeParts {
  if (space === 'plane') {
    const mode = MODE_GENERATORS.arena_collect;
    if (mode === undefined) throw new Error('arena_collect');
    return mode.parts(seed, mode.params.parse({}), HEALTH) as ArcadeParts;
  }
  const track = runnerTrack.generate(seed, runnerTrack.params.parse({}));
  return {
    control: { id: 'runner', params: {} },
    bot: { id: 'runner_bot', params: {} },
    level: { ...track, bodies: track.bodies.filter((body) => body.role === 'player' || body.role === 'goal') },
    rules: [{ id: 'finish', params: {} }, { id: 'out_of_health', params: {} }],
  };
}

/** Svět `space` s jedním tělem chování `behaviour`: v aréně v rohu, na trati za hráčem ve vedlejším pruhu. */
export function behaviourHarness(space: BehaviourSpace, behaviour: BehaviourId, seed: number): Harness {
  const base = baseParts(space, seed);
  const template = BEHAVIOURS[behaviour].body;
  const player = base.level.bodies[0];
  if (player === undefined) throw new Error('no player');
  const side = seed % 2 === 0 ? 1 : -1;
  const at = space === 'plane' ? { x: side * 12 * UNIT, z: (seed % 4 < 2 ? 1 : -1) * 12 * UNIT } : { x: side * RUNNER.laneWidth, z: player.z - 5 * UNIT };
  const body = base.level.bodies.length;
  const parts = withPacing(
    { ...base, level: { ...base.level, bodies: [...base.level.bodies, { ...template, ...at }] } },
    { seed, goal: { by: 'time', need: ARCADE_LIMITS.maxTicks, limit: ARCADE_LIMITS.maxTicks }, space, spots: [0, 0], behaviours: [{ body: template, behaviour }], budget: 0 },
  );
  if (parts.issues !== undefined && parts.issues.length > 0) throw new Error(parts.issues.join('; '));
  const made = buildWorld({ seed, ...parts, health: HEALTH }, ARCADE_LIBRARY);
  if (!made.ok) throw new Error(made.issues.join('; '));
  return { world: made.world, body, space };
}

export const refsOf = (world: ArcadeWorld): readonly BehaviourRef[] => (world.control.params as { behaviours: BehaviourRef[] }).behaviours;

/** Odehraje záznam (`[]` = nečinný hráč); po každém tiku `onTick` se stavem a efekty tiku. */
export function play(world: ArcadeWorld, inputs: readonly InputEvent[], onTick: (state: ArcadeState, tick: number, effects: readonly ArcadeEffect[]) => void): ArcadeState {
  const program = loadProgram(world, ARCADE_LIBRARY);
  const state = instantiate(world);
  let next = 0;
  for (let tick = 0; tick < ARCADE_LIMITS.maxTicks && state[HEADER.runState] === 0; tick += 1) {
    while (next < inputs.length && (inputs[next] as InputEvent).tick < tick) next += 1;
    const event = inputs[next];
    const effects: ArcadeEffect[] = [];
    step(state, event !== undefined && event.tick === tick ? event : NO_INPUT, program, (_rule: number, effect: ArcadeEffect) => effects.push(effect));
    onTick(state, tick, effects);
  }
  return state;
}

/**
 * Invariant telegrafu: každé tělo chování, které se v tiku zásahu (`damage`)
 * dotýká hráče, bylo v posledních 3 s aspoň `TELEGRAPH_MIN` tiků ve fázi
 * `telegraph`. Vrátí počet zásahů a popis porušení.
 */
export function telegraphCheck(world: ArcadeWorld, inputs: readonly InputEvent[]): { hits: number; violations: string[] } {
  const refs = refsOf(world);
  const phases = new Map<number, BehaviourPhase[]>();
  const violations: string[] = [];
  let hits = 0;
  play(world, inputs, (state, tick, effects) => {
    const player = state[HEADER.player] as number;
    const bodies = behaviourBodies(state, player, refs);
    for (const body of bodies) {
      const seen = phases.get(body) ?? [];
      seen[tick] = behaviourPhaseOf(state, body);
      phases.set(body, seen);
    }
    if (!effects.some((effect) => effect.kind === 'damage')) return;
    hits += 1;
    for (const body of bodies) {
      if (!overlaps(state, body, player)) continue;
      const seen = phases.get(body) ?? [];
      let warned = 0;
      for (let t = Math.max(0, tick - 180); t < tick; t += 1) if (seen[t] === 'telegraph') warned += 1;
      if (warned < TELEGRAPH_MIN) violations.push(`tick ${String(tick)}: body ${String(body)} struck after ${String(warned)} telegraph ticks`);
    }
  });
  return { hits, violations };
}

/** Životy na konci záznamu. */
export const healthAfter = (world: ArcadeWorld, inputs: readonly InputEvent[]): number => play(world, inputs, () => undefined)[HEADER.counters + COUNTER.health] as number;
