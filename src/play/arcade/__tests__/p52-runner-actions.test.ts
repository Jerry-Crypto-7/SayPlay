/**
 * Běžec, kde se akce z věty použije (P52 T4). Trať ze vzorů nechala v každé řadě průchod (volný pruh,
 * skok nebo skluz), robot překážce vždy uhnul a dash ani štít nikdy nic nezastavil – věta o dashi akci
 * ztratila (`VERB_UNPROVED:dash`, dev P52 d27, d32, P47B v18, v21). Nová hra (`genre.v5`) s dashem nebo
 * štítem dostane v každém úseku zeď přes všechny pruhy (`walls`): projde ji jen akce, bez ní stojí život.
 * Hra bez nich a uložená `genre.v4` staví tentýž svět jako dřív.
 */

import { beforeAll, describe, expect, it } from 'vitest';

import { canonicalHash } from '@/ir/worlddoc';

import { draftGameSpecWithMeta } from '../../draft';
import type { GameSpecV1 } from '../../spec';
import { arcadeWorldOf } from '../compile';
import { type AbilityId, type ArcadeLevel, type ArcadeWorld, UNIT, underlyingRule } from '../contract';
import { buildWorld } from '../kernel';
import { ARCADE_LIBRARY } from '../library';
import { loadRapier } from '../physics/world';
import { OBSTACLES, OBSTACLE_KINDS, type ObstacleKind, RUNNER, RUNNER_DENSITIES, RUNNER_STRUCTURE_D, checkRunnerLevel, runnerPatternTrack, runnerTrack } from '../pieces/runner';
import { type BotProfile, runBot, verifyArcade } from '../verify';

const SEEDS = Array.from({ length: 10 }, (_, index) => index + 1);

beforeAll(async () => {
  await loadRapier();
});

/** Řady přes všechny pruhy jen z překážek, které se nepřeskočí ani nepodklouznou: `z` po úsecích trati. */
function wallsBySection(level: ArcadeLevel): number[][] {
  const rows = new Map<number, ObstacleKind[]>();
  for (const body of level.bodies) {
    if (body.role === 'obstacle' && body.d < RUNNER_STRUCTURE_D) rows.set(body.z, [...(rows.get(body.z) ?? []), body.kind as ObstacleKind]);
  }
  const starts = level.sectionStarts ?? [];
  const sections: number[][] = Array.from({ length: starts.length + 1 }, () => []);
  for (const [z, kinds] of rows) {
    if (kinds.length === RUNNER.lanes && kinds.every((kind) => OBSTACLES[kind]?.passBy === 'lane')) sections[starts.filter((start) => z > start).length]!.push(z);
  }
  return sections;
}

const params = (extra: Record<string, unknown> = {}) => runnerTrack.params.parse({ sections: 3, patterns: 1, feel: 2, obstacles: [...OBSTACLE_KINDS], ...extra });

describe('P52 T4: runner track walls', () => {
  it('with walls every section has a row closed in all lanes, and only those rows break the track check', () => {
    for (const density of RUNNER_DENSITIES) {
      for (let seed = 1; seed <= 20; seed += 1) {
        const { level } = runnerPatternTrack(seed, params({ density, walls: 1 }));
        const sections = wallsBySection(level);
        expect(sections.length, `${density}/${seed}`).toBe(3);
        expect(sections.map((walls) => walls.length > 0), `${density}/${seed}`).toEqual([true, true, true]);
        const walls = sections.flat().length;
        const issues = checkRunnerLevel(level, 'normal');
        expect(issues.filter((issue) => !issue.includes('blocks all 3 lanes')), `${density}/${seed}`).toEqual([]);
        expect(issues.length, `${density}/${seed}`).toBe(walls);
      }
    }
  });

  it('without walls the track never closes every lane with lane-only obstacles', () => {
    for (let seed = 1; seed <= 20; seed += 1) expect(wallsBySection(runnerPatternTrack(seed, params()).level).flat(), `${seed}`).toEqual([]);
  });
});

