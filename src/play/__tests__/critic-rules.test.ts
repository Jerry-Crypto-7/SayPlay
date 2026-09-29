/**
 * Neprokázané sloveso a vadné pravidlo jdou do opravného kola (P29A T8).
 * Rozhoduje se tu bez člověka, co se publikuje: kritik musí sloveso jmenovat,
 * oprava od modelu se musí přijmout, a když nepomůže, pravidlo ze hry vypadne
 * a hra se hraje bez něj – nikdy se nerozbije a nikdy netvrdí sloveso, které
 * se nestalo.
 *
 * Od P32B T4 píše první odpověď `GenreSpec` bez pravidel; do hry je dopíše
 * až opravné kolo. Scénář proto posílá hru ze žánru do opravy neprošlým
 * keypointem a pravidla hodu kamenem přinese záplata RFC 6902. Vadné pravidlo
 * v záplatě se nepřijme vůbec (`applyRepairAnswer`), takže `RULE_INVALID` dnes
 * vzniká jen v kritikovi nad hláškou čtení, ne v režisérovi.
 */

import { isDeepStrictEqual } from 'node:util';

import { describe, expect, it } from 'vitest';

import { arcadeWorldOf } from '../arcade/compile';
import { verifyArcade } from '../arcade/verify';
import { direct } from '../director';
import { genreAnswer } from '../director/__fixtures__';
import { answered, failed, fakeBranch, type ScriptedOutcome } from '../director/__fixtures__/branch';
import throwRock from '../director/__fixtures__/rules-answers/throw-rock.json';
import { ruleInvalidIssues, verbIssues } from '../director/critic';
import { readGenreAnswer, readModelSpec } from '../director/read';
import type { RepairIssue } from '../director/repair';
import { draftForControl } from '../draft';
import type { GameSpecV1 } from '../spec';

const SENTENCE = throwRock.sentence;

/** Pravidla nahrávky v tvaru specu (bez `if: null`). */
const RULES = throwRock.answer.rules.map(({ if: cond, ...rule }) => (cond === null ? rule : { ...rule, if: cond }));
/** Role jen pro pravidla (kámen, zvon), jak je nahrávka napsala, bez `count: null`. */
const RULE_ROLES = throwRock.answer.ruleRoles.map(({ count: _count, ...role }) => ({ ...role, count: 1 }));

/** Šablona ovládání `move_free` s rolemi a pravidly – spec, nad kterým kritik soudí pravidla. */
function withRules(rules: readonly unknown[]) {
  const base = draftForControl(SENTENCE, 'move_free');
  if (base === null) throw new Error('no move_free template for the sentence');
  return readModelSpec({ ...base, roles: [...base.roles, ...RULE_ROLES], rules });
}

/** Robot na seedu 1 jako v publikaci: selhání keypointu nese `VERB_UNPROVED:<sloveso>`. */
function robot(spec: GameSpecV1): RepairIssue[] {
  const made = arcadeWorldOf(spec, 1);
  if (!made.ok) return [{ code: 'WORLD_REJECTED', path: '', evidence: made.issues.join('; '), repairHint: '' }];
  return verifyArcade(made.world).failures.map((failure) => ({ code: 'KEYPOINT_FAILED', path: '/verification/0', evidence: `keypoint failed: ${failure}`, repairHint: 'fix the game or the claim' }));
}

/**
 * První odpověď věrná větě (P32B T5): hlavní sloveso „throw“ hraje jen náhradu
 * (quest.spatial), věrný `ready` režim je sběr v Aréně z „pick up“. Nevěrnou
 * odpověď by kontrola věrnosti přepnula a robot by nad hrou ze žánru nikdy nevystřelil.
 */
const ANSWER = genreAnswer({ mode: 'collect' });

/** Hra, kterou modul žánru složí z první odpovědi – bez pravidel. */
const FIRST = (() => {
  const read = readGenreAnswer(ANSWER);
  if (!read.ok) throw new Error(read.detail);
  return read.spec;
})();

const MISSING: RepairIssue = { code: 'KEYPOINT_FAILED', path: '/verification/0', evidence: 'keypoint failed: the sentence verbs pick, throw, ring never happen', repairHint: 'add rules for them' };

/** Robot `inner`, který navíc neprojde hru ze žánru: pravidla, která věta chce, jí dopíše až opravné kolo. */
const asking =
  (inner: (spec: GameSpecV1) => RepairIssue[]) =>
  (spec: GameSpecV1): RepairIssue[] =>
    isDeepStrictEqual(spec, FIRST) ? [MISSING] : inner(spec);

