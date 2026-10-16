import { describe, expect, it } from 'vitest';

import { arcadeWorldOf } from '@/play/arcade/compile';
import { draftGameSpecWithMeta } from '@/play/draft';
import type { GameSpecV1 } from '@/play/spec';

import { type Played, type UpgradeRow, addsOf, keptOf, upgradeRow, upgradeSummary } from '../upgrade';

/** Běžec P46B: pravidla, logika a boss finále. */
const RUNNER = "temple run but you're a banana running from a monkey";
/** Sběr v aréně: jako uložená `genre.v3` bez bosse (od `genre.v4`, P47A T3, ho rychlá verze má). */
const ARENA = 'Collect five acorns in a moonlit forest';

function playedOf(spec: GameSpecV1): Played {
  const made = arcadeWorldOf(spec, 1);
  if (!made.ok) throw new Error(made.issues.join('; '));
  return { spec, world: made.world, witnesses: [] };
}

describe('the upgrade gauge', () => {
  const quick = draftGameSpecWithMeta(RUNNER, 1).spec;

  it('an AI version without the rules and logic of a quick version that had them is a loss', () => {
    expect(quick.rules?.length).toBeGreaterThan(0);
    expect(quick.logic).toBeDefined();
    const { rules: _rules, things: _things, logic: _logic, ...bare } = quick;
    expect(keptOf(quick, bare)).toEqual({ keptRules: false, keptLogic: false });
    expect(keptOf(quick, quick)).toEqual({ keptRules: true, keptLogic: true });
    expect(keptOf(bare, bare)).toEqual({ keptRules: true, keptLogic: true });
  });

  it('a new character name alone is not something the AI version adds to play', () => {
    const renamed = { ...quick, roles: quick.roles.map((role) => (role.kind === 'player' ? role : { ...role, label: `golden ${role.label}` })) };
    expect(addsOf(playedOf(quick), playedOf(renamed))).toEqual(['characters']);
    const row = (adds: UpgradeRow['adds']): UpgradeRow => ({ id: 'x', sentence: RUNNER, status: 'ready', reason: null, directed: 'authored', directedReason: null, rules: [1, 1], keptRules: true, keptLogic: true, adds, actionLost: false });
    expect(upgradeSummary([row(['characters']), row(['boss', 'characters'])])).toMatchObject({ ready: 2, adds: 0.5, onlyCharacters: 1, boss: 1 });
  });

  it('a boss the quick version did not have is an addition; the same boss is not', () => {
    const drafted = draftGameSpecWithMeta(ARENA, 1).spec;
    const arena: GameSpecV1 = { ...drafted, genre: { ...drafted.genre!, compilerVersion: 'genre.v3' } };
    expect(addsOf(playedOf(arena), playedOf(quick))).toContain('boss');
    expect(addsOf(playedOf(quick), playedOf(quick))).toEqual([]);
  });

  it('a model that did not answer leaves the quick version, through the real upgrade path', async () => {
    const row = await upgradeRow({ id: 'none', sentence: RUNNER, answer: null, failure: 'UPSTREAM_UNAVAILABLE: scripted' });
    expect(row).toMatchObject({ status: 'draft-final', reason: 'MODEL_UNAVAILABLE', directed: 'draft', keptRules: null, adds: [], actionLost: false });
    expect(row.rules[0]).toBe(quick.rules?.length);
  }, 120_000);
});