// Věta žánru Běžec bez akce (stejná jako brána `runner-sections.test.ts`); akce se doplní jako u věty se slovesem.
const base = draftGameSpecWithMeta('A fox runs through the city at night dodging traffic cones', 1).spec;
const specOf = (abilities: readonly AbilityId[], version = 'genre.v5'): GameSpecV1 => ({ ...base, ...(abilities.length === 0 ? {} : { abilities: [...abilities] }), genre: { ...base.genre!, compilerVersion: version } });

function worldOf(spec: GameSpecV1, seed: number): ArcadeWorld {
  const made = arcadeWorldOf(spec, seed);
  if (!made.ok) throw new Error(made.issues.join('; '));
  return made.world;
}

const wins = (spec: GameSpecV1, profile: BotProfile): number => SEEDS.filter((seed) => runBot(worldOf(spec, seed), ARCADE_LIBRARY, { profile }).outcome === 'won').length / SEEDS.length;

describe('P52 T4: a runner sentence with dash or shield uses the action', () => {
  it.each([['dash', 'ability_dash'], ['shield', 'ability_shield']] as const)('%s: verification proves the verb on every seed and the intermediate bot uses it', (id, rule) => {
    const spec = specOf([id]);
    let used = 0;
    for (const seed of SEEDS) {
      const world = worldOf(spec, seed);
      const verdict = verifyArcade(world, ARCADE_LIBRARY);
      expect(verdict.failures, `${id}/${seed}`).toEqual([]);
      const run = runBot(world, ARCADE_LIBRARY, { profile: 'intermediate' });
      if (run.firstFired[world.rules.findIndex((ref) => underlyingRule(ref).id === rule)]! >= 0) used += 1;
    }
    expect(used / SEEDS.length, id).toBeGreaterThanOrEqual(0.9);
  }, 300_000);

  it('without the action the bot runs into the first wall; the same track without walls it finishes', () => {
    // Holá trať (jeden náraz prohrává, bez hrozeb průběhu): měří jen zeď.
    const play = (level: ArcadeLevel) => {
      const control = { id: 'runner', params: { speed: 'normal', ramp: level.sectionStarts, feel: 2 } };
      const rules = [{ id: 'hit', params: { role: 'obstacle', effect: 'lose' } }, { id: 'pickup', params: {} }, { id: 'finish', params: {} }];
      const built = buildWorld({ seed: 1, control, rules, bot: { id: 'runner_bot', params: {} }, level }, ARCADE_LIBRARY);
      if (!built.ok) throw new Error(built.issues.join('; '));
      return runBot(built.world, ARCADE_LIBRARY);
    };
    for (const seed of SEEDS) {
      const walled = runnerPatternTrack(seed, params({ walls: 1 })).level;
      const first = Math.min(...wallsBySection(walled).flat());
      const run = play(walled);
      expect(run.outcome, `${seed}`).toBe('lost');
      expect(Math.abs(run.distanceM * UNIT - first), `${seed}: lost at ${run.distanceM} m, wall at ${first / UNIT} m`).toBeLessThan(2 * UNIT);
    }
    expect(SEEDS.filter((seed) => play(runnerPatternTrack(seed, params()).level).outcome === 'won').length).toBeGreaterThanOrEqual(9);
  }, 120_000);

  it.each(['dash', 'shield'] as const)('%s keeps the novice in 0.3-0.7 and the intermediate at 0.8 or more', (id) => {
    const spec = specOf([id]);
    const novice = wins(spec, 'novice');
    expect(novice).toBeGreaterThanOrEqual(0.3);
    expect(novice).toBeLessThanOrEqual(0.7);
    expect(wins(spec, 'intermediate')).toBeGreaterThanOrEqual(0.8);
  }, 300_000);

  it('a stored genre.v4 game and a v5 game without dash or shield build the same world as before', () => {
    // Otisky změřené před T4.
    const hashes = [specOf(['dash'], 'genre.v4'), specOf(['shield'], 'genre.v4'), specOf([]), specOf(['strike'])].map((spec) => canonicalHash(worldOf(spec, 1)));
    expect(hashes).toEqual(['63fa025c', '1e4b49c3', 'db822c9a', 'd1de42fe']);
  });
});
