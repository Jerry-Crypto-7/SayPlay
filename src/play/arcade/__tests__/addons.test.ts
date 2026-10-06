/**
 * Doplňky arkády (P26D): druhá mechanika nad základním ovládáním. Pin je
 * hash světa se doplňkem a bez něj a výhra robota přes 20 semínek – doplněk,
 * který se zapíše do specu, ale do úrovně se nepromítne, by test tvaru prošel.
 */

import { describe, expect, it } from 'vitest';

import { canonicalHash } from '@/ir/worlddoc';
import { type AddonId, type GameSpecV1, readGameSpec } from '@/play/spec';

import arena from '../__fixtures__/arena.json';
import flap from '../__fixtures__/flap.json';
import platform from '../__fixtures__/platform.json';
import runner from '../__fixtures__/runner.json';
import shooter from '../__fixtures__/shooter.json';
import steer from '../__fixtures__/steer.json';
import { arcadeWorldOf } from '../compile';
import { ARCADE_LIMITS, type ArcadeWorld, BODY, COUNTER, FLAG, HEADER, NO_INPUT, ROLE, bodyBase } from '../contract';
import type { GenreSpec } from '@/play/genre/contract';
import { compileGenre } from '@/play/genre/index';

import { hashArcade, instantiate, loadProgram, outcomeOf, step } from '../kernel';
import { ARCADE_LIBRARY } from '../library';
import { runBot, verifyArcade } from '../verify';

const SEEDS = Array.from({ length: 20 }, (_, index) => (index + 1) * 7919);

export function specOf(fixture: unknown, addons: readonly AddonId[] = []): GameSpecV1 {
  const read = readGameSpec({ ...(fixture as object), ...(addons.length === 0 ? {} : { addons }) });
  if (!read.ok) throw new Error(read.issues.join('; '));
  return read.value;
}

export function worldOf(spec: GameSpecV1, seed: number) {
  const made = arcadeWorldOf(spec, seed);
  if (!made.ok) throw new Error(made.issues.join('; '));
  return made.world;
}

/** Semínka, na kterých hra neprošla, s prvním důvodem. */
export function failing(spec: GameSpecV1): string[] {
  return SEEDS.flatMap((seed) => {
    const verdict = verifyArcade(worldOf(spec, seed));
    return verdict.failures.length === 0 ? [] : [`${seed}: ${verdict.failures[0]}`];
  });
}

describe('addon hook and +lives (P26D T3)', () => {
  it('a game without addons keeps the world it had before the hook', () => {
    // Naměřeno před háčkem (c631214) nad `runner.json`, semínko 7: '61e583cc'.
    // P28C T6 vědomě posunul na 'fe86ee7c' – ovládání nese značky rampy rychlosti.
    expect(canonicalHash(worldOf(specOf(runner), 7))).toBe('fe86ee7c');
  });

  it.each([
    ['runner', runner],
    ['platform', platform],
    ['flap', flap],
  ])('%s +lives starts with three lives and a hit only takes one', (_control, fixture) => {
    const plain = worldOf(specOf(fixture), 7);
    const lives = worldOf(specOf(fixture, ['lives']), 7);
    expect(canonicalHash(lives)).not.toBe(canonicalHash(plain));
    expect(lives.initial[HEADER.counters + COUNTER.health]).toBe(3);
    expect(lives.rules.some((rule) => rule.id === 'out_of_health')).toBe(true);
    expect(lives.rules.some((rule) => rule.params.effect === 'lose' && rule.id === 'hit')).toBe(false);
  });

  it.each([
    ['runner', runner],
    ['platform', platform],
    ['flap', flap],
  ])('%s +lives passes the arcade gate on 20 seeds', (_control, fixture) => {
    expect(failing(specOf(fixture, ['lives']))).toEqual([]);
  });

  // Obal `addon_bot` má pevných 8 tiků; robot s jinou reakcí by pod ním viděl jinak staré stavy.
  it('every base bot reacts in the 8 ticks the addon wrapper assumes', () => {
    for (const [id, bot] of Object.entries(ARCADE_LIBRARY.bots)) expect(bot.reactionTicks, id).toBe(8);
  });

  it('an explicit health mechanic wins over the default three lives', () => {
    const spec = specOf(runner, ['lives']);
    const five = { ...spec, mechanics: [{ id: 'health', params: { max: 5 } }] } as GameSpecV1;
    expect(worldOf(five, 7).initial[HEADER.counters + COUNTER.health]).toBe(5);
  });
});

