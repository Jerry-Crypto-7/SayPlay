/**
 * Cíl skákačky z věty (P35 T3): v O10 ukázala skákačka vždy „Reach the flag“ a
 * mince, ať věta chtěla mrkve, baterii nebo měsíc. Sbírací sloveso („collect“,
 * „grab“, „gather“) navíc mění výhru: doskákat k cíli nestačí, dokud leží věc.
 *
 * Věty jsou vlastní, ne zapečetěné věty přejímky (`evals/play/p32/sentences.json`).
 */

import { describe, expect, it } from 'vitest';

import { compileArcade } from '@/play/arcade/compile';
import { type ArcadeWorld, BODY, type BodyInit, HEADER, ROLE, bodyBase } from '@/play/arcade/contract';
import { buildWorld } from '@/play/arcade/kernel';
import { ARCADE_LIBRARY } from '@/play/arcade/library';
import { namedProps, propModels } from '@/play/arcade/models';
import { platformLevel, platformRules } from '@/play/arcade/pieces/platform';
import { runBot } from '@/play/arcade/verify';
import { draftGenreFor } from '@/play/draft/draft';
import { type GameSpecV1, readGameSpec } from '@/play/spec';

import type { GenreSpec } from '../contract';
import { GENRE_MODULES, compileGenre, readGenreSpec } from '../index';

const COLLECT = 'A squirrel leaps across branches to collect acorns and reach the cave';
const GATHER = 'A squirrel leaps across branches to gather 3 apples';
const FIND = 'A goat jumps over rocks in the mountains to find its crown';
const REACH = 'An astronaut jumps between ledges to reach the rocket';
const PLAIN = 'A frog jumps across lily pads';

/** Věta → `GenreSpec` jen modulem žánru (rychlá verze bez modelu). */
function fill(sentence: string): GenreSpec {
  const read = readGenreSpec(GENRE_MODULES.platformer.draftFill(sentence, null));
  if (!read.ok) throw new Error(read.issues.join('; '));
  return read.value;
}

/** Spec přes `readGameSpec` a první semínko, na kterém robot vyhraje – jako dveře publikace. */
function play(spec: GenreSpec): { readonly game: GameSpecV1; readonly world: ArcadeWorld } {
  const read = readGameSpec(compileGenre(spec));
  if (!read.ok) throw new Error(`${read.reason}: ${read.issues.join('; ')}`);
  const issues: string[] = [];
  for (let seed = 1; seed <= 8; seed += 1) {
    const compiled = compileArcade(read.value, seed);
    if (compiled.ok) return { game: read.value, world: compiled.value.arcade! };
    issues.push(...compiled.issues);
  }
  throw new Error(`no seed wins: ${issues.join('; ')}`);
}

const roleOf = (game: GameSpecV1, id: string) => game.roles.find((role) => role.id === id);

/** Kolik sbíraných věcí svět na začátku nese. */
function coinsIn(world: ArcadeWorld): number {
  const count = world.initial[HEADER.bodyCount]!;
  return Array.from({ length: count }, (_, i) => world.initial[bodyBase(i) + BODY.role]).filter((role) => role === ROLE.collectible).length;
}

