/**
 * Neprokázané sloveso a vadné pravidlo jdou do opravného kola (P29A T8).
 * Rozhoduje se tu bez člověka, co se publikuje: kritik musí sloveso jmenovat,
 * oprava od modelu se musí přijmout, a když nepomůže, pravidlo ze hry vypadne
 * a hra se hraje bez něj – nikdy se nerozbije a nikdy netvrdí sloveso, které
 * se nestalo.
 *
 * P32B T4 vzal pravidla z první odpovědi, T5b je vrací (B-R5): `GenreSpec`
 * nese pravidla hodu kamenem a modul žánru je přeloží spolu se svými rolemi.
 * Scénář proto jako v P29A posílá pravidla v první odpovědi, jen žánrové.
 */

import { describe, expect, it } from 'vitest';

import { arcadeWorldOf } from '../arcade/compile';
import { verifyArcade } from '../arcade/verify';
import { direct } from '../director';
import { genreAnswer } from '../director/__fixtures__';
import { answered, failed, fakeBranch } from '../director/__fixtures__/branch';
import throwRock from '../director/__fixtures__/rules-answers/throw-rock.json';
import { ruleInvalidIssues, verbIssues } from '../director/critic';
import { readModelSpec } from '../director/read';
import type { RepairIssue } from '../director/repair';
import { draftForControl } from '../draft';
import type { GameSpecV1 } from '../spec';

/**
 * Věta nahrávky „… throw it at the old bronze bell“ je od P36A T10 žánr Hod a režisér
 * odpověď v Úkolu přepne na něj. Tenhle soubor zkouší opravné kolo pravidel, ne volbu
 * žánru, proto věta, jejíž hlavní sloveso (`hit`) dál hraje prostorový úkol.
 */
const SENTENCE = 'pick up a round rock and hit the old bronze bell with it';

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
 * První odpověď věrná větě: „hit the old bronze bell“ je zásah, takže hlavní sloveso
 * hraje úkol (`quest.spatial`, se skutečnými moduly `ready`). Pravidla, jejich
 * role a `if: null` jsou, jak je model píše v přísném schématu.
 */
const answer = (rules: readonly unknown[] = throwRock.answer.rules) => ({
  plan: throwRock.answer.plan,
  spec: {
    ...genreAnswer({ genre: 'quest', mode: 'spatial', hero: 'shepherd', cast: undefined, setting: throwRock.answer.setting, palette: undefined }).spec,
    ruleRoles: throwRock.answer.ruleRoles,
    things: null,
    rules,
  },
});

/** Pravidlo, které robot před výhrou nikdy nevystřelí: jednou za 90 s. */
const DANCE = { id: 'dance', verb: 'dance', when: { every: 5400 }, if: null, do: [{ score: 1 }] };
/** Pravidlo, které vystřelí při každém stisku a nic nezmění: skóre +0. */
const WAVE = { id: 'wave', verb: 'wave', when: { press: 'action' }, if: null, do: [{ score: 0 }] };

const NOOP = [{ op: 'replace', path: '/title', value: 'Bell Ringer' }];
/** Pravidlo zvonu míří na roli, která není: `RULE_INVALID`. */
const BUCKET = [{ ...throwRock.answer.rules[0]!, when: { contact: ['player', 'bucket'] } }];

async function run(first: object, repairs: readonly unknown[], check = robot, cache?: Parameters<typeof direct>[1]['cache']) {
  let tick = 0;
  const branch = fakeBranch([answered(first), ...repairs.map((body) => answered(body))]);
  const game = await direct(SENTENCE, { branch, now: () => (tick += 100), compact: true, check, maxRepairRounds: 2, ...(cache === undefined ? {} : { cache }) });
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
    const { game, branch } = await run(answer([...throwRock.answer.rules, WAVE]), [[{ op: 'remove', path: '/rules/3' }]]);
    const sent = branch.calls[1]?.request.user ?? '';
    expect(sent).toContain('VERB_NO_EFFECT');
    expect(sent).toContain('wave');
    expect(verbsOf(game.spec)).toEqual(['pick', 'throw', 'ring']);
  });

  it('when repair does not help, the no-effect rule is dropped and the game plays without it', async () => {
    const { game } = await run(answer([...throwRock.answer.rules, WAVE]), [NOOP, NOOP]);
    expect(game.fallbackReason).toBe('VERB_UNPROVED');
    expect(verbsOf(game.spec)).toEqual(['pick', 'throw', 'ring']);
    expect(robot(game.spec)).toEqual([]);
  });
});

