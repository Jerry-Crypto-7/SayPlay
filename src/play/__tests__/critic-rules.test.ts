/**
 * Neprokázané sloveso a vadné pravidlo jdou do opravného kola (P29A T8).
 * Rozhoduje se tu bez člověka, co se publikuje: kritik musí sloveso jmenovat,
 * oprava od modelu se musí přijmout, a když nepomůže, pravidlo ze hry vypadne
 * a hra se hraje bez něj – nikdy se nerozbije a nikdy netvrdí sloveso, které
 * se nestalo.
 */

import { describe, expect, it } from 'vitest';

import { arcadeWorldOf } from '../arcade/compile';
import { verifyArcade } from '../arcade/verify';
import { direct } from '../director';
import { answered, failed, fakeBranch } from '../director/__fixtures__/branch';
import throwRock from '../director/__fixtures__/rules-answers/throw-rock.json';
import { composeCompact } from '../director/compact';
import { ruleInvalidIssues, verbIssues } from '../director/critic';
import type { RepairIssue } from '../director/repair';
import type { GameSpecV1 } from '../spec';

const SENTENCE = throwRock.sentence;
type Answer = typeof throwRock.answer;
const RULES = throwRock.answer.rules;

const answer = (overrides: Partial<Record<keyof Answer, unknown>> = {}): Record<string, unknown> => ({ ...JSON.parse(JSON.stringify(throwRock.answer)), ...overrides });

/** Robot na seedu 1 jako v publikaci: selhání keypointu nese `VERB_UNPROVED:<sloveso>`. */
function check(spec: GameSpecV1): RepairIssue[] {
  const made = arcadeWorldOf(spec, 1);
  if (!made.ok) return [{ code: 'WORLD_REJECTED', path: '', evidence: made.issues.join('; '), repairHint: '' }];
  return verifyArcade(made.world).failures.map((failure) => ({ code: 'KEYPOINT_FAILED', path: '/verification/0', evidence: `keypoint failed: ${failure}`, repairHint: 'fix the game or the claim' }));
}

/** Pravidlo, které robot před výhrou nikdy nevystřelí: jednou za 90 s. */
const DANCE = { id: 'dance', verb: 'dance', when: { every: 5400 }, if: null, do: [{ score: 1 }] };

async function run(first: Record<string, unknown>, repairs: readonly unknown[]) {
  let tick = 0;
  const branch = fakeBranch([answered(first), ...repairs.map((body) => answered(body))]);
  const game = await direct(SENTENCE, { branch, now: () => (tick += 100), compact: true, check, maxRepairRounds: 2 });
  return { game, branch };
}

describe('the critic names rule problems', () => {
  it('RULE_INVALID for an unknown role and for an effect outside the language', () => {
    const unknown = composeCompact(SENTENCE, answer({ rules: [{ ...RULES[0], do: [{ toggle: 'bucket' }] }] }));
    expect(unknown.ok).toBe(false);
    if (unknown.ok) return;
    const issues = ruleInvalidIssues(unknown.detail, [{ do: [{ toggle: 'bucket' }] }]);
    expect(issues.map((issue) => issue.code)).toEqual(['RULE_INVALID']);
    expect(issues[0]?.path).toMatch(/^\/rules\/0/);
    expect(issues[0]?.evidence).toContain('bucket');

    const foreign = composeCompact(SENTENCE, answer({ rules: [{ ...RULES[0], do: [{ explode: true }] }] }));
    expect(foreign.ok).toBe(false);
    if (foreign.ok) return;
    expect(ruleInvalidIssues(foreign.detail, []).map((issue) => issue.code)).toContain('RULE_INVALID');
  });

  it('VERB_UNPROVED names the verb and points at its rule; other findings pass through', () => {
    const spec = { rules: [{ verb: 'pick' }, { verb: 'throw' }] } as unknown as GameSpecV1;
    const other: RepairIssue = { code: 'UNWINNABLE', path: '/verification', evidence: 'the robot player never won the game', repairHint: '' };
    const issues = verbIssues([{ code: 'KEYPOINT_FAILED', path: '/verification/0', evidence: 'keypoint verbs_proved failed: VERB_UNPROVED:throw', repairHint: '' }, other], spec);
    expect(issues).toEqual([expect.objectContaining({ code: 'VERB_UNPROVED', path: '/rules/1' }), other]);
    expect(issues[0]?.evidence).toContain('throw');
  });
});

