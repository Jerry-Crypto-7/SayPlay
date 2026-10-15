/**
 * Kombo v každé nové hře (P46C T3): série sebrání, zásahů a úderů zvedá násobič ×1–×5,
 * ztracený život ho shodí. Uložená hra (`genre.v2`) má kombo jen tam, kde ho měla.
 */

import { describe, expect, it } from 'vitest';

import { readGameSpec, type GameSpecV1 } from '@/play/spec';

import { arcadeWorldOf } from '../compile';
import { ARCADE_LIMITS, type ArcadeWorld, BODY, COMBO, HEADER, COUNTER, NO_INPUT, bodyBase, underlyingRule } from '../contract';
import { instantiate, loadProgram, outcomeOf, step } from '../kernel';
import { ARCADE_LIBRARY } from '../library';
import { nextMultiplier } from '../pieces/rules';
import { POWERUP_GENRE_VERSION } from '../powerups/placement';
import { runBot } from '../verify';
import golden from '../../../../evals/play/p41/golden/genres.json';

const SEEDS = [1, 2, 3, 4, 5];

const specOf = (id: string, version: string, patch: Partial<GameSpecV1> = {}): GameSpecV1 => {
  const found = (golden.variants as unknown as { id: string; spec: GameSpecV1 }[]).find((variant) => variant.id === id);
  if (found === undefined) throw new Error(`no golden variant ${id}`);
  const read = readGameSpec({ ...found.spec, ...patch, genre: { ...found.spec.genre, compilerVersion: version } });
  if (!read.ok) throw new Error(`${id}: ${JSON.stringify(read)}`);
  return read.value;
};

function worldOf(spec: GameSpecV1, seed: number): ArcadeWorld {
  const made = arcadeWorldOf(spec, seed);
  if (!made.ok) throw new Error(`seed ${seed}: ${made.issues.join('; ')}`);
  return made.world;
}

/** Počítadlo komba světa: tělo, na které ukazuje `combo` některého pravidla. */
const keeperOf = (world: ArcadeWorld): number | undefined =>
  world.rules.map(underlyingRule).map((ref) => (ref.params as { readonly combo?: number }).combo).find((combo) => combo !== undefined);

/** Nejvyšší násobič, který robot ve hře dosáhl (`aux0` počítadla po každém tiku). */
function bestMultiplier(world: ArcadeWorld): number {
  const keeper = keeperOf(world);
  if (keeper === undefined) return 0;
  const run = runBot(world, undefined, { profile: 'intermediate' });
  const program = loadProgram(world, ARCADE_LIBRARY);
  const state = instantiate(world);
  let next = 0;
  let best = 1;
  for (let tick = 0; tick < ARCADE_LIMITS.maxTicks && outcomeOf(state) === 'running'; tick += 1) {
    while (next < run.inputs.length && (run.inputs[next] as { tick: number }).tick < tick) next += 1;
    const event = run.inputs[next];
    step(state, event !== undefined && event.tick === tick ? event : NO_INPUT, program);
    best = Math.max(best, state[bodyBase(keeper) + BODY.aux0] as number);
  }
  return best;
}

describe('combo in every new genre game (P46C T3)', () => {
  it.each(['runner.default/base', 'platformer.default/base', 'voyage.race/base'])('%s: the robot builds a ×2 or better streak', (id) => {
    const best = SEEDS.map((seed) => bestMultiplier(worldOf(specOf(id, POWERUP_GENRE_VERSION), seed)));
    expect(Math.max(...best), `${id}: ${best.join(',')}`).toBeGreaterThanOrEqual(2);
    expect(Math.max(...best)).toBeLessThanOrEqual(COMBO.max);
  }, 240_000);

  it('gives a new game without scoring a combo keeper; the stored version stays without one', () => {
    const fresh = worldOf(specOf('runner.default/base', POWERUP_GENRE_VERSION, { scoring: undefined }), 1);
    const stored = worldOf(specOf('runner.default/base', 'genre.v2', { scoring: undefined }), 1);
    expect(keeperOf(fresh)).toBeDefined();
    expect(keeperOf(stored)).toBeUndefined();
  });

  it('lets a strike raise the combo only in a new game', () => {
    const strikes = (world: ArcadeWorld): (number | undefined)[] =>
      world.rules.map(underlyingRule).filter((ref) => ref.id === 'ability_strike').map((ref) => (ref.params as { readonly combo?: number }).combo);
    const fresh = strikes(worldOf(specOf('runner.default/base', POWERUP_GENRE_VERSION, { abilities: ['strike'] }), 1));
    const stored = strikes(worldOf(specOf('runner.default/base', 'genre.v2', { abilities: ['strike'] }), 1));
    expect(fresh).toHaveLength(1);
    expect(fresh[0]).toBeDefined();
    expect(stored).toEqual([undefined]);
  });

  it('a streak climbs, and a lost life drops the next pick back to ×1', () => {
    const world = worldOf(specOf('runner.default/base', POWERUP_GENRE_VERSION), 1);
    const keeper = keeperOf(world)!;
    const state = instantiate(world);
    const base = bodyBase(keeper);
    const health = state[HEADER.counters + COUNTER.health] as number;
    state[HEADER.tick] = 100;
    state[base + BODY.aux1] = 100;
    state[base + BODY.aux0] = 3;
    state[base + BODY.x] = health;
    expect(nextMultiplier(state, keeper)).toBe(4);
    state[HEADER.counters + COUNTER.health] = health - 1;
    expect(nextMultiplier(state, keeper)).toBe(1);
    state[HEADER.counters + COUNTER.health] = health;
    state[HEADER.tick] = 100 + COMBO.window + 1;
    expect(nextMultiplier(state, keeper)).toBe(1);
  });
});
