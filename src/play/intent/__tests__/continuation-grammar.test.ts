import { describe, expect, it } from 'vitest';
import { extractIntent } from '../extract';
import { nounPhrase } from '../../draft/lexicon';

describe('continuation, partitives and plural vehicles', () => {
  it.each(['above', 'below', 'beneath', 'beyond', 'beside'])('ends shared draft noun phrases before %s', preposition => {
    expect(nounPhrase(`a parrot ${preposition} the jungle`)).toBe('parrot');
  });
  it.each([
    ['never stop flapping as a parrot above the jungle', 'parrot', 'flap'],
    ['dont stop jumping as a rabbit below the clouds', 'rabbit', 'jump'],
    ['do not stop running as a fox beside the river', 'fox', 'run'],
  ])('keeps continued action and the named actor: %s', (sentence, actor, verb) => {
    const intent = extractIntent(sentence);
    expect(intent.hero).toBe(actor);
    expect(intent.items).toContainEqual(expect.objectContaining({ actor, axis: 'move', verb, essential: true }));
    expect(intent.negated).not.toContain(verb);
  });
  it.each(['never flap', 'dont flap', 'do not flap'])('preserves direct prohibition: %s', sentence => {
    const intent = extractIntent(sentence);
    expect(intent.items.some(item => item.verb === 'flap')).toBe(false);
    expect(intent.negated).toContain('flap');
  });
  it.each([
    ['bake a loaf of bread for a hungry giant', 'bake', 'bread'],
    ['bake two loaves of sourdough bread', 'bake', 'bread'],
    ['collect a handful of shiny gems', 'collect', 'gem'],
    ['deliver a box of apples', 'deliver', 'apple'],
    ['bake a loaf-shaped cake', 'bake', 'cake'],
  ])('uses contents only for actual partitives: %s', (sentence, verb, object) => {
    expect(extractIntent(sentence).items).toContainEqual(expect.objectContaining({ verb, object, essential: true }));
  });
  it.each([
    ['a race with dune buggies', 'buggy', 'drive'],
    ['a race with beach buggies', 'buggy', 'drive'],
    ['a race with yellow taxis', 'taxi', 'drive'],
    ['a race with hovercrafts', 'hovercraft', 'drive'],
  ])('recognizes plural vehicles in a nominal race: %s', (sentence, actor, verb) => {
    const intent = extractIntent(sentence);
    expect(intent.hero).toBe(actor);
    expect(intent.items).toContainEqual(expect.objectContaining({ axis: 'move', actor, verb }));
    expect(intent.items).toContainEqual(expect.objectContaining({ axis: 'objective', actor, verb: 'race' }));
  });
  it('does not invent a vehicle from similar words', () => {
    const intent = extractIntent('a baggage race with dogs');
    expect(intent.items.some(item => item.verb === 'drive')).toBe(false);
  });
});
