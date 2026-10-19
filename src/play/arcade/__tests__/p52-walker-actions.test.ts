/**
 * Dash, štít, střelba a krádež v bludišti (P52 T6). Chodec bral jen úder a krádež, plížení nic, takže věty
 * „dashes past the sleeping cats“, „raises his shield“, „shoots fireballs at the ghosts“ a „snatches the golden
 * scroll“ akci ztratily (dev P52 d11–d18, P47B v17, v41, v45, v61). Nepřátelé stojí na cestě ke východu
 * (`walkerFoeCells`, T5), střela letí směrem chůze a robot nestřílí přes zeď; okradený strážný přestane hlídat.
 */

import { beforeAll, describe, expect, it } from 'vitest';

import { canonicalHash } from '@/ir/worlddoc';

import { generatorTakes } from '../../compose/compile';
import { draftGameSpecWithMeta } from '../../draft';
import type { GameSpecV1 } from '../../spec';
import { baseBotOf, shootStep } from '../addons';
import { arcadeWorldOf } from '../compile';
import { AXIS_MAX, type AbilityId, type ArcadeWorld, BODY, BUTTON, FLAG, HEADER, ROLE, bodyBase, underlyingRule } from '../contract';
import { ARCADE_LIBRARY } from '../library';
import { loadRapier } from '../physics/world';
import { WALKER_CELL, walkerCaught } from '../pieces/walker';
import { type BotProfile, runBot, verifyArcade } from '../verify';

const SEEDS = Array.from({ length: 10 }, (_, index) => index + 1);

beforeAll(async () => {
  await loadRapier();
});

function worldOf(spec: GameSpecV1, seed: number): ArcadeWorld {
  const made = arcadeWorldOf(spec, seed);
  if (!made.ok) throw new Error(made.issues.join('; '));
  return made.world;
}

/** Věty mezer T6 (dev P52 a dev P47B) a akce, které chtějí. */
const SENTENCES: readonly (readonly [string, string, readonly AbilityId[]])[] = [
  ['d11', 'a mouse walks through the cellar maze and dashes past the sleeping cats', ['dash']],
  ['d12', 'A beetle crawls through a garden maze and dodges the pecking birds.', ['dash']],
  ['d13', 'a knight raises his shield against arrows in a dungeon labyrinth', ['shield']],
  ['d14', 'A monk blocks the poison darts with a wooden shield while walking a temple maze.', ['shield']],
  ['d15', 'a wizard shoots fireballs at the ghosts in a haunted maze', ['shoot']],
  ['d16', 'A robot explorer blasts the spiders crawling through an underground maze.', ['shoot']],
  ['d17', 'a ninja sneaks past the guards and snatches the golden scroll', ['grab']],
  ['d18', 'A raccoon creeps through the kitchen at night and steals cookies without waking the dog.', ['grab']],
  ['v17', 'a hamster swerves around swinging pendulums in a maze of cardboard tubes', ['dash']],
  ['v41', 'a sorceress shields herself from fireballs and zaps the trolls in the maze', ['shield', 'shoot']],
  ['v45', 'a tiny wizard casts spells at haunted armor in a castle maze', ['shoot']],
  ['v61', 'a sneaky boy pickpockets guards at a crowded royal ball', ['grab']],
];

const textOf = (id: string): string => SENTENCES.find(([key]) => key === id)![1];

/** Pravidlo, které sloveso akce nese: střelba zásah `shot_hit`, ostatní vlastní `ability_<id>`. */
const ruleOf = (ability: AbilityId): string => (ability === 'shoot' ? 'shot_hit' : `ability_${ability}`);

const wins = (spec: GameSpecV1, profile: BotProfile): number => SEEDS.filter((seed) => runBot(worldOf(spec, seed), ARCADE_LIBRARY, { profile }).outcome === 'won').length / SEEDS.length;