describe('the director repairs rules before publishing', () => {
  it('rules of the first answer reach the GameSpec of the genre and go through untouched when they all fire', async () => {
    const { game, branch } = await run(answer(), []);
    expect(branch.calls).toHaveLength(1);
    expect(game).toMatchObject({ source: 'authored', fallbackReason: null, repairRounds: 0, spec: { genre: { id: 'quest', mode: 'spatial' } } });
    expect(verbsOf(game.spec)).toEqual(['pick', 'throw', 'ring']);
    expect(game.spec.roles.map((role) => role.id)).toEqual(expect.arrayContaining(['player', 'rock', 'bell']));
    expect(robot(game.spec)).toEqual([]);
  });

  it('an invalid rule goes to the model with its reason and the repaired rules are accepted', async () => {
    const broken = throwRock.answer.rules.map((rule) => (rule.id === 'ring' ? { ...rule, when: { contact: ['rock', 'bucket'] } } : rule));
    const { game, branch } = await run(answer(broken), [[{ op: 'add', path: '/rules', value: RULES }]]);
    const sent = branch.calls[1]?.request.user ?? '';
    expect(sent).toContain('RULE_INVALID');
    expect(sent).toContain('bucket');
    expect(game).toMatchObject({ source: 'authored', fallbackReason: null, repairRounds: 1 });
    expect(verbsOf(game.spec)).toEqual(['pick', 'throw', 'ring']);
  });

  it('a patch with an invalid rule is refused whole: the game keeps its issue and the next round gets it again', async () => {
    const { game, branch } = await run(answer([...throwRock.answer.rules, DANCE]), [[{ op: 'add', path: '/rules/-', value: { ...DANCE, when: { contact: ['player', 'bucket'] } } }], [{ op: 'remove', path: '/rules/3' }]]);
    const second = branch.calls[2]?.request.user ?? '';
    // Odmítnutá záplata na spec nesáhla: druhé kolo dostane zase neprokázané „dance“, ne vadnou roli.
    expect(second).toContain('VERB_UNPROVED');
    expect(second).not.toContain('bucket');
    expect(game).toMatchObject({ source: 'authored', repairRounds: 2 });
    expect(verbsOf(game.spec)).toEqual(['pick', 'throw', 'ring']);
  });

  it('an unproved verb goes to the model by name and a repair that removes it is accepted', async () => {
    const { game, branch } = await run(answer([...throwRock.answer.rules, DANCE]), [[{ op: 'remove', path: '/rules/3' }]]);
    const sent = branch.calls[1]?.request.user ?? '';
    expect(sent).toContain('VERB_UNPROVED');
    expect(sent).toContain('dance');
    // Oprava sloveso smazala: hra jde dál, ale nesmí se tvářit jako plně autorská (revize fáze 2 P29A).
    expect(game).toMatchObject({ source: 'authored', fallbackReason: 'VERB_UNPROVED' });
    expect(verbsOf(game.spec)).toEqual(['pick', 'throw', 'ring']);
  });

  it('when repair does not help, the unproved rule is dropped and the game plays without it', async () => {
    const { game } = await run(answer([...throwRock.answer.rules, DANCE]), [NOOP, NOOP]);
    expect(game.fallbackReason).toBe('VERB_UNPROVED');
    expect(game.source).toBe('authored');
    expect(verbsOf(game.spec)).toEqual(['pick', 'throw', 'ring']);
    expect(robot(game.spec)).toEqual([]);
  });

  it('when a rule stays invalid, the genre plays without rules', async () => {
    const bad = [{ op: 'add', path: '/rules', value: BUCKET.map(({ if: cond, ...rule }) => (cond === null ? rule : { ...rule, if: cond })) }];
    const { game } = await run(answer(BUCKET), [bad, bad]);
    expect(game).toMatchObject({ source: 'authored', fallbackReason: 'VERB_UNPROVED', spec: { genre: { id: 'quest', mode: 'spatial' } } });
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
    const { game } = await run(answer([...throwRock.answer.rules, DANCE]), [NOOP, NOOP], strict);
    expect(game).toMatchObject({ source: 'authored', fallbackReason: 'VERB_UNPROVED' });
    expect(game.spec.rules).toBeUndefined();
  });

  it('a game played without its unproved rule, or with an empty repair over invalid rules, is not cached as a fully authored game', async () => {
    for (const [first, repair] of [
      [answer([...throwRock.answer.rules, DANCE]), NOOP],
      [answer(BUCKET), []],
    ] as const) {
      const writes: GameSpecV1[] = [];
      const cache = { id: 'test', read: async () => null, write: async (_: string, spec: GameSpecV1) => void writes.push(spec) };
      const { game } = await run(first, [repair, repair], robot, cache);
      expect(game.fallbackReason).toBe('VERB_UNPROVED');
      expect(writes).toEqual([]);
    }
  });

  it('a repair outage over an unproved verb or invalid rules still plays the game without them', async () => {
    for (const [first, verbs] of [
      [answer([...throwRock.answer.rules, DANCE]), ['pick', 'throw', 'ring']],
      [answer(BUCKET), undefined],
    ] as const) {
      let tick = 0;
      const branch = fakeBranch([answered(first), failed('UPSTREAM_UNAVAILABLE')]);
      const game = await direct(SENTENCE, { branch, now: () => (tick += 100), compact: true, check: robot, maxRepairRounds: 2 });
      expect(branch.calls).toHaveLength(2);
      expect(game).toMatchObject({ source: 'authored', fallbackReason: 'VERB_UNPROVED' });
      expect(verbsOf(game.spec)).toEqual(verbs);
    }
  });
});
