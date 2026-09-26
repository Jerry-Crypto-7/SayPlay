/**
 * Robot dokazuje slovesa (P29A T4): každé sloveso pravidla musí během
 * robotova běhu aspoň jednou vystřelit, jinak hra neprojde (`VERB_UNPROVED`).
 * Výhra sama nestačí – sloveso, které se nikdy nestane, porotce nevidí.
 */

import { describe, expect, it } from 'vitest';

import { readGameSpec, type GameSpecV1 } from '@/play/spec';

import runnerFixture from '../__fixtures__/runner.json';
import { arcadeWorldOf } from '../compile';
import type { ArcadeWorld } from '../contract';
import { arcadeReport, verifyArcade } from '../verify';

function world(input: unknown, seed = 1): ArcadeWorld {
  const spec = readGameSpec(input);
  if (!spec.ok) throw new Error(spec.issues.join('; '));
  const made = arcadeWorldOf(spec.value as GameSpecV1, seed);
  if (!made.ok) throw new Error(made.issues.join('; '));
  return made.world;
}

const collect = { id: 'coins', verb: 'collect', when: { contact: ['player', 'coin'] }, do: [{ score: 1 }] };
/** Robot běžce nikdy nemačká druhé tlačítko – tohle sloveso nevystřelí. */
const toss = { id: 'toss', verb: 'throw', when: { press: 'alt' }, do: [{ score: 1 }] };

const ids = { specHash: 'spec', worldHash: 'world' };

describe('verifyArcade proves rule verbs', () => {
  it('a verb that fires during the bot run is proved, with the first tick it fired', () => {
    const verdict = verifyArcade(world({ ...runnerFixture, rules: [collect] }));
    expect(verdict.bot.outcome).toBe('won');
    expect(verdict.verbs).toEqual([{ verb: 'collect', fired: true, firstTick: expect.any(Number) }]);
    expect(verdict.verbs[0]!.firstTick).toBeGreaterThan(0);
    expect(verdict.failures).toEqual([]);
    expect(verdict.publishEligible).toBe(true);
  });

  it('a won game whose "throw" never fires is not publishable: VERB_UNPROVED:throw', () => {
    const verdict = verifyArcade(world({ ...runnerFixture, rules: [collect, toss] }));
    expect(verdict.bot.outcome).toBe('won');
    expect(verdict.verbs).toEqual([
      { verb: 'collect', fired: true, firstTick: expect.any(Number) },
      { verb: 'throw', fired: false, firstTick: null },
    ]);
    expect(verdict.publishEligible).toBe(false);
    expect(verdict.failures.filter((failure) => failure.includes('VERB_UNPROVED'))).toEqual([expect.stringContaining('VERB_UNPROVED:throw')]);

    const report = arcadeReport(verdict, world({ ...runnerFixture, rules: [collect, toss] }), ids);
    expect(report.publishEligible).toBe(false);
    expect(report.verbs).toEqual(verdict.verbs);
    const verbs = report.keypoints.find((point) => point.assertionId === 'verbs_proved');
    expect(verbs?.passed).toBe(false);
    expect(verbs?.failures.join(' ')).toContain('VERB_UNPROVED:throw');
  });

  it('two rules with one verb: the verb is proved when either fires', () => {
    const alsoCollect = { ...toss, id: 'toss2', verb: 'collect' };
    const verdict = verifyArcade(world({ ...runnerFixture, rules: [alsoCollect, collect] }));
    expect(verdict.verbs).toEqual([{ verb: 'collect', fired: true, firstTick: expect.any(Number) }]);
    expect(verdict.publishEligible).toBe(true);
  });

  it('a game without rules checks no verbs and reports exactly as before', () => {
    const w = world(runnerFixture);
    const verdict = verifyArcade(w);
    expect(verdict.verbs).toEqual([]);
    const report = arcadeReport(verdict, w, ids);
    expect(report.keypoints.map((point) => point.assertionId)).toEqual(['bot_wins', 'idle_loses', 'replay_equal', 'within_limits']);
    expect('verbs' in report).toBe(false);
  });
});