describe('P52 T6: dash, shield, shoot and grab in walker games', () => {
  it.each(SENTENCES)('%s: the sentence keeps its actions, verification proves them and the intermediate bot uses each', (_id, text, wants) => {
    const spec = draftGameSpecWithMeta(text, 1).spec;
    expect(spec.control).toBe('walker');
    expect(spec.abilities).toEqual(wants);
    const used = new Map<AbilityId, number>(wants.map((ability) => [ability, 0]));
    for (const seed of SEEDS) {
      const world = worldOf(spec, seed);
      expect(verifyArcade(world, ARCADE_LIBRARY).failures, `${seed}`).toEqual([]);
      const run = runBot(world, ARCADE_LIBRARY, { profile: 'intermediate' });
      for (const ability of wants) if (run.firstFired[world.rules.findIndex((ref) => underlyingRule(ref).id === ruleOf(ability))]! >= 0) used.set(ability, used.get(ability)! + 1);
    }
    for (const [ability, count] of used) expect(count / SEEDS.length, ability).toBeGreaterThanOrEqual(0.9);
  }, 300_000);

  // Bludiště je lehké už bez akce (novice 20/20 na semínkách 1–20 u všech vět T6): akce ho nesmí posunout.
  it.each(['d11', 'd13', 'd15', 'v41', 'd17'])('%s: novice and intermediate win as often as without the action', (id) => {
    const spec = draftGameSpecWithMeta(textOf(id), 1).spec;
    const { abilities: _abilities, ...plain } = spec;
    for (const profile of ['novice', 'intermediate'] as const) expect(Math.abs(wins(spec, profile) - wins(plain, profile)), profile).toBeLessThanOrEqual(0.1);
  }, 300_000);

  it('the walker shot flies along the walk, not down the z axis', () => {
    const world = worldOf(draftGameSpecWithMeta(textOf('d15'), 1).spec, 1);
    expect(world.rules.map(underlyingRule).find((rule) => rule.id === 'blaster')?.params.aim).toBe('heading');
  });

  it('the bot does not shoot through a wall, and does once the wall is gone', () => {
    const world = worldOf(draftGameSpecWithMeta(textOf('d15'), 1).spec, 1);
    const state = Int32Array.from(world.initial);
    const count = state[HEADER.bodyCount] as number;
    const bodies = Array.from({ length: count }, (_v, index) => index);
    const foe = bodies.find((i) => state[bodyBase(i) + BODY.role] === ROLE.enemy)!;
    const wall = bodies.find((i) => ((state[bodyBase(i) + BODY.flags] as number) & FLAG.solid) !== 0 && state[bodyBase(i) + BODY.role] === ROLE.obstacle)!;
    // Hrdina a nepřítel o pole vlevo a vpravo od zdi, ostatní nepřátelé pryč; hrdina jde doprava.
    const [x, z] = [state[bodyBase(wall) + BODY.x] as number, state[bodyBase(wall) + BODY.z] as number];
    for (const i of bodies) if (i !== foe && state[bodyBase(i) + BODY.role] === ROLE.enemy) state[bodyBase(i) + BODY.flags] = (state[bodyBase(i) + BODY.flags] as number) & ~FLAG.alive;
    Object.assign(state, { [bodyBase(0) + BODY.x]: x - WALKER_CELL, [bodyBase(0) + BODY.z]: z, [bodyBase(0) + BODY.vx]: 110, [bodyBase(0) + BODY.vz]: 0, [bodyBase(foe) + BODY.x]: x + WALKER_CELL, [bodyBase(foe) + BODY.z]: z });
    const fires = (owns?: (body: number) => boolean): boolean => (shootStep({ state, player: 0, tick: 0, recent: [] }, { axis: AXIS_MAX, buttons: 0 }, baseBotOf(world.bot), owns).buttons & BUTTON.FIRE) !== 0;
    expect(fires()).toBe(false);
    state[bodyBase(wall) + BODY.flags] = (state[bodyBase(wall) + BODY.flags] as number) & ~FLAG.alive;
    expect(fires()).toBe(true);
    // Za nepřítelem druhý: patří-li bližší jiné akci (R4), robot nestřílí – střela by zabila jeho.
    const other = bodies.find((i) => i !== foe && state[bodyBase(i) + BODY.role] === ROLE.enemy)!;
    Object.assign(state, { [bodyBase(other) + BODY.flags]: (state[bodyBase(other) + BODY.flags] as number) | FLAG.alive, [bodyBase(other) + BODY.x]: x + 3 * WALKER_CELL, [bodyBase(other) + BODY.z]: z });
    expect(fires((body) => body === other)).toBe(false);
    expect(fires((body) => body === foe)).toBe(true);
    // Jedna střela naráz: dokud letí, robot znovu nestřílí.
    const bullet = bodies.find((i) => state[bodyBase(i) + BODY.role] === ROLE.projectile)!;
    state[bodyBase(bullet) + BODY.flags] = (state[bodyBase(bullet) + BODY.flags] as number) | FLAG.alive;
    expect(fires()).toBe(false);
  });

  it('a stealth game takes grab and nothing else', () => {
    expect((['grab', 'strike', 'dash', 'shield', 'shoot'] as const).filter((id) => generatorTakes('walker_stealth', id))).toEqual(['grab']);
    expect((['grab', 'strike', 'dash', 'shield', 'shoot'] as const).filter((id) => generatorTakes('walker_labyrinth', id))).toHaveLength(5);
  });

  it('a pickpocketed guard no longer catches the hero', () => {
    const world = worldOf(draftGameSpecWithMeta(textOf('v61'), 1).spec, 1);
    const caught = world.rules.map(underlyingRule).find((rule) => rule.id === walkerCaught.id)!;
    const params = walkerCaught.params.parse(caught.params);
    const state = Int32Array.from(world.initial);
    // Strážný hledí po ose z na hrdinu pole před sebou.
    const g = bodyBase(params.body), p = bodyBase(0);
    Object.assign(state, { [g + BODY.x]: state[p + BODY.x], [g + BODY.z]: (state[p + BODY.z] as number) - WALKER_CELL / 2, [g + BODY.vx]: 0, [g + BODY.vz]: 40 });
    const fire = (): number => walkerCaught.fire({ state, player: 0 } as unknown as Parameters<typeof walkerCaught.fire>[0], params).length;
    expect(fire()).toBe(1);
    state[g + BODY.flags] = (state[g + BODY.flags] as number) & ~FLAG.alive;
    expect(fire()).toBe(0);
  });

  it('walker games without the new actions build the same worlds as before', () => {
    // Otisky plížení (se sběrem i bez) a bludiště s úderem změřené před T6; útěk z téže věty T6 nemění (generátor bez akcí).
    const plain = (id: string): GameSpecV1 => ({ ...draftGameSpecWithMeta(textOf(id), 1).spec, abilities: undefined });
    const stealth = plain('d17');
    const escape = { ...stealth, controlParams: { ...stealth.controlParams, generator: 'walker_escape' } } as GameSpecV1;
    const strike = draftGameSpecWithMeta('a hero walks through a stone labyrinth and punches the skeletons in his way', 1).spec;
    expect([stealth, escape, strike].map((spec) => (spec.controlParams as { generator?: string }).generator)).toEqual(['walker_stealth', 'walker_escape', 'walker_labyrinth']);
    expect([stealth, plain('d18'), escape, strike].map((spec) => canonicalHash(worldOf(spec, 1)))).toEqual(['d9b41bfc', 'adf84be6', 'ac73ca1c', 'd27de4e9']);
  });
});
