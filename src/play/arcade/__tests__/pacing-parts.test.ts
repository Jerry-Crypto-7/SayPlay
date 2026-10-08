/**
 * Průběh hry ve skládání světa (P45C T10): jen nové hry (spec s `genre`),
 * rozpočet pravidel (boss ustoupí první, pak chování, křivka zůstane) a sonda
 * pro každé chování ve `verifyArcade`.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { type GameSpecV1, readGameSpec } from '@/play/spec';

import arenaFixture from '../__fixtures__/arena.json';
import { arcadeWorldOf } from '../compile';
import { ARCADE_LIMITS, type ArcadeWorld } from '../contract';
import { ARCADE_LIBRARY } from '../library';
import { BEHAVIOURS } from '../pieces/behaviours';
import { bossBody } from '../pieces/behaviours/boss';
import { GENRE_PACING, type GenrePacing, pacingProbeBodies } from '../pieces/pacing-parts';
import { verifyArcade } from '../verify';

const GENRE = { id: 'arena', mode: 'collect', compilerVersion: 'genre.v1' };

function read(extra: Record<string, unknown>): GameSpecV1 {
  const spec = readGameSpec({ ...arenaFixture, ...extra });
  if (!spec.ok) throw new Error(spec.issues.join('; '));
  return spec.value;
}

/** `n` pravidel specu, která nic nevyhrávají: každé přičte bod v jiném rytmu. */
const specRules = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `r${i}`, verb: 'tick', when: { every: 60 + i }, do: [{ score: 1 }] }));

function built(spec: GameSpecV1) {
  const made = arcadeWorldOf(spec, 1);
  if (!made.ok) throw new Error(made.issues.join('; '));
  return made;
}

const ids = (world: ArcadeWorld): string[] => world.rules.map((rule) => rule.id);
const behavioursOf = (world: ArcadeWorld): string[] => pacingProbeBodies(world).map((probe) => probe.behaviour);

/** Aréna s flankery po rozvrhu; `boss` přidá bosse ve finále. */
const arena = (boss: boolean): GenrePacing => (parts) => {
  const quarter = Math.trunc(Number(parts.control.params.half) / 2);
  return {
    goal: { by: 'time', need: 2400, limit: 2400 },
    space: 'plane',
    spots: [-quarter, -quarter, quarter, quarter],
    behaviours: [{ body: BEHAVIOURS.flanker.body, behaviour: 'flanker' }],
    budget: 6,
    ...(boss ? { finale: 'boss' as const, boss: { body: bossBody(BEHAVIOURS.flanker.body), at: 850 } } : {}),
  };
};

/** Přežití 40 s v aréně: jen `arena_eat` a `survive_time`. */
const SURVIVE = { controlParams: { density: 'normal', goal: 'survive' }, mechanics: [{ id: 'timer', params: { id: 'clock', seconds: 40, onEnd: 'win' } }] };

/** Pravidla arény bez průběhu a bez pravidel specu (generátor + časovač). */
const BUILT_IN = built(read({})).world.rules.length;

afterEach(() => {
  delete GENRE_PACING.arena;
});

describe('pacingParts', () => {
  it('leaves a spec without genre (a stored game) exactly as it was, even with a genre entry', () => {
    const before = built(read({})).world;
    GENRE_PACING.arena = arena(true);
    expect(built(read({})).world).toEqual(before);
  });

  it('leaves a genre the table does not pace exactly as it was', () => {
    expect(built(read({ genre: GENRE })).world).toEqual(built(read({})).world);
  });

  it('wraps control and bot, and adds the pacing and boss rules when the budget has room', () => {
    GENRE_PACING.arena = arena(true);
    const { world } = built(read({ genre: GENRE }));
    expect(world.control.id).toBe('pacing_control');
    expect(world.bot.id).toBe('pacing_bot');
    expect(ids(world).filter((id) => id === 'pacing' || id === 'boss_beat')).toEqual(['pacing', 'boss_beat']);
    expect(world.rules.length).toBe(BUILT_IN + 2);
    expect(behavioursOf(world)).toEqual(['flanker', 'boss']);
  });

  it('drops the boss first when only one rule is left', () => {
    GENRE_PACING.arena = arena(true);
    const { world } = built(read({ genre: GENRE, rules: specRules(ARCADE_LIMITS.maxRules - 1 - BUILT_IN) }));
    expect(ids(world)).toContain('pacing');
    expect(ids(world)).not.toContain('boss_beat');
    expect(behavioursOf(world)).toEqual(['flanker']);
    expect(world.rules.length).toBe(ARCADE_LIMITS.maxRules);
  });

  it(`keeps only the curve for a game whose spec rules fill the limit (${ARCADE_LIMITS.maxRules - BUILT_IN} here, built-in ${BUILT_IN}) – it still builds`, () => {
    GENRE_PACING.arena = arena(true);
    const made = arcadeWorldOf(read({ genre: GENRE, rules: specRules(ARCADE_LIMITS.maxRules - BUILT_IN) }), 1);
    expect(made.ok ? [] : made.issues).toEqual([]);
    if (!made.ok) return;
    expect(made.world.control.id).toBe('pacing_control');
    expect(ids(made.world)).not.toContain('pacing');
    expect(ids(made.world)).not.toContain('boss_beat');
    expect(behavioursOf(made.world)).toEqual([]);
    expect(made.world.rules.length).toBe(ARCADE_LIMITS.maxRules);
  });

  it('a survival game with 14 spec rules (2 built-in) builds with the curve, without boss or behaviours', () => {
    GENRE_PACING.arena = arena(true);
    expect(built(read(SURVIVE)).world.rules.length).toBe(2);
    const made = arcadeWorldOf(read({ ...SURVIVE, genre: GENRE, rules: specRules(14) }), 1);
    expect(made.ok ? [] : made.issues).toEqual([]);
    if (!made.ok) return;
    expect(made.world.control.id).toBe('pacing_control');
    expect(ids(made.world)).not.toContain('pacing');
    expect(ids(made.world)).not.toContain('boss_beat');
    expect(behavioursOf(made.world)).toEqual([]);
  });
});

describe('verifyArcade probes every behaviour', () => {
  it('runs a probe for each behaviour in the world and records its strike', () => {
    GENRE_PACING.arena = arena(false);
    // Přežití: sběr arény robot vyhraje dřív, než přijde první nepřítel.
    const { world, roleBindings } = built(read({ ...SURVIVE, genre: GENRE }));
    const verdict = verifyArcade(world, ARCADE_LIBRARY, roleBindings);
    for (const behaviour of behavioursOf(world)) {
      expect(verdict.witnesses.some((witness) => witness.run === 'probe' && witness.actor.roleId === `pacing:${behaviour}`), behaviour).toBe(true);
    }
    expect(behavioursOf(world)).toEqual(['flanker']);
  });
});
