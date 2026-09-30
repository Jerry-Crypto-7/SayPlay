/**
 * Pravidla v první odpovědi režiséra (P29A T7). P32B T4 je z první odpovědi
 * vzal, T5b je vrací (B-R5): `GenreSpec` nese `rules`, `ruleRoles` a `things`
 * a modul žánru je přeloží spolu se svými rolemi. Tady se hlídá, že je model
 * má kde napsat, že dojdou do hry, a že čtení odmítne, co by schéma odmítlo i
 * tam, kde ho žádný přenos nevynutí: stub spouštěč `interact` a pravidla na mřížce.
 */

import { describe, expect, it } from 'vitest';

import carryKey from '../arcade/__fixtures__/rules/carry-key.json';
import { arcadeWorldOf } from '../arcade/compile';
import { type Rule, ruleIssues } from '../arcade/rules/schema';
import { verifyArcade } from '../arcade/verify';
import { genreAnswer } from '../director/__fixtures__';
import { answered, fakeBranch } from '../director/__fixtures__/branch';
import { GENRE_ANSWER_SCHEMA } from '../director/answer-schema';
import { buildCompactRequest } from '../director/compact';
import { direct } from '../director/index';
import { buildDirectorRequest } from '../director/prompt';
import { readDirectorAnswer, readGenreAnswer } from '../director/read';
import { applyRepairAnswer } from '../director/repair';
import { draftForControl, draftGameSpecWithMeta } from '../draft';
import { readGameSpec } from '../spec';

const SENTENCE = 'carry the key to the old door and open it';

/** Role jen pro pravidla nosiče klíče, jak je model píše do `ruleRoles`. */
const RULE_ROLES = carryKey.roles.filter((role) => role.kind !== 'player');

/** Úkol (sloveso „carry“ hraje `quest.spatial`) s pravidly klíče a dveří, jak by ho napsal model (B-R5). */
const withRules = (rules: readonly unknown[] = carryKey.rules) => ({
  plan: 'carry the key',
  spec: { ...genreAnswer({ genre: 'quest', mode: 'spatial', hero: 'knight', enemy: undefined, collectible: undefined, setting: 'castle courtyard at dusk' }).spec, ruleRoles: RULE_ROLES, rules },
});

// T5b (rozhodnutí B-R5): první odpověď zas nese pravidla – sloveso mimo žánr se neztratí jen proto, že věta dostala žánr.
describe('the first answer carries rules', () => {
  it('the answer schema and both prompts offer rules, rule roles, things and interact', () => {
    const schema = JSON.stringify(GENRE_ANSWER_SCHEMA);
    // B-R8: `interact` model zase smí (pravidlo P32G T1 hraje).
    for (const key of ['"rules"', '"ruleRoles"', '"things"', '"interact"']) expect(schema, key).toContain(key);
    const genre = draftGameSpecWithMeta(SENTENCE).genre;
    const full = buildDirectorRequest(SENTENCE, genre);
    const compact = buildCompactRequest(SENTENCE, genre, true);
    for (const [name, text] of [['director', full.system], ['compact', compact.system]] as const) {
      for (const grammar of ['throwHeld', 'ruleRoles', '"rules"', '"interact"']) expect(text, `${name} ${grammar}`).toContain(grammar);
    }
  });

  it('rules of a GenreSpec answer reach the GameSpec with their roles, in either prompt', async () => {
    for (const compact of [false, true]) {
      const game = await direct(SENTENCE, { branch: fakeBranch([answered(withRules())]), now: () => 0, compact });
      expect(game, `compact ${String(compact)}`).toMatchObject({ source: 'authored', fallbackReason: null, calls: 1, spec: { genre: { id: 'quest', mode: 'spatial' } } });
      expect(game.spec.rules?.map((rule) => rule.verb)).toEqual(['carry', 'open', 'climb']);
      expect(game.spec.roles.map((role) => role.id)).toEqual(expect.arrayContaining(['player', 'key', 'door', 'stairs']));
    }
  });

  it('a rule that does not compile: the genre plays without rules, the repair round gets RULE_INVALID and the lost verbs mark the game', async () => {
    const broken = carryKey.rules.map((rule) => (rule.id === 'climb' ? { ...rule, when: { contact: ['player', 'tower'] } } : rule));
    const branch = fakeBranch([answered(withRules(broken)), answered([{ op: 'replace', path: '/title', value: 'The Locked Tower' }])]);
    const game = await direct(SENTENCE, { branch, now: () => 0 });
    expect(branch.calls[1]?.request.user).toContain('RULE_INVALID');
    expect(branch.calls[1]?.request.user).toContain('tower');
    // Oprava pravidla nedopsala: hra žánru se hraje bez nich a slíbená slovesa ji označí, do cache nejde.
    expect(game).toMatchObject({ source: 'authored', fallbackReason: 'VERB_UNPROVED', failure: { detail: 'rule verbs dropped: carry, open, climb' } });
    expect(game.spec.rules).toBeUndefined();
  });
});

