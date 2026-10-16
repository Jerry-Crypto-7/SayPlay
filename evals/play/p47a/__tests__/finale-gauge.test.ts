/**
 * Gauge finále P47A (T1): důvod, proč hra průběh nemá, musí sedět na to, co
 * průběh opravdu vypnulo – špatně přiřazený důvod vypadá věrohodně a pošle
 * plán špatným směrem. Proto se každý důvod ověřuje proti světu: hra, které
 * se odebere jmenovaná příčina, průběh dostane.
 */

import { beforeAll, describe, expect, it } from 'vitest';

import { generatorOf } from '@/play/arcade/compile';
import { nativeRule } from '@/play/arcade/contract';
import { loadRapier } from '@/play/arcade/physics/world';
import { assemblyOfCell, liveCells } from '@/play/compose/allowed';
import { compileRecipe } from '@/play/compose/compile';
import { draftGameSpecWithMeta } from '@/play/draft';
import type { GameSpecV1 } from '@/play/spec';

import { type FinaleRow, gaugeOf, genreSummary, summaryOf, unpacedReason, worldOf } from '../finale';

const paced = (spec: GameSpecV1): boolean => nativeRule(worldOf(spec).rules, 'pacing') !== undefined;
/** Tatáž hra uložená před P47A T2 (`genre.v3`): overlay šablona P45B ji nechá bez průběhu. */
const storedV3 = (spec: GameSpecV1): GameSpecV1 => ({ ...spec, genre: { ...spec.genre!, compilerVersion: 'genre.v3' } });

let collect: GameSpecV1;
/** Věta dev sady, jejíž rychlý návrh nese pravidla šablony P45B (bez dílů P42). */
let templated: GameSpecV1;

beforeAll(async () => {
  await loadRapier();
  const cell = liveCells().find((candidate) => {
    const spec = compileRecipe(assemblyOfCell(candidate));
    return spec.genre !== undefined && generatorOf(spec) === 'arena_collect';
  });
  if (cell === undefined) throw new Error('no live arena_collect cell');
  collect = compileRecipe(assemblyOfCell(cell));
  templated = draftGameSpecWithMeta('Grab every gem in a cave while bats swoop at you', 1).spec;
});

describe('unpacedReason', () => {
  it('is null for a world that carries the pacing rule', () => {
    expect(paced(collect)).toBe(true);
    expect(unpacedReason(collect, worldOf(collect))).toBeNull();
  });

  it('names the template rules of a game stored before T2 and own-shape rules in v4; the v4 overlay template is paced', () => {
    expect(templated.assemblyParts).toBeUndefined();
    expect(templated.rules?.length).toBeGreaterThan(0);
    // P47A T2: ve `genre.v4` overlay šablona P45B (`treasure_rush`) průběh nevypne.
    expect(unpacedReason(templated, worldOf(templated))).toBeNull();
    const stored = storedV3(templated);
    expect(unpacedReason(stored, worldOf(stored))).toBe('rules');
    expect(paced({ ...stored, rules: undefined })).toBe(true);
    // Jiné pořadí pravidel šablony = vlastní tvar hry: průběh nedostane ani ve v4.
    const own = { ...templated, rules: [...templated.rules!].reverse() };
    expect(unpacedReason(own, worldOf(own))).toBe('rules');
  });

  it('names P42 parts before rules, and a stored game version as the entry', () => {
    const assembled = draftGameSpecWithMeta('Collect seashells on a beach before the tide crabs pinch you', 1).spec;
    expect(assembled.assemblyParts).toBeDefined();
    expect(unpacedReason(assembled, worldOf(assembled))).toBe('assembly');
    const stored = { ...collect, genre: { ...collect.genre!, compilerVersion: 'genre.v1' } } as GameSpecV1;
    expect(unpacedReason(stored, worldOf(stored))).toBe('entry');
    expect(paced(stored)).toBe(false);
  });

  it('names a single life for collect, and that game paces with two', () => {
    const lives = (max: number): GameSpecV1 => ({
      ...collect,
      mechanics: [...collect.mechanics.filter((mechanic) => mechanic.id !== 'health'), { id: 'health', params: { max } } as GameSpecV1['mechanics'][number]],
    });
    expect(unpacedReason(lives(1), worldOf(lives(1)))).toBe('lives');
    expect(paced(lives(3))).toBe(true);
  });

  it('falls through things and then the rule budget in the order of the switch', () => {
    // Hra bez průběhu kvůli pravidlům: od T2 jen uložená v3 (v4 šablonu pod průběh vezme).
    const stored = storedV3(templated);
    const unpacedWorld = worldOf(stored);
    expect(paced(stored)).toBe(false);
    const bare = { ...stored, rules: undefined };
    expect(unpacedReason({ ...bare, things: [{} as NonNullable<GameSpecV1['things']>[number]] }, unpacedWorld)).toBe('things');
    expect(unpacedReason(bare, unpacedWorld)).toBe('budget');
  });
});

const row = (over: Partial<FinaleRow>): FinaleRow => ({
  id: 'x', text: 'x', cell: 'arena.collect', genre: 'arena.collect', generator: 'arena_collect', seed: 1, playable: true,
  paced: true, reason: null, finale: 'boss', behaviourCount: 2, behaviours: [], longestGapS: 3, rising: true, segmentChanges: 2, changes: [], issues: [], ...over,
});

describe('gauge summary', () => {
  it('shares pacing over built games and fun only over playable ones', () => {
    const rows = [
      row({ id: 'a' }),
      row({ id: 'b', paced: false, reason: 'rules', finale: null, behaviourCount: 1, longestGapS: 6, rising: false, segmentChanges: 0 }),
      row({ id: 'c', paced: false, reason: 'rules', finale: 'climax', behaviourCount: 1, longestGapS: 4 }),
      row({ id: 'd', playable: false, paced: false, reason: 'assembly', finale: 'boss', longestGapS: 30 }),
      row({ id: 'e', behaviourCount: null, longestGapS: null, finale: null, paced: false }),
    ];
    expect(summaryOf(rows)).toEqual({
      sentences: 5, built: 4, playable: 3, pacedShare: 0.25, reasons: { rules: 2, assembly: 1 },
      finaleShare: 0.67, bossShare: 0.33, behavioursMedian: 1, deadTimeMedianS: 4, risingShare: 0.67, segmentChanges2Share: 0.67,
    });
    const split = genreSummary([...rows, row({ id: 'f', genre: 'duel', finale: null })]);
    expect(Object.keys(split.genres)).toEqual(['arena.collect', 'duel']);
    expect(split.genres.duel?.finaleShare).toBe(0);
    expect(split.all.sentences).toBe(6);
  });

  it('measures a fixed paced collect world end to end', () => {
    const gauge = gaugeOf(collect, worldOf(collect));
    expect(gauge.paced).toBe(true);
    expect(gauge.reason).toBeNull();
    expect(gauge.behaviourCount).toBeGreaterThanOrEqual(1);
    expect(gauge.longestGapS).toBeGreaterThan(0);
    // Úseky v rovině (T8): postup cíle průběhu, ne `z` – po trati by aréna celá padla do finále a úsek 2 ani 3 nic nezměnil.
    expect(gauge.changes).toHaveLength(2);
    expect(gauge.segmentChanges).toBeGreaterThanOrEqual(1);
    expect(gaugeOf(collect, worldOf(collect))).toEqual(gauge);
  });
});
