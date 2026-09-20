/**
 * Zlatý korpus (P23-B T1) – jediný oracle nad daty: počty, unikátnost,
 * a že patnáct řádků balíčku GPT v něm je doslova.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { ARCHETYPE_IDS } from '@/play/registry';
import { normalizeSentence } from '@/server/answer-cache';

import { GOLDEN_SCHEMA, goldenPrompts, packBucketPrompts } from '../index';
import corpus from '../prompts.json';

const CSV = fileURLToPath(new URL('../../../../docs/play/pack/golden_prompts.csv', import.meta.url));

describe('golden corpus', () => {
  const prompts = goldenPrompts();

  it('has forty prompts with unique ids and unique normalized sentences', () => {
    expect(corpus.schema).toBe(GOLDEN_SCHEMA);
    expect(prompts).toHaveLength(40);
    expect(new Set(prompts.map((p) => p.id)).size).toBe(40);
    expect(new Set(prompts.map((p) => normalizeSentence(p.prompt))).size).toBe(40);
  });

  it('gives every archetype exactly four sentences and eight edge sentences none', () => {
    for (const id of ARCHETYPE_IDS) expect(prompts.filter((p) => p.expectArchetype === id)).toHaveLength(4);
    expect(prompts.filter((p) => p.expectArchetype === null)).toHaveLength(8);
    for (const p of prompts) {
      if (p.expectArchetype !== null) expect(ARCHETYPE_IDS).toContain(p.expectArchetype);
      expect(p.mustTest.length).toBeGreaterThan(0);
      expect(p.prompt.trim()).toBe(p.prompt);
    }
  });

  it('carries the fifteen pack rows verbatim, with the platforming bucket mapped to hazard_crossing', () => {
    const rows = readFileSync(CSV, 'utf8').trim().split('\n').slice(1);
    expect(rows).toHaveLength(15);
    for (const row of rows) {
      const [bucket, prompt, mustTest] = row.split(',');
      const entry = prompts.find((p) => p.prompt === prompt);
      expect(entry, prompt).toBeDefined();
      expect(entry?.bucket).toBe(bucket);
      expect(entry?.mustTest).toEqual(mustTest.split(';'));
      const expected = bucket === 'hazard_platforming' ? 'hazard_crossing' : bucket;
      expect(entry?.expectArchetype).toBe(ARCHETYPE_IDS.includes(expected as never) ? expected : null);
    }
  });

  it('names the eight pack bucket sentences for the live measurement', () => {
    const bucket = packBucketPrompts();
    expect(bucket.map((p) => p.expectArchetype).sort()).toEqual([...ARCHETYPE_IDS].sort());
  });
});
