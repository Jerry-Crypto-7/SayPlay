/**
 * Průběh pod šablonou P45B (P47A T2): rychlý návrh dá aréně a questu overlay
 * šablonu pravidel (`treasure_rush`, `waves_survive`, `reinforcements`) a
 * `ownShape` jim pak celý průběh P45C vypnul – žádné vlny chování, žádný boss.
 * Ve `genre.v4` šablona průběh sběru a útěku nevypne (varianta A, zůstane pod
 * ním) a quest v prostoru ji nedostane (varianta B – pod průběhem robot
 * intermediate vyhrál 6–7/8). Uložená `genre.v3` hra se šablonou (specy
 * zmrazené nad `abe38f04`) staví bajtově týž svět a power-upy P46C platí pro
 * v3 i novější.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';

import { arcadeWorldOf, generatorOf } from '../compile';
import { type ArcadeWorld, nativeRule } from '../contract';
import { ARCADE_LIBRARY } from '../library';
import { FINALE5_GENRE_VERSION, FINALE_GENRE_VERSION, genreAtLeast } from '../pieces/pacing-parts';
import { loadRapier } from '../physics/world';
import { POWERUP_GENRE_VERSION, wantsPowerups } from '../powerups/placement';
import { runBot, verifyArcade } from '../verify';
import { draftGameSpecWithMeta } from '@/play/draft';
import { GENRE_COMPILER_VERSION } from '@/play/genre/contract';
import type { GameSpecV1 } from '@/play/spec';

/** Věty dev sady P47A sběru, útěku a questu v prostoru bez dílů P42, po generátorech. */
const DEV: Readonly<Record<string, readonly string[]>> = {
  arena_collect: [
    'A bee collects pollen in a meadow full of hungry frogs',
    'Grab every gem in a cave while bats swoop at you',
    'Gather lost socks around the laundry room before the dryer monster gets you',
    'A kid collects candy on Halloween night while ghosts follow',
    'A robot vacuum collects coins under the sofa while the cat attacks',
    'Gather apples in an orchard while angry wasps buzz around',
    // P61 T5: s počtem („three treasure chests“) hraje věta právě tolik věcí bez průběhu (`goal-count.test.ts`).
    'Explore an old castle to find treasure chests',
  ],
  arena_escape: [
    'Pick up glowing mushrooms in a dark forest and avoid the wolves',
    'Collect three keys in a pyramid while mummies chase you',
    'Survive a horde of skeletons in a graveyard until sunrise',
    'Survive the robot uprising in a factory for one minute',
  ],
  quest_spatial: [
    'A lighthouse keeper lights every lamp along the stormy coast',
    'A firefighter waters burning trees in a forest',
    'Water the thirsty plants in a greenhouse',
    'Paint every fence in the neighborhood before sunset',
    'A robot plants seeds across a dusty Mars colony',
  ],
};
const SENTENCES = Object.values(DEV).flat();

/** Specy uložené verzí `genre.v3` (`__fixtures__/stored-v3-templates.measure.ts` nad `abe38f04`). */
const STORED: Readonly<Record<string, GameSpecV1>> = JSON.parse(readFileSync(join(__dirname, '__fixtures__', 'stored-v3-templates.json'), 'utf8'));

/** Otisk světa uložené `genre.v3` hry na semínku 1, zmrazený nad `abe38f04` (před P47A). */
const V3_WORLDS: Readonly<Record<string, string>> = {
  'Grab every gem in a cave while bats swoop at you': 'd869f3ec13b04468',
  'Pick up glowing mushrooms in a dark forest and avoid the wolves': '200ef529dfac430b',
  'Collect three keys in a pyramid while mummies chase you': '6646d6d07aa98d5c',
  'Survive a horde of skeletons in a graveyard until sunrise': 'ec0546c0c99ccdf4',
  'A lighthouse keeper lights every lamp along the stormy coast': '65c8f7ebbb8b2880',
};

const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8];