/** Stav po robotově hře – kolik mincí sebral. */
function afterBot(world: ArcadeWorld): Int32Array {
  const run = runBot(world);
  const state = instantiate(world);
  const program = loadProgram(world, ARCADE_LIBRARY);
  const byTick = new Map(run.inputs.map((input) => [input.tick, input]));
  for (let tick = 0; tick < run.tick; tick += 1) step(state, byTick.get(tick) ?? NO_INPUT, program);
  return state;
}

const needOf = (world: ArcadeWorld): number => world.rules.find((rule) => rule.id === 'finish_collected')?.params.need as number;

describe('+shoot (P26D T5)', () => {
  it.each([
    ['runner', runner],
    ['platform', platform],
    ['flap', flap],
    ['move_free', arena],
  ])('%s +shoot passes the gate on 20 seeds and the bot hits something', (_control, fixture) => {
    const spec = specOf(fixture, ['shoot']);
    expect(failing(spec)).toEqual([]);
    const world = worldOf(spec, 7);
    expect(world.control.id).toBe('addon_control');
    const state = afterBot(world);
    // Každý zásah stál náboj a přidal bod; minutí by náboj stálo bez bodu.
    expect(state[HEADER.counters + COUNTER.ammo]).toBeLessThan(world.initial[HEADER.counters + COUNTER.ammo] as number);
    expect(state[HEADER.counters + COUNTER.score]).toBeGreaterThan(0);
  });

  it.each([
    ['runner', runner],
    ['platform', platform],
    ['flap', flap],
  ])('%s +shoot: a bot that never fires runs into an enemy and loses', (_control, fixture) => {
    const world = worldOf(specOf(fixture, ['shoot']), 7);
    const plain = { ...world, bot: (world.bot.params as { base: ArcadeWorld['bot'] }).base };
    expect(runBot(plain).outcome).toBe('lost');
  });

  // Pořadí doplňků: každý přidává těla jen na konec, takže index modelu mince z `+collect` drží i po `+shoot`.
  it.each([
    ['runner', ['collect', 'shoot'], runner],
    ['runner', ['shoot', 'collect'], runner],
    ['platform', ['collect', 'shoot', 'lives'], platform],
    ['flap', ['shoot', 'collect'], flap],
  ] as const)('%s with %j passes the gate on 20 seeds', (_control, addons, fixture) => {
    const spec = specOf(fixture, addons);
    expect(failing(spec)).toEqual([]);
    const world = worldOf(spec, 7);
    const state = afterBot(world);
    expect(state[HEADER.counters + COUNTER.score]).toBeGreaterThan(0);
    expect(state[HEADER.counters + COUNTER.items]).toBeGreaterThanOrEqual(needOf(world));
  });
});

/** Hra bez jediného vstupu až do konce nebo horizontu. */
function idle(world: ArcadeWorld): { outcome: string; state: Int32Array } {
  const state = instantiate(world);
  const program = loadProgram(world, ARCADE_LIBRARY);
  for (let tick = 0; tick < ARCADE_LIMITS.maxTicks && outcomeOf(state) === 'running'; tick += 1) step(state, NO_INPUT, program);
  return { outcome: outcomeOf(state), state };
}

