/**
 * Pravidla v první odpovědi režiséra (P29A T7). P32B T4 je z první odpovědi
 * vzal, T5b je vrací (B-R5): `GenreSpec` nese `rules`, `ruleRoles` a `things`
 * a modul žánru je přeloží spolu se svými rolemi. Tady se hlídá, že je model
 * má kde napsat, že dojdou do hry, a že čtení odmítne, co by schéma odmítlo i
 * tam, kde ho žádný přenos nevynutí: stub spouštěč `interact` a pravidla na mřížce.
 */

import { describe, expect, it } from 'vitest';

import carryKey from '../arcade/__fixtures__/rules/carry-key.json';
import { type Rule, ruleIssues } from '../arcade/rules/schema';
import { genreAnswer } from '../director/__fixtures__';
import { answered, fakeBranch } from '../director/__fixtures__/branch';
import { GENRE_ANSWER_SCHEMA } from '../director/answer-schema';
import { buildCompactRequest } from '../director/compact';
import { direct } from '../director/index';
import { buildDirectorRequest } from '../director/prompt';
import { readDirectorAnswer } from '../director/read';
import { applyRepairAnswer } from '../director/repair';
import { draftForControl, draftGameSpecWithMeta } from '../draft';

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
  const interact = { interact: { role: 'key', radius: 2, hold: 30, states: 2 } };
  const withInteract = (count: number) => ({ ...carryKey, rules: carryKey.rules.map((rule, i) => (i < count ? { ...rule, when: interact } : rule)) });

  it('an answer with one interact rule reads, two are refused', () => {
    expect(readDirectorAnswer(withInteract(1)).ok).toBe(true);
    const two = readDirectorAnswer(withInteract(2));
    expect(two).toMatchObject({ ok: false });
    expect(!two.ok && two.detail).toContain('/rules/1/when/interact: one interact per game');
  });

  it('refuses interact together with +chaser or +shoot', () => {
    const chased = readDirectorAnswer({ ...withInteract(1), addons: ['chaser'] });
    expect(!chased.ok && chased.detail).toContain('/rules/0/when/interact: interact does not combine with +chaser');
    const shot = readDirectorAnswer({ ...withInteract(1), addons: ['shoot'] });
    expect(!shot.ok && shot.detail).toContain('/rules/0/when/interact: interact does not combine with +shoot');
    // Bez `interact` doplněk projde: odmítá se kombinace, ne doplněk.
    expect(readDirectorAnswer({ ...carryKey, addons: ['chaser'] }).ok).toBe(readDirectorAnswer(carryKey).ok);
  });

  it('counts the interact a quest generator builds for itself', () => {
    const rule = { ...carryKey.rules[0], when: interact } as Rule;
    expect(ruleIssues([rule], [], new Set(['key']))).toEqual([]);
    expect(ruleIssues([rule], [], new Set(['key']), { generator: 'quest_spatial' })).toEqual([expect.stringContaining('the quest already has its own')]);
    expect(ruleIssues([rule], [], new Set(['key']), { generator: 'arena_escape' })).toEqual([]);
  });

  it('a repair patch reads interact like a first answer (B-R6)', () => {
    const game = readDirectorAnswer(carryKey);
    if (!game.ok) throw new Error(game.detail);
    expect(applyRepairAnswer(game.spec, [{ op: 'replace', path: '/rules/0/when', value: interact }]).ok).toBe(true);
    const twice = applyRepairAnswer(game.spec, [
      { op: 'replace', path: '/rules/0/when', value: interact },
      { op: 'replace', path: '/rules/1/when', value: interact },
    ]);
    expect(twice).toMatchObject({ ok: false });
    expect(!twice.ok && twice.detail).toContain('one interact per game');
  });

  it('rules a repair round puts on the tap-to-move grid are refused, not dropped', () => {
    const grid = draftForControl(SENTENCE, 'tap_go');
    if (grid === null) throw new Error('no grid draft');
    const patched = applyRepairAnswer(grid, [{ op: 'add', path: '/rules', value: carryKey.rules }]);
    expect(patched).toMatchObject({ ok: false, reason: 'MALFORMED_SPEC' });
    expect(!patched.ok && patched.detail).toContain('only an arcade game');
  });
});