const withVersion = (spec: GameSpecV1, version: string): GameSpecV1 => ({ ...spec, genre: { ...spec.genre!, compilerVersion: version } });
const worldOf = (spec: GameSpecV1, seed = 1): ArcadeWorld => {
  const made = arcadeWorldOf(spec, seed);
  if (!made.ok) throw new Error(made.issues.join('; '));
  return made.world;
};
const fingerprint = (world: ArcadeWorld): string => createHash('sha256').update(JSON.stringify(world)).digest('hex').slice(0, 16);
const paced = (spec: GameSpecV1): boolean => nativeRule(worldOf(spec).rules, 'pacing') !== undefined;
const winShare = (spec: GameSpecV1, profile: 'novice' | 'intermediate'): number =>
  SEEDS.filter((seed) => runBot(worldOf(spec, seed), ARCADE_LIBRARY, { profile }).outcome === 'won').length / SEEDS.length;

beforeAll(async () => {
  await loadRapier();
});

describe('pacing under a P45B overlay template', () => {
  it('new games are genre.v5 and still get the genre.v4 finale', () => {
    expect(GENRE_COMPILER_VERSION).toBe('genre.v5');
    expect(FINALE5_GENRE_VERSION).toBe(GENRE_COMPILER_VERSION);
    expect(FINALE_GENRE_VERSION).toBe('genre.v4');
  });

  it('a stored v3 game with its template builds the frozen pre-P47A world, unpaced', () => {
    expect(Object.keys(STORED)).toEqual(Object.keys(V3_WORLDS));
    for (const [text, spec] of Object.entries(STORED)) {
      expect(spec.genre?.compilerVersion, text).toBe('genre.v3');
      expect(spec.rules?.length ?? 0, text).toBeGreaterThan(0);
      expect(fingerprint(worldOf(spec)), text).toBe(V3_WORLDS[text]);
      expect(paced(spec), text).toBe(false);
    }
  });

  it('in v4 the same collect and escape games keep their template under pacing', () => {
    for (const [text, spec] of Object.entries(STORED)) {
      if (generatorOf(spec) === 'quest_spatial') continue;
      const fresh = draftGameSpecWithMeta(text, 1).spec;
      expect(fresh.rules, text).toEqual(spec.rules);
      expect(paced(fresh), text).toBe(true);
      expect(paced(withVersion(spec, FINALE_GENRE_VERSION)), text).toBe(true);
    }
  });

  it('in v4 a quest in space gets no overlay template and is paced', () => {
    for (const text of DEV.quest_spatial ?? []) {
      const spec = draftGameSpecWithMeta(text, 1).spec;
      expect(generatorOf(spec), text).toBe('quest_spatial');
      expect(spec.rules ?? [], text).toEqual([]);
      expect(paced(spec), text).toBe(true);
    }
    // Uložený v4 quest se šablonou by průběh neměl: šablonu pod průběhem nese jen sběr a útěk.
    expect(paced(withVersion(STORED['A lighthouse keeper lights every lamp along the stormy coast']!, FINALE_GENRE_VERSION))).toBe(false);
  });

  it('power-ups stay on from genre.v3 on, stored v2 games keep none', () => {
    const spec = draftGameSpecWithMeta(SENTENCES[0] as string, 1).spec;
    expect(POWERUP_GENRE_VERSION).toBe('genre.v3');
    expect(wantsPowerups(spec)).toBe(true);
    expect(wantsPowerups(withVersion(spec, 'genre.v3'))).toBe(true);
    expect(wantsPowerups(withVersion(spec, 'genre.v10'))).toBe(true);
    expect(wantsPowerups(withVersion(spec, 'genre.v2'))).toBe(false);
  });

  for (const text of SENTENCES) {
    it(`v4 "${text}": paced, intermediate >= 0.8, novice >= 0.3, idle never wins`, () => {
      const spec = draftGameSpecWithMeta(text, 1).spec;
      expect(genreAtLeast(spec, FINALE_GENRE_VERSION)).toBe(true);
      expect(paced(spec)).toBe(true);
      expect(winShare(spec, 'intermediate')).toBeGreaterThanOrEqual(0.8);
      expect(winShare(spec, 'novice')).toBeGreaterThanOrEqual(0.3);
      for (const seed of SEEDS.slice(0, 3)) expect(verifyArcade(worldOf(spec, seed)).idle.outcome, `#${String(seed)}`).not.toBe('won');
    }, 120_000);
  }
});