const chaserIndex = (world: ArcadeWorld): number =>
  Array.from({ length: world.initial[HEADER.bodyCount] as number }, (_, i) => i).find((i) => world.initial[bodyBase(i) + BODY.role] === ROLE.chaser) ?? -1;

describe('+chaser (P26D T6)', () => {
  it.each([
    ['runner', runner],
    ['platform', platform],
    ['move_free', arena],
  ])('%s +chaser passes the gate on 20 seeds', (_control, fixture) => {
    const spec = specOf(fixture, ['chaser']);
    expect(failing(spec)).toEqual([]);
    const world = worldOf(spec, 7);
    expect(chaserIndex(world)).toBeGreaterThan(0);
    expect(world.rules).toContainEqual({ id: 'hit', params: { role: 'chaser', effect: 'lose' } });
  });

  it('the chaser closes in on a player who stands still, slower than the player runs', () => {
    for (const fixture of [platform, arena]) {
      const world = worldOf(specOf(fixture, ['chaser']), 7);
      const i = chaserIndex(world);
      const state = instantiate(world);
      const program = loadProgram(world, ARCADE_LIBRARY);
      const gap = () => Math.hypot((state[bodyBase(i) + BODY.x] as number) - (state[bodyBase(0) + BODY.x] as number), (state[bodyBase(i) + BODY.z] as number) - (state[bodyBase(0) + BODY.z] as number));
      const before = gap();
      for (let tick = 0; tick < 60; tick += 1) step(state, NO_INPUT, program);
      expect(before - gap()).toBeGreaterThan(30 * 60);
      expect(before - gap()).toBeLessThan(110 * 60 * Math.SQRT2);
    }
  });

  it('a platformer who does nothing gets caught', () => {
    expect(idle(worldOf(specOf(platform), 7)).outcome).toBe('running');
    expect(idle(worldOf(specOf(platform, ['chaser']), 7)).outcome).toBe('lost');
  });

  it('a runner bot that never dodges runs into the chaser', () => {
    const world = worldOf(specOf(runner, ['chaser']), 7);
    const plain = { ...world, bot: (world.bot.params as { base: ArcadeWorld['bot'] }).base };
    expect(runBot(plain).outcome).toBe('lost');
    expect(runBot(world).outcome).toBe('won');
  });

  it('with lives a catch takes one life and the chaser is gone', () => {
    const world = worldOf(specOf(platform, ['chaser', 'lives']), 7);
    const { state } = idle(world);
    expect(state[HEADER.counters + COUNTER.health]).toBe(2);
    expect((state[bodyBase(chaserIndex(world)) + BODY.flags] as number) & FLAG.alive).toBe(0);
  });

  it.each([
    ['runner', ['shoot', 'chaser'], runner],
    ['platform', ['chaser', 'shoot', 'collect'], platform],
    ['move_free', ['chaser', 'shoot'], arena],
  ] as const)('%s with %j keeps both the chaser and the trigger', (_control, addons, fixture) => {
    const spec = specOf(fixture, addons);
    expect(failing(spec)).toEqual([]);
    const control = worldOf(spec, 7).control;
    expect(control.id).toBe('addon_control');
    expect(control.params.chase).toBeDefined();
  });
});