/** Záplata, která hře ze žánru přidá role a pravidla hodu kamenem a za ně `extra`. */
const addRules = (extra: readonly object[] = [], rules: readonly object[] = RULES) => [
  ...RULE_ROLES.map((value) => ({ op: 'add', path: '/roles/-', value })),
  { op: 'add', path: '/rules', value: [...rules, ...extra] },
];

const NOOP = [{ op: 'replace', path: '/title', value: 'Bell Ringer' }];

/** Pravidlo, které robot před výhrou nikdy nevystřelí: jednou za 90 s. */
const DANCE = { id: 'dance', verb: 'dance', when: { every: 5400 }, do: [{ score: 1 }] };
/** Pravidlo, které vystřelí při každém stisku a nic nezmění: skóre +0. */
const WAVE = { id: 'wave', verb: 'wave', when: { press: 'action' }, do: [{ score: 0 }] };

async function run(repairs: readonly ScriptedOutcome[], check = asking(robot), cache?: Parameters<typeof direct>[1]['cache']) {
  let tick = 0;
  const branch = fakeBranch([answered(ANSWER), ...repairs]);
  const game = await direct(SENTENCE, { branch, now: () => (tick += 100), check, maxRepairRounds: 2, ...(cache === undefined ? {} : { cache }) });
  return { game, branch };
}

const verbsOf = (spec: GameSpecV1) => spec.rules?.map((rule) => rule.verb);

describe('the critic names rule problems', () => {
  it('RULE_INVALID for an unknown role and for an effect outside the language', () => {
    const unknown = withRules([{ ...RULES[0], do: [{ toggle: 'bucket' }] }]);
    expect(unknown.ok).toBe(false);
    if (unknown.ok) return;
    const issues = ruleInvalidIssues(unknown.detail, [{ do: [{ toggle: 'bucket' }] }]);
    expect(issues.map((issue) => issue.code)).toEqual(['RULE_INVALID']);
    expect(issues[0]?.path).toMatch(/^\/rules\/0/);
    expect(issues[0]?.evidence).toContain('bucket');

    const foreign = withRules([{ ...RULES[0], do: [{ explode: true }] }]);
    expect(foreign.ok).toBe(false);
    if (foreign.ok) return;
    expect(ruleInvalidIssues(foreign.detail, []).map((issue) => issue.code)).toContain('RULE_INVALID');
    // Bez vadného efektu se tatáž pravidla přečtou: soudí se pravidlo, ne šablona.
    expect(withRules(RULES).ok).toBe(true);
  });

  it('VERB_UNPROVED names the verb and points at its rule; other findings pass through', () => {
    const spec = { rules: [{ verb: 'pick' }, { verb: 'throw' }] } as unknown as GameSpecV1;
    const other: RepairIssue = { code: 'UNWINNABLE', path: '/verification', evidence: 'the robot player never won the game', repairHint: '' };
    const issues = verbIssues([{ code: 'KEYPOINT_FAILED', path: '/verification/0', evidence: 'keypoint verbs_proved failed: VERB_UNPROVED:throw', repairHint: '' }, other], spec);
    expect(issues).toEqual([expect.objectContaining({ code: 'VERB_UNPROVED', path: '/rules/1' }), other]);
    expect(issues[0]?.evidence).toContain('throw');
  });

  it('VERB_NO_EFFECT goes back like VERB_UNPROVED: named verb, its rule, a hint to make it change something', () => {
    const spec = { rules: [{ verb: 'pick' }, { verb: 'wave' }] } as unknown as GameSpecV1;
    const issues = verbIssues([{ code: 'KEYPOINT_FAILED', path: '/verification/0', evidence: 'keypoint failed: verbs_proved: VERB_NO_EFFECT:wave – fired, nothing changed', repairHint: '' }], spec);
    expect(issues).toEqual([expect.objectContaining({ code: 'VERB_UNPROVED', severity: 'block', path: '/rules/1' })]);
    expect(issues[0]?.evidence).toMatch(/^"wave" VERB_NO_EFFECT/);
    expect(issues[0]?.repairHint).toContain('nonzero');
  });
});

describe('the director repairs a verb that changes nothing', () => {
  it('the no-effect verb goes to the model by name and a repair that removes it is accepted', async () => {
    const { game, branch } = await run([answered(addRules([WAVE])), answered([{ op: 'remove', path: '/rules/3' }])]);
    const sent = branch.calls[2]?.request.user ?? '';
    expect(sent).toContain('VERB_NO_EFFECT');
    expect(sent).toContain('wave');
    expect(game).toMatchObject({ source: 'authored', repairRounds: 2 });
    expect(verbsOf(game.spec)).toEqual(['pick', 'throw', 'ring']);
  });

  it('when repair does not help, the no-effect rule is dropped and the game plays without it', async () => {
    const { game } = await run([answered(addRules([WAVE])), answered(NOOP)]);
    expect(game.fallbackReason).toBe('VERB_UNPROVED');
    expect(verbsOf(game.spec)).toEqual(['pick', 'throw', 'ring']);
    expect(robot(game.spec)).toEqual([]);
  });
});

