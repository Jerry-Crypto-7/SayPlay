import { describe, expect, it } from 'vitest';
import { fidelity } from '../../director/critic';
import type { GenreSpec } from '../contract';
import { DEFAULT_LABELS, semanticRoleDefaults } from '../roles';

describe('sport equipment is a contextual semantic default', () => {
  it.each([
    ['basketball free throws', ['basketball', 'hoop']],
    ['mini golf with windmills and loops', ['golf ball', 'hole']],
    ['penalty kicks against a goalkeeper', ['football', 'goal']],
    ['soccer game but the players are hamsters', ['football', 'goal']],
  ] as const)('%s only permits the equipment of that sport', (sentence, labels) => {
    expect(semanticRoleDefaults(sentence)).toEqual(labels);
  });

  it.each(['table tennis vs a robot', 'ping pong against an alien', 'not football: play table tennis'])('only implies a ball, never football equipment for %s', sentence => {
    expect(semanticRoleDefaults(sentence)).toEqual(['ball']);
  });
  it('does not imply sport equipment when throwing a stone', () => expect(semanticRoleDefaults('throw a stone at a can')).toEqual([]));

  it('keeps equipment out of the global label allowance and out of other sports', () => {
    for (const label of ['football', 'goal', 'hoop', 'hole', 'golf ball']) expect(DEFAULT_LABELS.has(label)).toBe(false);
    expect(semanticRoleDefaults('play basketball')).not.toContain('football');
    expect(semanticRoleDefaults('play golf')).not.toContain('goal');
  });

  it.each([
    ['throw a basketball', 'basketball', 'hoop'],
    ['hit a ball while playing mini golf', 'golf ball', 'hole'],
    ['kick a ball while playing soccer', 'football', 'goal'],
  ])('critic accepts implied equipment: %s', (sentence, ball, goal) => {
    const content: GenreSpec = { genre: 'throw', mode: 'default', hero: 'kid', setting: 'field', cast: [{ label: ball, does: 'scenery', verb: 'throw' }, { label: goal, does: 'throw_at' }] };
    expect(fidelity(content, sentence).filter(issue => issue.code === 'CAST_NOT_SAID')).toEqual([]);
  });

  it('critic still rejects football equipment in a sentence about throwing a table tennis ball', () => {
    const content: GenreSpec = { genre: 'throw', mode: 'default', hero: 'kid', setting: 'room', cast: [{ label: 'football', does: 'scenery', verb: 'throw' }, { label: 'goal', does: 'throw_at' }] };
    const problems = fidelity(content, 'throw a table tennis ball at a robot').filter(issue => issue.code === 'CAST_NOT_SAID');
    expect(problems).toEqual(expect.arrayContaining([expect.objectContaining({ path: '/cast/0' }), expect.objectContaining({ path: '/cast/1' })]));
  });
});
