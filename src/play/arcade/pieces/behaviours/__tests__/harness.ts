/**
 * Malé světy pro testy chování (P45C T4–T9): `move_free` (sběr v aréně) a
 * `runner` (prázdná trať k cíli), v každém jedno živé tělo chování a obal
 * průběhu. Sdílí je testy všech chování.
 */

import type { ArcadeParts } from '../../../addons';
import { ARCADE_LIMITS, type ArcadeEffect, type ArcadeState, type ArcadeWorld, BODY, type BodyInit, COUNTER, HEADER, type InputEvent, NO_INPUT, UNIT, bodyBase } from '../../../contract';
import { buildWorld, instantiate, loadProgram, step } from '../../../kernel';
import { ARCADE_LIBRARY, MODE_GENERATORS } from '../../../library';
import { withPacing } from '../../pacing';
import { RUNNER, runnerTrack } from '../../runner';
import { BEHAVIOURS, type BehaviourId, type BehaviourPhase, type BehaviourRef, type BehaviourSpace, TELEGRAPH_MIN, behaviourBodies, behaviourPhaseOf, overlaps, shotBodies } from '../index';

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

export interface HarnessOptions {
  /** Kde stojí těla chování (i žádné); jinak jedno – v aréně v rohu, na trati za hráčem ve vedlejším pruhu. */
  readonly place?: (bodies: readonly BodyInit[]) => readonly { readonly x: number; readonly z: number }[];
  /** Spawny z rozvrhu, místa vstupu a za kolik tiků postup dojde k cíli. */
  readonly budget?: number;
  readonly spots?: readonly number[];
  readonly ticks?: number;
}

/** Svět `space` s tělem chování `behaviour` (`body` = první položené). */
export function behaviourHarness(space: BehaviourSpace, behaviour: BehaviourId, seed: number, options: HarnessOptions = {}): Harness {
  const base = baseParts(space, seed);
  const template = BEHAVIOURS[behaviour].body;
  const player = base.level.bodies[0];
  if (player === undefined) throw new Error('no player');
  const side = seed % 2 === 0 ? 1 : -1;
  const at = options.place !== undefined ? options.place(base.level.bodies) : [space === 'plane' ? { x: side * 12 * UNIT, z: (seed % 4 < 2 ? 1 : -1) * 12 * UNIT } : { x: side * RUNNER.laneWidth, z: player.z - 5 * UNIT }];
  const body = base.level.bodies.length;
  const ticks = options.ticks ?? ARCADE_LIMITS.maxTicks;
  const parts = withPacing(
    { ...base, level: { ...base.level, bodies: [...base.level.bodies, ...at.map((point) => ({ ...template, ...point }))] } },
    { seed, goal: { by: 'time', need: ticks, limit: ticks }, space, spots: options.spots ?? [0, 0], behaviours: [{ body: template, behaviour }], budget: options.budget ?? 0 },
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

/** Výstřel: kdo ho vystřelil a v kterém tiku. */
export interface Shot {
  readonly body: number;
  readonly shooter: number;
  readonly fired: number;
}

/**
 * Invariant telegrafu: každé tělo chování, které se v tiku zásahu (`damage`)
 * dotýká hráče, bylo v posledních 3 s aspoň `TELEGRAPH_MIN` tiků ve fázi
 * `telegraph`; u výstřelu platí totéž pro střelce v 3 s před výstřelem
 * (střelec = nejbližší tělo chování ve fázi `act` v tiku, kdy výstřel vznikl).
 * Vrátí počet zásahů, výstřely a popis porušení.
 */
export function telegraphCheck(world: ArcadeWorld, inputs: readonly InputEvent[]): { hits: number; shots: Shot[]; violations: string[] } {
  const refs = refsOf(world);
  const phases = new Map<number, BehaviourPhase[]>();
  const violations: string[] = [];
  const shots: Shot[] = [];
  const flying = new Map<number, Shot>();
  let hits = 0;
  const warnedBefore = (body: number, tick: number): number => {
    const seen = phases.get(body) ?? [];
    let warned = 0;
    for (let t = Math.max(0, tick - 180); t < tick; t += 1) if (seen[t] === 'telegraph') warned += 1;
    return warned;
  };
  play(world, inputs, (state, tick, effects) => {
    const player = state[HEADER.player] as number;
    const bodies = behaviourBodies(state, player, refs);
    for (const body of bodies) {
      const seen = phases.get(body) ?? [];
      seen[tick] = behaviourPhaseOf(state, body);
      phases.set(body, seen);
    }
    const live = shotBodies(state, player, refs);
    for (const body of live) {
      if (flying.has(body)) continue;
      const distance = (other: number): number => Math.abs(read(state, other, 'x') - read(state, body, 'x')) + Math.abs(read(state, other, 'z') - read(state, body, 'z'));
      const shooter = bodies.filter((other) => behaviourPhaseOf(state, other) === 'act').sort((a, b) => distance(a) - distance(b))[0];
      if (shooter === undefined) violations.push(`tick ${String(tick)}: shot ${String(body)} has no shooter in act`);
      const shot = { body, shooter: shooter ?? -1, fired: tick };
      shots.push(shot);
      flying.set(body, shot);
    }
    const struck = effects.some((effect) => effect.kind === 'damage');
    if (struck) hits += 1;
    for (const effect of effects) {
      const shot = effect.kind === 'despawn' ? flying.get(effect.body) : undefined;
      if (shot === undefined) continue;
      flying.delete(shot.body);
      if (!struck || !overlaps(state, shot.body, player)) continue;
      const warned = warnedBefore(shot.shooter, shot.fired);
      if (warned < TELEGRAPH_MIN) violations.push(`tick ${String(tick)}: shot ${String(shot.body)} fired after ${String(warned)} telegraph ticks`);
    }
    if (!struck) return;
    for (const body of bodies) {
      if (!overlaps(state, body, player)) continue;
      const warned = warnedBefore(body, tick);
      if (warned < TELEGRAPH_MIN) violations.push(`tick ${String(tick)}: body ${String(body)} struck after ${String(warned)} telegraph ticks`);
    }
  });
  return { hits, shots, violations };
}

export const read = (state: ArcadeState, body: number, slot: keyof typeof BODY): number => state[bodyBase(body) + BODY[slot]] as number;

/** Životy na konci záznamu. */
export const healthAfter = (world: ArcadeWorld, inputs: readonly InputEvent[]): number => play(world, inputs, () => undefined)[HEADER.counters + COUNTER.health] as number;