describe('reading refuses what no transport enforces', () => {
  // B-R8: `interact` je zpět; jádro drží jednu rozdělanou práci. Přenos Messages schéma odpovědi neposílá, meze proto soudí čtení.
  const interact = { interact: { role: 'stairs', radius: 2, hold: 30, states: 2 } };
  const climb = carryKey.rules[2] as Rule;
  /** Nosič klíče, kde se na schody vystoupá držením Use; `twice` = druhé takové pravidlo. */
  const withInteract = (twice = false) => ({
    ...carryKey,
    rules: [...carryKey.rules.slice(0, 2), { ...climb, when: interact }, ...(twice ? [{ ...climb, id: 'climb_again', when: interact }] : [])],
  });

  it('an answer with one interact rule reads, two are refused', () => {
    expect(readDirectorAnswer(withInteract()).ok).toBe(true);
    const two = readDirectorAnswer(withInteract(true));
    expect(two).toMatchObject({ ok: false });
    expect(!two.ok && two.detail).toContain('/rules/3/when/interact: one interact per game');
  });

  it('refuses interact together with +chaser or +shoot', () => {
    const chased = readDirectorAnswer({ ...withInteract(), addons: ['chaser'] });
    expect(!chased.ok && chased.detail).toContain('/rules/2/when/interact: interact does not combine with +chaser');
    const shot = readDirectorAnswer({ ...withInteract(), addons: ['shoot'] });
    expect(!shot.ok && shot.detail).toContain('/rules/2/when/interact: interact does not combine with +shoot');
    // Bez `interact` doplněk projde: odmítá se kombinace, ne doplněk.
    expect(readDirectorAnswer({ ...carryKey, addons: ['chaser'] }).ok).toBe(readDirectorAnswer(carryKey).ok);
  });

  // Revize fáze 3, nález 1: `interact` vyhraje, až jsou hotové jeho cíle, a Use drží jen robot pravidel dvorku.
  it('interact must be the winning rule of a yard – elsewhere no robot holds Use', () => {
    const rule = { ...climb, when: interact } as Rule;
    const side = { ...rule, do: [{ score: 1 }] } as Rule;
    const roles = new Set(['stairs']);
    expect(ruleIssues([rule], [], roles, { yard: true })).toEqual([]);
    expect(ruleIssues([rule], [], roles)).toEqual([expect.stringContaining('/rules/0/when/interact: interact wins once its targets are done')]);
    expect(ruleIssues([side], [], roles, { yard: true })).toEqual([expect.stringContaining('make it the winning rule')]);
    expect(ruleIssues([rule], [], roles, { yard: true, generator: 'quest_spatial' })).toEqual([expect.stringContaining('the quest already has its own')]);
    expect(ruleIssues([rule], [], roles, { yard: true, generator: 'arena_escape' })).toEqual([]);
  });

  it('a genre answer with a side interact is refused, a winning one reads, plays and wins', () => {
    const ring = { id: 'ring', verb: 'ring', when: { interact: { role: 'door', radius: 2, hold: 30, states: 2 } }, do: [{ win: true }] };
    const arena = withRules([{ ...ring, do: [{ score: 1 }] }]);
    const side = readGenreAnswer({ ...arena, spec: { ...arena.spec, genre: 'arena', mode: 'collect' } });
    expect(!side.ok && side.detail).toContain('make it the winning rule');
    const game = readGenreAnswer(withRules([ring]));
    if (!game.ok) throw new Error(game.detail);
    for (const seed of [1, 2, 3]) {
      const made = arcadeWorldOf(game.spec, seed);
      if (!made.ok) throw new Error(made.issues.join('; '));
      expect({ seed, ...verifyArcade(made.world) }).toMatchObject({ seed, bot: { outcome: 'won' }, failures: [] });
    }
  });

  it('a repair patch reads interact like a first answer (B-R6)', () => {
    const game = readDirectorAnswer(carryKey);
    if (!game.ok) throw new Error(game.detail);
    expect(applyRepairAnswer(game.spec, [{ op: 'replace', path: '/rules/2/when', value: interact }]).ok).toBe(true);
    const twice = applyRepairAnswer(game.spec, [
      { op: 'replace', path: '/rules/2/when', value: interact },
      { op: 'add', path: '/rules/-', value: { ...climb, id: 'climb_again', when: interact } },
    ]);
    expect(twice).toMatchObject({ ok: false });
    expect(!twice.ok && twice.detail).toContain('one interact per game');
  });

  it('a patch adding a winning interact to a quest reads like the same rule in a first answer', () => {
    const quest = readGenreAnswer(withRules([]));
    if (!quest.ok) throw new Error(quest.detail);
    expect(quest.spec.controlParams).toMatchObject({ generator: expect.stringMatching(/^quest_/) });
    const ring = { id: 'ring', verb: 'ring', when: { interact: { role: 'door', radius: 2, hold: 30, states: 2 } }, do: [{ win: true }] };
    // Role pravidel (dveře) přeložená odpověď už nese; záplata dopíše jen pravidlo.
    const patched = applyRepairAnswer(quest.spec, [{ op: 'add', path: '/rules', value: [ring] }]);
    expect(patched).toMatchObject({ ok: true });
    expect(patched.ok && patched.spec.controlParams).not.toMatchObject({ generator: expect.anything() });
    expect(readGenreAnswer(withRules([ring])).ok).toBe(true);
  });

  // B-R10 (revize T7, nález 5): uložená hra z `POST {spec}` dvorkem neprojde – svět generátor úkolu
  // postaví a jeho vlastní `interact` sdílí jediný čítač rozdělané práce s pravidlem.
  it('a stored quest spec that still carries its generator is refused a winning interact at read', () => {
    const quest = readGenreAnswer(withRules([]));
    if (!quest.ok) throw new Error(quest.detail);
    const ring = { id: 'ring', verb: 'ring', when: { interact: { role: 'door', radius: 2, hold: 30, states: 2 } }, do: [{ win: true }] };
    const posted = readGameSpec({ ...quest.spec, rules: [ring] });
    expect(posted).toMatchObject({ ok: false, reason: 'DANGLING_REFERENCE' });
    expect(!posted.ok && posted.issues).toEqual([expect.stringContaining('the quest already has its own')]);
  });

  it('rules a repair round puts on the tap-to-move grid are refused, not dropped', () => {
    const grid = draftForControl(SENTENCE, 'tap_go');
    if (grid === null) throw new Error('no grid draft');
    const patched = applyRepairAnswer(grid, [{ op: 'add', path: '/rules', value: carryKey.rules }]);
    expect(patched).toMatchObject({ ok: false, reason: 'MALFORMED_SPEC' });
    expect(!patched.ok && patched.detail).toContain('only an arcade game');
  });
});
