/**
 * Pravidla v první odpovědi režiséra (P29A T7) skončila s P32B T4: odpověď je
 * `GenreSpec`, přísný a bez `rules`, `ruleRoles` a `things`, a hru z něj skládá
 * modul žánru. Do hry se pravidla dostanou jen opravným kolem
 * (`critic-rules.test.ts`). Tady se hlídá, že je model v první odpovědi nemá
 * kde napsat ani jak propašovat, a že čtení odmítne, co by schéma odmítlo i tam,
 * kde ho žádný přenos nevynutí: stub spouštěč `interact` a pravidla na mřížce.
 */

import { describe, expect, it } from 'vitest';

import carryKey from '../arcade/__fixtures__/rules/carry-key.json';
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

describe('the first answer carries no rules', () => {
  it('neither the answer schema nor the prompts offer rules, rule roles or things', () => {
    const schema = JSON.stringify(GENRE_ANSWER_SCHEMA);
    for (const key of ['"rules"', '"ruleRoles"', '"things"', '"interact"']) expect(schema, key).not.toContain(key);
    const genre = draftGameSpecWithMeta(SENTENCE).genre;
    const full = buildDirectorRequest(SENTENCE, genre);
    const compact = buildCompactRequest(SENTENCE, genre, true);
    for (const [name, text] of [['director', full.system + full.user], ['compact', compact.system + compact.user]] as const) {
      for (const grammar of ['throwHeld', 'ruleRoles', '"rules"']) expect(text, `${name} ${grammar}`).not.toContain(grammar);
    }
  });

  it('a GenreSpec answer that carries rules is refused – draft + MALFORMED, in either prompt', async () => {
    const body = { plan: 'carry the key', spec: { ...genreAnswer().spec, rules: carryKey.rules, ruleRoles: [], things: [] } };
    for (const compact of [false, true]) {
      const game = await direct(SENTENCE, { branch: fakeBranch([answered(body)]), now: () => 0, compact });
      expect(game, `compact ${String(compact)}`).toMatchObject({ source: 'draft', fallbackReason: 'MALFORMED', calls: 1, failure: { stage: 'read', reason: 'MALFORMED_SPEC' } });
      expect(game.failure?.detail).toContain('rules');
    }
  });
});

describe('reading refuses what no transport enforces', () => {
  it('an answer with the stub interact trigger is refused on the read path', () => {
    // Přenos Messages schéma odpovědi neposílá (revize hranice fáze P32-0): odmítnout musí i čtení.
    const interact = { interact: { role: 'key', radius: 2, hold: 30, states: 2 } };
    const full = readDirectorAnswer({ ...carryKey, rules: carryKey.rules.map((rule, i) => (i === 0 ? { ...rule, when: interact } : rule)) });
    expect(!full.ok && full.detail).toContain('/rules/0/when: interact does nothing yet');
    // Bez `interact` čtení projde: odmítá se spouštěč, ne pravidla.
    expect(readDirectorAnswer(carryKey).ok).toBe(true);
  });

  it('rules a repair round puts on the tap-to-move grid are refused, not dropped', () => {
    const grid = draftForControl(SENTENCE, 'tap_go');
    if (grid === null) throw new Error('no grid draft');
    const patched = applyRepairAnswer(grid, [{ op: 'add', path: '/rules', value: carryKey.rules }]);
    expect(patched).toMatchObject({ ok: false, reason: 'MALFORMED_SPEC' });
    expect(!patched.ok && patched.detail).toContain('only an arcade game');
  });
});