describe('+collect (P26D T4)', () => {
  it.each([
    ['runner', runner],
    ['platform', platform],
    ['flap', flap],
  ])('%s +collect gates the finish on coins and the wrapped bot still wins on 20 seeds', (_control, fixture) => {
    const spec = specOf(fixture, ['collect']);
    const world = worldOf(spec, 7);
    expect(world.rules.some((rule) => rule.id === 'finish')).toBe(false);
    expect(needOf(world)).toBeGreaterThan(0);
    expect(failing(spec)).toEqual([]);
    for (const seed of SEEDS.slice(0, 5)) {
      const played = worldOf(spec, seed);
      expect(afterBot(played)[HEADER.counters + COUNTER.items], `seed ${seed}`).toBeGreaterThanOrEqual(needOf(played));
    }
  });

  it('a runner that reaches the finish without enough coins loses', () => {
    const world = worldOf(specOf(runner, ['collect']), 7);
    // Základní robot bez obalu mince nehoní: trať proběhne, ale na pásce mu chybí.
    const plain = { ...world, bot: (world.bot.params as { base: ArcadeWorld['bot'] }).base };
    expect(runBot(plain).outcome).toBe('lost');
  });

  it('the level keeps coins even when the spec switched them off', () => {
    const spec = specOf({ ...(platform as object), controlParams: { ...platform.controlParams, coins: false } }, ['collect']);
    expect(worldOf(spec, 7).kinds).toContain('coin');
  });

  it('move_free, steer and shooter do not take +collect', () => {
    for (const fixture of [arena, steer, shooter]) expect(readGameSpec({ ...(fixture as object), addons: ['collect'] }).ok).toBe(false);
  });
});

/**
 * P39 T8: tělo doplňku nese jméno z obsazení. `kind` těla je id role specu
 * (`enemy`, `chaser`, z `addonRoles`) a popisek té role je věc z věty – scéna
 * i měření ho čtou odtud, takže „shoot animals“ nekreslí robota. Hashovaný
 * stav se tím nemění: jméno žije ve specu, ne v jádře.
 */
describe('addon bodies carry the cast name (P39 T8)', () => {
  const game = (genre: 'platformer' | 'runner', cast: GenreSpec['cast']): GameSpecV1 => {
    const read = readGameSpec(compileGenre({ genre, mode: 'default', hero: 'fox', setting: 'forest', cast } as GenreSpec));
    if (!read.ok) throw new Error(read.issues.join('; '));
    return read.value;
  };
  const world = (spec: GameSpecV1): ArcadeWorld => {
    const built = arcadeWorldOf(spec, 7);
    if (!built.ok) throw new Error(built.issues.join('; '));
    return built.world;
  };
  /** Popisky rolí specu, na které ukazují těla s rolí jádra `role`. */
  const namesOf = (spec: GameSpecV1, role: number): string[] => {
    const built = world(spec);
    const state = instantiate(built);
    const names: string[] = [];
    for (let i = 0; i < (state[HEADER.bodyCount] as number); i += 1) {
      if (state[bodyBase(i) + BODY.role] !== role) continue;
      const kind = built.kinds[state[bodyBase(i) + BODY.kind] as number] as string;
      names.push(spec.roles.find((entry) => entry.id === kind)?.label ?? `no role ${kind}`);
    }
    return names;
  };

  it('+shoot in a platformer: every enemy body points to the thing the sentence shoots', () => {
    const spec = game('platformer', [{ label: 'animal', does: 'shoot_at' }, { label: 'acorn', does: 'collect' }]);
    expect(spec.addons).toContain('shoot');
    const names = namesOf(spec, ROLE.enemy);
    expect(names.length).toBeGreaterThan(0);
    expect(new Set(names)).toEqual(new Set(['animal']));
  });

  it('+chaser in a runner: the chaser body points to the thing that chases', () => {
    const spec = game('runner', [{ label: 'wolf', does: 'chase_me' }]);
    expect(spec.addons).toContain('chaser');
    expect(namesOf(spec, ROLE.chaser)).toEqual(['wolf']);
  });

  it('the same input builds the same state twice, whatever order the cast lists its things in', () => {
    const cast = [{ label: 'bat', does: 'shoot_at' as const }, { label: 'wolf', does: 'chase_me' as const }, { label: 'acorn', does: 'collect' as const }];
    const hash = (list: GenreSpec['cast']) => hashArcade(instantiate(world(game('runner', list))));
    const first = hash(cast);
    expect(hash(cast)).toBe(first);
    expect(hash([cast[2]!, cast[0]!, cast[1]!])).toBe(first);
    expect(hash([cast[1]!, cast[2]!, cast[0]!])).toBe(first);
  });
});
