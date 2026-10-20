/**
 * Souboj v aréně s dashem i štítem (P52 T9). S telegrafem 30 tiků vyhrál novice na semínkách 1–10 jen 1/10
 * (štít na A) a 3/10 (dash na A), bez akcí 6/10: ze dvou ochran mu pozdní reakce častěji nevyjde, zápas se
 * táhne a soupeři i flanker průběhu mu berou životy. Ve `genre.v5` se soupeř takové hry napřahuje
 * `FIGHT.pairTelegraph` tiků. Hra s jednou ochranou a uložená `genre.v4` staví týž svět jako dřív.
 */

import { beforeAll, describe, expect, it } from 'vitest';

import { canonicalHash } from '@/ir/worlddoc';

import { draftGameSpecWithMeta } from '../../draft';
import { type GameSpecV1, readGameSpec } from '../../spec';
import { baseControlOf } from '../addons';
import { arcadeWorldOf } from '../compile';
import type { AbilityId, ArcadeWorld } from '../contract';
import { ARCADE_LIBRARY } from '../library';
import { loadRapier } from '../physics/world';
import { FIGHT } from '../pieces/fight';
import { type BotProfile, runBot } from '../verify';

const SEEDS = Array.from({ length: 10 }, (_, index) => index + 1);

beforeAll(async () => {
  await loadRapier();
});

// Věta testu souboje P47B T6 (`fight-guard.test.ts`), ne ze sad měření.
const base = draftGameSpecWithMeta('a mouse defends its cheese from a hungry cat', 1).spec;

/** Spec věty s akcemi `abilities` místo těch, které dal návrh, ve verzi žánru `version`. */
function specOf(abilities: readonly AbilityId[], version = 'genre.v5'): GameSpecV1 {
  const { abilities: _abilities, abilityWords: _words, ...plain } = base;
  const read = readGameSpec({ ...plain, ...(abilities.length === 0 ? {} : { abilities }), genre: { ...base.genre!, compilerVersion: version } });
  if (!read.ok) throw new Error(read.issues.join('; '));
  return read.value;
}

function worldOf(spec: GameSpecV1, seed: number): ArcadeWorld {
  const made = arcadeWorldOf(spec, seed);
  if (!made.ok) throw new Error(made.issues.join('; '));
  return made.world;
}

const wins = (spec: GameSpecV1, profile: BotProfile): number => SEEDS.filter((seed) => runBot(worldOf(spec, seed), ARCADE_LIBRARY, { profile }).outcome === 'won').length / SEEDS.length;
const telegraphOf = (world: ArcadeWorld): unknown => baseControlOf(world.control).params.telegraph;

describe('P52 T9: an arena fight with dash and shield', () => {
  it('is a genre.v5 fight', () => {
    expect(base.control).toBe('move_free');
    expect((base.controlParams as { generator?: string }).generator).toBe('fight');
    expect(base.genre?.compilerVersion).toBe('genre.v5');
  });

  // Obě pořadí tlačítek: robot bere ochranu v jejich pořadí, štít na A drží blok déle.
  it.each([[['shield', 'dash']], [['dash', 'shield']]] as const)('%j: novice wins 0.3–0.7 and intermediate at least 0.8 on 10 seeds', (abilities) => {
    const spec = specOf(abilities);
    expect(telegraphOf(worldOf(spec, 1))).toBe(FIGHT.pairTelegraph);
    const novice = wins(spec, 'novice');
    expect(novice, 'novice').toBeGreaterThanOrEqual(0.3);
    expect(novice, 'novice').toBeLessThanOrEqual(0.7);
    expect(wins(spec, 'intermediate'), 'intermediate').toBeGreaterThanOrEqual(0.8);
  }, 600_000);

  // Otisky změřené nad b8355e7c (před T9): jedna ochrana a uložená v4 se dvěma se nehnou.
  it('a fight with one guard and a stored genre.v4 fight with both build the world they had before', () => {
    const before = { dash: 'f1a68a72', shield: 'fc70f824', v4: '1ffe8fbb' };
    const worlds = { dash: worldOf(specOf(['dash']), 1), shield: worldOf(specOf(['shield']), 1), v4: worldOf(specOf(['shield', 'dash'], 'genre.v4'), 1) };
    for (const world of Object.values(worlds)) expect(telegraphOf(world)).toBeUndefined();
    expect(Object.fromEntries(Object.entries(worlds).map(([name, world]) => [name, canonicalHash(world)]))).toEqual(before);
  });
});