describe('the director repairs rules before publishing', () => {
  it('rules a repair round writes into the genre game are accepted when they all fire', async () => {
    const { game, branch } = await run([answered(addRules())]);
    expect(branch.calls).toHaveLength(2);
    expect(branch.calls[1]?.request.user).toContain('KEYPOINT_FAILED');
    expect(game).toMatchObject({ source: 'authored', fallbackReason: null, repairRounds: 1 });
    expect(verbsOf(game.spec)).toEqual(['pick', 'throw', 'ring']);
    expect(game.spec.roles.map((role) => role.id)).toEqual([...FIRST.roles.map((role) => role.id), 'rock', 'bell']);
  });

  it('a patch with an invalid rule is refused whole: the game keeps its issue and the next round gets it again', async () => {
    const broken = RULES.map((rule) => (rule.id === 'ring' ? { ...rule, when: { contact: ['rock', 'bucket'] } } : rule));
    const { game, branch } = await run([answered(addRules([], broken)), answered(addRules())]);
    const second = branch.calls[2]?.request.user ?? '';
    expect(second).toContain('KEYPOINT_FAILED');
    // Odmítnutá záplata na spec nesáhla: druhé kolo opravuje hru ze žánru, ne vadná pravidla.
    expect(second).not.toContain('bucket');
    expect(game).toMatchObject({ source: 'authored', fallbackReason: null, repairRounds: 2 });
    expect(verbsOf(game.spec)).toEqual(['pick', 'throw', 'ring']);
  });

  it('an unproved verb goes to the model by name and a repair that removes it is accepted', async () => {
    const { game, branch } = await run([answered(addRules([DANCE])), answered([{ op: 'remove', path: '/rules/3' }])]);
    const sent = branch.calls[2]?.request.user ?? '';
    expect(sent).toContain('VERB_UNPROVED');
    expect(sent).toContain('dance');
    // Sloveso přidala a zase smazala oprava; první odpověď ho slíbit nemohla (P32B T4), hra je autorská celá.
    expect(game).toMatchObject({ source: 'authored', fallbackReason: null });
    expect(verbsOf(game.spec)).toEqual(['pick', 'throw', 'ring']);
  });

  it('when repair does not help, the unproved rule is dropped and the game plays without it', async () => {
    const { game } = await run([answered(addRules([DANCE])), answered(NOOP)]);
    expect(game.fallbackReason).toBe('VERB_UNPROVED');
    expect(game.source).toBe('authored');
    expect(verbsOf(game.spec)).toEqual(['pick', 'throw', 'ring']);
    expect(robot(game.spec)).toEqual([]);
  });

  it('a game that still fails without the unproved rule drops all rules, re-checked by the robot', async () => {
    // Robot, podle kterého hra s jakýmkoli pravidlem neprojde: bez „dance“ je neprohratelná jen hra úplně bez pravidel.
    const strict = (spec: GameSpecV1): RepairIssue[] =>
      spec.rules?.some((rule) => rule.verb === 'dance') === true
        ? [{ code: 'KEYPOINT_FAILED', path: '/verification/0', evidence: 'keypoint failed: verbs_proved: VERB_UNPROVED:dance', repairHint: '' }]
        : (spec.rules ?? []).length > 0
          ? [{ code: 'UNWINNABLE', path: '/verification', evidence: 'the robot player never won the game', repairHint: '' }]
          : [];
    const { game } = await run([answered(addRules([DANCE])), answered(NOOP)], asking(strict));
    expect(game).toMatchObject({ source: 'authored', fallbackReason: 'VERB_UNPROVED' });
    expect(game.spec.rules).toBeUndefined();
  });

  it('a game played without its unproved rule is not cached as a fully authored game', async () => {
    const writes: GameSpecV1[] = [];
    const cache = { id: 'test', read: async () => null, write: async (_: string, spec: GameSpecV1) => void writes.push(spec) };
    const { game } = await run([answered(addRules([DANCE])), answered(NOOP)], asking(robot), cache);
    expect(game.fallbackReason).toBe('VERB_UNPROVED');
    expect(writes).toEqual([]);
  });

  it('a repair outage over an unproved verb still plays the game without it', async () => {
    const { game, branch } = await run([answered(addRules([DANCE])), failed('UPSTREAM_UNAVAILABLE')]);
    expect(branch.calls).toHaveLength(3);
    expect(game).toMatchObject({ source: 'authored', fallbackReason: 'VERB_UNPROVED' });
    expect(verbsOf(game.spec)).toEqual(['pick', 'throw', 'ring']);
  });
});
