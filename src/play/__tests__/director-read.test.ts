/**
 * Čtečka odpovědi režiséra (P23-B T4): osm dobrých odpovědí projde, šest
 * rozbitých spadne **na pojmenovaný důvod** – opravné kolo se řídí důvodem.
 */

import { describe, expect, it } from 'vitest';

import { parseAnswerText } from '@/server/upstream';

import { ANSWER_FIXTURES, BAD_ANSWERS, GOOD_ANSWERS, answerFixture, truncatedAnswerText } from '../director/__fixtures__';
import { readDirectorAnswer } from '../director/read';
import { ARCHETYPE_IDS } from '../registry';

describe('readDirectorAnswer', () => {
  it('accepts all eight model-like answers, one per archetype', () => {
    expect(GOOD_ANSWERS).toHaveLength(8);
    for (const name of GOOD_ANSWERS) {
      const result = readDirectorAnswer(answerFixture(name));
      expect(result.ok, name).toBe(true);
      if (result.ok) expect(ARCHETYPE_IDS).toContain(result.spec.archetype);
    }
  });

  it.each([
    ['bad-unknown-mechanic', 'MECHANIC_REJECTED', 'projectile'],
    // `readGameSpec` hlásí chybějícího hráče jako DANGLING_REFERENCE, ne MALFORMED_SPEC – tvar sedí, odkaz ne.
    ['bad-no-player', 'DANGLING_REFERENCE', 'player'],
    ['bad-foreign-archetype', 'MECHANIC_REJECTED', 'chaser is not allowed in switch_puzzle'],
    ['bad-over-budget', 'BUDGET_EXCEEDED', 'maxEntities'],
    ['bad-worlddoc', 'WRONG_DOCUMENT', 'sim'],
  ] as const)('rejects %s as %s', (name, reason, detail) => {
    const result = readDirectorAnswer(answerFixture(name));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe(reason);
      expect(result.detail).toContain(detail);
    }
  });

  it('cannot read a truncated answer at all – parseAnswerText throws before the reader sees it', () => {
    expect(() => parseAnswerText(truncatedAnswerText())).toThrow();
  });

  it('refuses non-objects without touching the schema', () => {
    for (const body of [null, 'text', 42, ['gamespec.v1']]) {
      const result = readDirectorAnswer(body);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('NOT_AN_OBJECT');
    }
  });

  it('lists thirteen JSON fixtures; the fourteenth is the truncated text', () => {
    expect(ANSWER_FIXTURES).toHaveLength(13);
    expect(BAD_ANSWERS).toHaveLength(5);
  });
});