describe('the director repairs rules before publishing', () => {
  it('an invalid rule goes to the model with its reason and the repaired rules are accepted', async () => {
    const broken = RULES.map((rule) => (rule.id === 'ring' ? { ...rule, when: { contact: ['rock', 'bucket'] } } : rule));
    const { game, branch } = await run(answer({ rules: broken }), [[{ op: 'add', path: '/rules', value: throwRock.answer.rules.map(({ if: cond, ...rule }) => (cond === null ? rule : { ...rule, if: cond })) }]]);
    const sent = branch.calls[1]?.request.user ?? '';
    expect(sent).toContain('RULE_INVALID');
    expect(sent).toContain('bucket');
    expect(game).toMatchObject({ source: 'authored', fallbackReason: null, repairRounds: 1 });
    expect(game.spec.rules?.map((rule) => rule.verb)).toEqual(['pick', 'throw', 'ring']);
  });

  it('an unproved verb goes to the model by name and a repair that removes it is accepted', async () => {
    const { game, branch } = await run(answer({ rules: [...RULES, DANCE] }), [[{ op: 'remove', path: '/rules/3' }]]);
    const sent = branch.calls[1]?.request.user ?? '';
    expect(sent).toContain('VERB_UNPROVED');
    expect(sent).toContain('dance');
    expect(game).toMatchObject({ source: 'authored', fallbackReason: null });
    expect(game.spec.rules?.map((rule) => rule.verb)).toEqual(['pick', 'throw', 'ring']);
  });

  it('when repair does not help, the unproved rule is dropped and the game plays without it', async () => {
    const noop = [{ op: 'replace', path: '/title', value: 'Bell Ringer' }];
    const { game } = await run(answer({ rules: [...RULES, DANCE] }), [noop, noop]);
    expect(game.fallbackReason).toBe('VERB_UNPROVED');
    expect(game.source).toBe('authored');
    expect(game.spec.rules?.map((rule) => rule.verb)).toEqual(['pick', 'throw', 'ring']);
    expect(check(game.spec)).toEqual([]);
  });

  it('when a rule stays invalid, the game plays on the control without rules', async () => {
    const broken = [{ ...RULES[0], when: { contact: ['player', 'bucket'] } }];
    const bad = [{ op: 'add', path: '/rules', value: broken }];
    const { game } = await run(answer({ rules: broken }), [bad, bad]);
    expect(game.fallbackReason).toBe('VERB_UNPROVED');
    expect(game.source).toBe('authored');
    expect(game.spec.rules).toBeUndefined();
    expect(game.failure?.detail).toContain('bucket');
  });

  it('a game that still fails without the unproved rule drops all rules, re-checked by the robot', async () => {
    // Robot, podle kterého hra s jakýmkoli pravidlem neprojde: bez „dance“ je neprohratelná jen hra úplně bez pravidel.
    const strict = (spec: GameSpecV1): RepairIssue[] =>
      spec.rules?.some((rule) => rule.verb === 'dance') === true
        ? [{ code: 'KEYPOINT_FAILED', path: '/verification/0', evidence: 'keypoint failed: verbs_proved: VERB_UNPROVED:dance', repairHint: '' }]
        : (spec.rules ?? []).length > 0
          ? [{ code: 'UNWINNABLE', path: '/verification', evidence: 'the robot player never won the game', repairHint: '' }]
          : [];
    const noop = [{ op: 'replace', path: '/title', value: 'Bell Ringer' }];
    let tick = 0;
    const branch = fakeBranch([answered(answer({ rules: [...RULES, DANCE] })), answered(noop), answered(noop)]);
    const game = await direct(SENTENCE, { branch, now: () => (tick += 100), compact: true, check: strict, maxRepairRounds: 2 });
    expect(game).toMatchObject({ source: 'authored', fallbackReason: 'VERB_UNPROVED' });
    expect(game.spec.rules).toBeUndefined();
  });

  it('a repair outage over invalid rules still plays the game without them', async () => {
    let tick = 0;
    const branch = fakeBranch([answered(answer({ rules: [{ ...RULES[0], when: { contact: ['player', 'bucket'] } }] })), failed('UPSTREAM_UNAVAILABLE')]);
    const game = await direct(SENTENCE, { branch, now: () => (tick += 100), compact: true, check, maxRepairRounds: 2 });
    expect(game).toMatchObject({ source: 'authored', fallbackReason: 'VERB_UNPROVED' });
    expect(game.spec.rules).toBeUndefined();
  });

  it('an answer whose rules all fire goes through untouched', async () => {
    const { game, branch } = await run(answer(), []);
    expect(branch.calls).toHaveLength(1);
    expect(game).toMatchObject({ source: 'authored', fallbackReason: null, repairRounds: 0 });
    expect(game.spec.rules).toHaveLength(3);
  });
});
