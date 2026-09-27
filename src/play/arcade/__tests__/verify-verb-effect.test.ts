/**
 * Robot dokazuje sloveso změnou stavu, ne jen výstřelem pravidla (P30B T2).
 *
 * Pravidlo `{ verb: 'collect', do: [{ score: 0 }] }` vystřelí při každém
 * sebrání a hra přitom vypadá hratelně – jenže se nic nestane. Sloveso je
 * dokázané, až když robot po výstřelu jeho pravidla naměří změnu, kterou
 * třída efektu slibuje: čítač, zmizelé nebo nové tělo, slot držení, posun
 * těla o metr, přepnuté tělo, výsledek hry, životy.
 */

import { describe, expect, it } from 'vitest';

import { readGameSpec, type GameSpecV1 } from '@/play/spec';

import runnerFixture from '../__fixtures__/runner.json';
import throwFixture from '../__fixtures__/throw.json';
import giveFlower from '../__fixtures__/rules/give-flower.json';
import leverBridge from '../__fixtures__/rules/lever-bridge.json';
import pushCrate from '../__fixtures__/rules/push-crate.json';
import setLantern from '../__fixtures__/rules/set-lantern.json';
import throwRock from '../__fixtures__/rules/throw-rock.json';
import { arcadeWorldOf } from '../compile';
import type { ArcadeWorld } from '../contract';
import { replay } from '../kernel';
import { ARCADE_LIBRARY } from '../library';
import { arcadeReport, verifyArcade } from '../verify';

function world(input: unknown, seed = 1): ArcadeWorld {
  const spec = readGameSpec(input);
  if (!spec.ok) throw new Error(spec.issues.join('; '));
  const made = arcadeWorldOf(spec.value as GameSpecV1, seed);
  if (!made.ok) throw new Error(made.issues.join('; '));
  return made.world;
}

/** Běžec, kde robot sebere minci: pravidlo se slovesem `verb` a efekty `effects`. */
const onCoin = (verb: string, effects: readonly unknown[]) => ({ ...runnerFixture, rules: [{ id: verb, verb, when: { contact: ['player', 'coin'] }, do: effects }] });

const proofOf = (input: unknown, verb: string) => {
  const verdict = verifyArcade(world(input));
  const proof = verdict.verbs.find((candidate) => candidate.verb === verb);
  if (proof === undefined) throw new Error(`no proof for ${verb}`);
  return { verdict, proof };
};

describe('a verb is proved by the state change its effect class promises', () => {
  const cases: readonly (readonly [cls: string, input: unknown, verb: string, evidence: RegExp])[] = [
    ['score', onCoin('collect', [{ score: 1 }]), 'collect', /^score \+1 \(now \d+\) at tick \d+$/],
    ['count', onCoin('gather', [{ count: { counter: 'items', amount: 1 } }]), 'gather', /^items \+1 \(now 1\) at tick \d+$/],
    ['damage', onCoin('sting', [{ damage: 1 }]), 'sting', /^health -1 \(now -?\d+\) at tick \d+$/],
    // Minci běžce despawnuje už ovládání, proto dárek: `give` nejdřív zahodí nesenou květinu.
    ['despawn', giveFlower, 'give', /^body \d+ gone at tick \d+$/],
    ['spawn', onCoin('drop', [{ spawn: { role: 'coin', at: 'player' } }]), 'drop', /^body \d+ appeared at tick \d+$/],
    ['win', onCoin('finish', [{ win: true }]), 'finish', /^won at tick \d+$/],
    ['lose', onCoin('trip', [{ lose: true }]), 'trip', /^lost at tick \d+$/],
    ['checkpoint', onCoin('mark', [{ checkpoint: 'other' }]), 'mark', /^respawn point moved at tick \d+$/],
    ['grab', throwRock, 'pick', /^held nothing→body \d+ at tick \d+$/],
    ['release', setLantern, 'set', /^held body \d+→nothing at tick \d+$/],
    ['throwHeld', throwRock, 'throw', /^body \d+ moved \d+\.\d m after tick \d+$/],
    ['push', pushCrate, 'push', /^body \d+ moved \d+\.\d m after tick \d+$/],
    ['toggle', leverBridge, 'pull', /^\d+ bod(y|ies) of role \d+ switched at tick \d+$/],
  ];
  for (const [cls, input, verb, evidence] of cases) {
    it(`${cls}: "${verb}" is proved with evidence of the change`, () => {
      const { proof } = proofOf(input, verb);
      expect(proof).toEqual({ verb, fired: true, firstTick: expect.any(Number), changed: true, evidence: expect.stringMatching(evidence) });
    });
  }

  it('respawn: the player put back at the respawn point is the change', () => {
    // Robot sebere minci a jádro ho vrátí na start; běh pak na horizontu nedoběhne, důkaz se ale měří.
    const { proof } = proofOf(onCoin('rewind', [{ respawn: true }]), 'rewind');
    expect(proof).toMatchObject({ fired: true, changed: true, evidence: expect.stringMatching(/^player back at the respawn point at tick \d+$/) });
  });

  // Revize fáze 1 P30B: míč zanikne v tomtéž tiku, kdy zasáhne terč, a spawn mince dostane jeho uvolněný
  // slot. Srovnání se stavem ze začátku tiku tu změnu schovalo a robot platnou hru odmítl (VERB_NO_EFFECT).
  it('spawn into a slot freed earlier in the same tick is still the change', () => {
    const bloom = {
      ...throwFixture,
      roles: [...throwFixture.roles, { id: 'coin', kind: 'collectible', label: 'candy' }],
      rules: [{ id: 'bloom', verb: 'bloom', when: { hit: 'target' }, do: [{ spawn: { role: 'coin', at: 'other' } }] }],
    };
    const { verdict, proof } = proofOf(bloom, 'bloom');
    expect(proof).toMatchObject({ fired: true, changed: true, evidence: expect.stringMatching(/^body \d+ appeared at tick \d+$/) });
    expect(verdict.failures.join(' ')).not.toContain('VERB_NO_EFFECT');
  });

  it('the rule fixtures that win by verbs still prove every verb by a change', () => {
    for (const fixture of [throwRock, pushCrate, leverBridge, setLantern]) {
      const verdict = verifyArcade(world(fixture));
      expect({ title: fixture.title, failures: verdict.failures }).toEqual({ title: fixture.title, failures: [] });
      expect(verdict.verbs.every((proof) => proof.changed && proof.evidence !== null)).toBe(true);
    }
  });
});

