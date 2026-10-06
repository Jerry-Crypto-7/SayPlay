import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { extractIntent } from '../extract';
import type { IntentTriple } from '../contract';

interface LabeledSentence {
  id: string;
  sentence: string;
  essential: IntentTriple[];
}

// Deliberately enumerate development groups. The held-out group is never iterated,
// extracted or used as a tuning/acceptance target before the final measurement.
const corpus = JSON.parse(readFileSync('evals/play/p41/sentences.json', 'utf8')) as { groups: Record<string, LabeledSentence[]> };
const development = ['multi-action', 'paraphrase', 'negation', 'unsupported', 'single'].flatMap(group => corpus.groups[group]);

describe('P41 hand-labeled development intent coverage', () => {
  it.each(development)('$id: $sentence', ({ id, sentence, essential }) => {
    const actual = extractIntent(sentence).items.filter(item => item.essential);
    const missing = essential.filter(wanted => !actual.some(item => item.actor === wanted.actor && item.verb === wanted.verb && item.object === wanted.object));
    expect(missing, id).toEqual([]);
  });

  it.each([
    ['a fox sings opera', 'sing', 'opera', 'beat'],
    ['a fox plays the piano', 'play', 'piano', 'beat'],
    ['play chess with a troll', 'play', 'chess', 'duel'],
    ['shoot a movie about robots', 'film', 'movie', 'shoot'],
  ])('does not certify a specialized request with a generic mechanic: %s', (sentence, verb, object, fallback) => {
    const items = extractIntent(sentence).items;
    expect(items).toContainEqual(expect.objectContaining({ axis: 'unknown', verb, object, essential: true }));
    expect(items.filter(item => item.verb === fallback).every(item => !item.essential)).toBe(true);
  });
});
