import { describe, expect, it } from 'vitest';

import { readRoles } from '../../draft/lexicon';
import { extractIntent } from '../extract';

describe('P42 sentence parsing', () => {
  it.each(["dont stop", "don't stop", 'do not stop', 'never stop'])('%s keeps shooting and its actor', prefix => {
    const intent = extractIntent(`a dragon ${prefix} shooting robots`);
    expect(intent.hero).toBe('dragon');
    expect(intent.items).toEqual(expect.arrayContaining([expect.objectContaining({ actor: 'dragon', verb: 'shoot', object: 'robot', essential: true })]));
    expect(intent.negated).not.toContain('shoot');
    expect(intent.items.some(item => item.axis === 'unknown')).toBe(false);
  });

  it('a blanket prohibition overrides an earlier collection request', () => {
    const intent = extractIntent('a dragon collects coins but dont collect anything');
    expect(intent.negated).toContain('collect');
    expect(intent.items.some(item => item.verb === 'collect')).toBe(false);
    expect(intent.hero).toBe('dragon');
  });

  it('keeps independent actions before but dont collect anything', () => {
    const intent = extractIntent('a dragon flies and shoots robots but dont collect anything');
    expect(intent.negated).toContain('collect');
    expect(intent.items.map(item => item.verb)).toEqual(expect.arrayContaining(['glide', 'shoot']));
    expect(intent.items.every(item => item.actor === 'dragon')).toBe(true);
  });

  it('reads a nominal flight as the named hero flying', () => {
    const intent = extractIntent('dragon flight through the mountains');
    expect(intent.hero).toBe('dragon');
    expect(intent.items).toEqual(expect.arrayContaining([expect.objectContaining({ actor: 'dragon', verb: 'glide', axis: 'move' })]));
  });

  it('recognizes the ice setting', () => {
    expect(extractIntent('a seal swimming under the ice, catching fish and avoiding orcas').setting).toBe('snow');
  });

  it.each([
    ['solve a puzzle', 'solve', 'puzzle'],
    ['solve a puzzle to open a door', 'solve', 'puzzle'],
    ['a dolphin sings to whales', 'sing', 'whale'],
  ])('keeps unsupported actions and their objects: %s', (sentence, verb, object) => {
    expect(extractIntent(sentence).items).toEqual(expect.arrayContaining([expect.objectContaining({ axis: 'unknown', verb, object, essential: true })]));
  });

  it('ends a setting before the opponent preposition', () => {
    expect(readRoles('a penguin races on a frozen lake against bears').setting).toBe('frozen lake');
  });
});
