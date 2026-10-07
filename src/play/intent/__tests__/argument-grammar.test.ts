import { describe, expect, it } from 'vitest';
import { extractIntent } from '../extract';

describe('phrasal combat, projectile targets and named weather', () => {
  it.each([
    ['punch a robot to the rhythm and knock it out', 'robot'],
    ['attack a troll and take him down', 'troll'],
    ['a knight punches the captain and beats her up', 'captain'],
  ])('resolves a separable defeat pronoun: %s', (sentence, object) => {
    const items = extractIntent(sentence).items;
    expect(items).toContainEqual(expect.objectContaining({ axis: 'action', verb: 'duel', object, essential: true }));
    expect(items).toContainEqual(expect.objectContaining({ axis: 'objective', verb: 'defeat', object }));
    expect(items.some(item => /^(it|him|her|them)$/.test(item.object ?? ''))).toBe(false);
  });
  it('retains plural combat and negated defeat', () => {
    const intent = extractIntent('punch the robots but never knock them out');
    expect(intent.items).toContainEqual(expect.objectContaining({ verb: 'fight', object: 'robot' }));
    expect(intent.items.some(item => item.verb === 'defeat')).toBe(false);
    expect(intent.negated).toContain('defeat');
  });
  it.each([
    ['bake chocolate cookies for the king', 'cookie'],
    ['bake apple pies for a dragon', 'pie'],
    ['a rabbit bakes carrot cakes', 'cake'],
    ['baking fresh bread in a kitchen', 'bread'],
  ])('preserves unsupported baking with a modified object: %s', (sentence, object) => {
    expect(extractIntent(sentence).items).toContainEqual(expect.objectContaining({ axis: 'unknown', verb: 'bake', object, essential: true }));
  });
  it.each([
    ['throw pebbles at a tin can', 'can'],
    ['throw apples toward a scarecrow', 'scarecrow'],
    ['throw stones at an empty metal can', 'can'],
    ['a monkey throws coconuts into a basket', 'basket'],
    ['shoot acorns at a robot', 'robot'],
  ])('uses the aimed target instead of ammunition: %s', (sentence, object) => {
    expect(extractIntent(sentence).items).toContainEqual(expect.objectContaining({ axis: 'action', verb: sentence.startsWith('shoot') ? 'shoot' : 'throw', object }));
  });
  it('does not reinterpret collection as aiming', () => {
    expect(extractIntent('collect pebbles at a lake').items).toContainEqual(expect.objectContaining({ verb: 'collect', object: 'pebble' }));
  });
  it.each([
    ['survive a hailstorm in a boat', 'hailstorm'],
    ['a fox runs through a snowstorm', 'snowstorm'],
    ['drive through sandstorms', 'sandstorm'],
    ['escape from a blizzard', 'blizzard'],
  ])('names the weather threat: %s', (sentence, actor) => {
    expect(extractIntent(sentence).items).toContainEqual(expect.objectContaining({ axis: 'threat', verb: 'hazard', actor, essential: true }));
  });
  it('respects negated weather', () => {
    expect(extractIntent('a boat race without hailstorms').items.some(item => item.actor === 'hailstorm')).toBe(false);
  });
});