describe('a rule that fires without changing anything does not prove its verb', () => {
  it('score 0: the rule fires on every coin, nothing changes – VERB_NO_EFFECT, not publishable', () => {
    const input = onCoin('collect', [{ score: 0 }]);
    const { verdict, proof } = proofOf(input, 'collect');
    expect(verdict.bot.outcome).toBe('won');
    expect(proof).toEqual({ verb: 'collect', fired: true, firstTick: expect.any(Number), changed: false, evidence: null });
    expect(verdict.failures).toEqual([expect.stringMatching(/^verbs_proved: VERB_NO_EFFECT:collect – /)]);
    expect(verdict.publishEligible).toBe(false);

    const report = arcadeReport(verdict, world(input), { specHash: 'spec', worldHash: 'world' });
    expect(report.publishEligible).toBe(false);
    const verbs = report.keypoints.find((point) => point.assertionId === 'verbs_proved');
    expect(verbs?.passed).toBe(false);
    expect(verbs?.failures.join(' ')).toContain('VERB_NO_EFFECT:collect');
  });

  it('count 0 on the items counter is no change either', () => {
    const { verdict, proof } = proofOf(onCoin('gather', [{ count: { counter: 'items', amount: 0 } }]), 'gather');
    expect(proof).toMatchObject({ fired: true, changed: false, evidence: null });
    expect(verdict.failures).toEqual([expect.stringContaining('VERB_NO_EFFECT:gather')]);
  });

  it('a rule with one dead effect and one real one is proved by the real one', () => {
    const give = giveFlower.rules.find((rule) => rule.verb === 'give');
    const input = { ...giveFlower, rules: giveFlower.rules.map((rule) => (rule === give ? { ...rule, do: [{ score: 0 }, ...rule.do] } : rule)) };
    const { verdict, proof } = proofOf(input, 'give');
    expect(proof).toMatchObject({ changed: true, evidence: expect.stringMatching(/^body \d+ gone/) });
    expect(verdict.failures).toEqual([]);
  });

  it('a verb that never fires stays VERB_UNPROVED, not VERB_NO_EFFECT', () => {
    const toss = { id: 'toss', verb: 'throw', when: { press: 'alt' }, do: [{ score: 1 }] };
    const verdict = verifyArcade(world({ ...runnerFixture, rules: [toss] }));
    expect(verdict.verbs).toEqual([{ verb: 'throw', fired: false, firstTick: null, changed: false, evidence: null }]);
    expect(verdict.failures).toEqual([expect.stringContaining('VERB_UNPROVED:throw')]);
  });
});

describe('measuring the change leaves the game untouched', () => {
  it('the bot run of a verb game hashes like a plain replay of its inputs', () => {
    const w = world(throwRock);
    const verdict = verifyArcade(w);
    expect(verdict.replayEqual).toBe(true);
    expect(replay(w, verdict.bot.inputs, ARCADE_LIBRARY).hash).toBe(verdict.bot.hash);
  });
});