describe('platformer goal from the sentence (P35 T3)', () => {
  it('collect: carry every item to the goal the sentence names', () => {
    const spec = fill(COLLECT);
    expect(spec.target).toMatchObject({ label: 'cave', verb: 'collect' });
    const { game, world } = play(spec);
    expect(game.tutorial.goalLine).toBe('Collect 5 acorns and reach the cave.');
    expect(game.objective.description).toBe('Collect 5 acorns and reach the cave.');
    expect(roleOf(game, 'coin')).toMatchObject({ label: 'acorn', count: 5 });
    expect(roleOf(game, 'finish')?.label).toBe('cave');
    expect(propModels(game)).toMatchObject({ coin: 'gen3d-acorn', finish: 'gen3d-cave-entrance' });
    expect(coinsIn(world)).toBe(5);
    expect(world.rules).toContainEqual({ id: 'finish', params: { allItems: true } });
  });

  it('collect: the robot picks up every item and wins on every seed', () => {
    const read = readGameSpec(compileGenre(fill(COLLECT)));
    if (!read.ok) throw new Error(read.issues.join('; '));
    for (let seed = 1; seed <= 20; seed += 1) {
      const compiled = compileArcade(read.value, seed);
      expect(compiled.ok, `seed ${seed}: ${compiled.ok ? '' : compiled.issues.join('; ')}`).toBe(true);
      if (compiled.ok) expect(coinsIn(compiled.value.arcade!), `seed ${seed}`).toBe(5);
    }
  });

  it('collect: the count from the sentence, and the flag when it names no goal', () => {
    const spec = draftGenreFor(GATHER, 'platformer', 'default');
    expect(spec).toMatchObject({ collectible: 'apple', counts: { collectible: 3 }, target: { verb: 'gather' } });
    const { game, world } = play(spec!);
    expect(game.tutorial.goalLine).toBe('Collect 3 apples and reach the flag.');
    expect(roleOf(game, 'finish')?.label).toBe('flag');
    expect(namedProps(game).finish).toBe('finish-flag');
    expect(propModels(game).coin).toBe('cc0-apple');
    expect(coinsIn(world)).toBe(3);
  });

  it('find: reaching the goal wins, items are a bonus', () => {
    const spec = fill(FIND);
    expect(spec.target).toMatchObject({ label: 'crown', verb: 'find' });
    const { game, world } = play(spec);
    expect(game.tutorial.goalLine).toBe('Find the crown.');
    expect(game.objective.description).toBe('Find the crown.');
    expect(roleOf(game, 'finish')?.label).toBe('crown');
    expect(propModels(game).finish).toBe('gen3d-crown');
    expect(world.rules).toContainEqual({ id: 'finish', params: {} });
  });

  it('reach: the goal the sentence names, through the offline draft too', () => {
    const spec = draftGenreFor(REACH, 'platformer', 'default');
    expect(spec?.target).toMatchObject({ label: 'rocket', verb: 'reach' });
    const { game } = play(spec!);
    expect(game.tutorial.goalLine).toBe('Reach the rocket.');
    expect(roleOf(game, 'finish')?.label).toBe('rocket');
    expect(propModels(game).finish).toBe('rocket');
  });

  it('no goal in the sentence: the flag and the old goal line stay', () => {
    const spec = fill(PLAIN);
    expect(spec.target).toBeUndefined();
    const { game, world } = play(spec);
    expect(game.tutorial.goalLine).toBe('Reach the flag. Jump over gaps and hazards.');
    expect(roleOf(game, 'finish')?.label).toBe('flag');
    expect(propModels(game).finish).toBeUndefined();
    expect(world.rules).toContainEqual({ id: 'finish', params: {} });
  });

  it('collect: touching the goal with an item left does not win', () => {
    const params = platformLevel.params.parse({ collectAll: true, coinCount: 3 });
    const level = platformLevel.generate(1, params);
    // Věc vysoko nad tratí: robot k ní nedoskočí, cíl ale dotkne.
    const out: BodyInit = { role: 'collectible', kind: 'coin', x: 0, y: 40_000, z: 20_000, w: 500, h: 500, d: 500, solid: false };
    const run = (allItems: boolean) => {
      const built = buildWorld(
        { seed: 1, control: { id: 'platform', params: { doubleJump: false } }, rules: platformRules({ ...params, collectAll: allItems }), bot: { id: 'platform_bot', params: {} }, level: { ...level, bodies: [...level.bodies.slice(0, -1), out, level.bodies.at(-1)!] } },
        ARCADE_LIBRARY,
      );
      if (!built.ok) throw new Error(built.issues.join('; '));
      return runBot(built.world).outcome;
    };
    expect(run(false)).toBe('won');
    expect(run(true)).not.toBe('won');
  });
});
