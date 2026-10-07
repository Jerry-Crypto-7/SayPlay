/**
 * Pokrytí sloves (P29A T10): číslo bez rozpadu po větách by nešlo ověřit, tak
 * se hlídá rozpad – každá věta má právě jednu třídu, součet sedí na korpus a
 * commitnutý artefakt je tentýž jako dnešní měření. Šablony musí být platná
 * pravidla jazyka, jinak by pokrytí „po“ slibovalo pravidla, která hra nevezme.
 */

import { beforeAll, describe, expect, it } from 'vitest';

import { ruleIssues, rulesSchema } from '@/play/arcade/rules/schema';
import { RULE_TEMPLATES, TEMPLATE_NAMES, expandTemplate, templateFor } from '@/play/arcade/rules/templates';

import corpus from '../demand/corpus.json';
// Preserve the pre-composer coverage.json baseline; P41's current measurement
// has a separate artifact because sentence selection intentionally changes.
import committed from './coverage-p41.json';
import { measureVerbCoverage, type VerbCoverage } from './coverage';

describe('verb coverage on the demand set', () => {
  let measured: VerbCoverage;
  beforeAll(async () => {
    measured = await measureVerbCoverage();
  }, 120_000); // 200 deterministic drafts, including native physics simulation.

  it('classifies every sentence once and the classes add up to the corpus', () => {
    expect(measured.total).toBe(corpus.length);
    expect(measured.sentences.map((sentence) => sentence.id)).toEqual(corpus.map((entry) => entry.id));
    expect(measured.after.piece + measured.after.template + measured.after.none).toBe(corpus.length);
    expect(measured.before.piece + measured.before.none).toBe(corpus.length);
    expect(measured.before.piece).toBe(measured.after.piece);
    expect(Object.values(measured.byTemplate).reduce((sum, n) => sum + n, 0)).toBe(measured.after.template);
  });

  it('the committed coverage-p41.json is today\'s measurement', () => {
    expect(committed).toEqual(JSON.parse(JSON.stringify(measured)));
  });

  it('lists ten uncovered verbs, most frequent first', () => {
    expect(measured.topUncovered).toHaveLength(10);
    const counts = measured.topUncovered.map((entry) => entry.count);
    expect(counts).toEqual([...counts].sort((a, b) => b - a));
  });
});

describe('rule templates', () => {
  const ROLES = { item: 'rock', goal: 'nest', target: 'bell', lever: 'lever', door: 'gate' } as const;

  it.each(TEMPLATE_NAMES)('%s expands into valid rules of the language', (name) => {
    const rules = expandTemplate(name, ROLES);
    expect(rules).not.toBeNull();
    const parsed = rulesSchema.safeParse(rules);
    expect(parsed.success).toBe(true);
    expect(ruleIssues(parsed.data ?? [], [], new Set(Object.values(ROLES)))).toEqual([]);
    expect(JSON.stringify(rules)).not.toContain('$');
  });

  it('a template without its roles does not expand', () => {
    expect(expandTemplate('throw', { item: 'rock' })).toBeNull();
  });

  it('finds a template by the sentence verb in any common form', () => {
    expect(templateFor('Toss the ball into the hoop')).toBe('throw');
    expect(templateFor('pushing crates in a warehouse')).toBe('push');
    expect(templateFor('stacks of pancakes')).toBe('stack');
    expect(templateFor('a quiet walk in the park')).toBeNull();
    for (const name of TEMPLATE_NAMES) expect(templateFor(`please ${RULE_TEMPLATES[name].verbs[0]} it`)).toBe(name);
  });
});
