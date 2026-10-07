import { describe, expect, it } from 'vitest';
import { extractIntent } from '../extract';

describe('coordinated actions and separated opponents', () => {
  it.each([
    ['hockey on a frozen lake against robots', 'robot'],
    ['football in a forest versus bears', 'bear'],
    ['a penguin plays basketball at school against a walrus', 'walrus'],
    ['a car races through the city against trucks', 'truck'],
  ])('finds opponents after a location: %s', (sentence, actor) => {
    expect(extractIntent(sentence).items).toContainEqual(expect.objectContaining({ axis: 'threat', verb: 'rival', actor, essential: true }));
  });
  it('does not borrow an opponent from another clause', () => {
    const intent = extractIntent('play hockey on a lake while a knight fights against a dragon');
    expect(intent.items.some(item => item.verb === 'rival')).toBe(false);
  });

  it.each([
    ['a boxer punches to the beat and defeats a robot', 'boxer', 'robot', 'duel'],
    ['a knight attacks and vanquishes a dragon', 'knight', 'dragon', 'duel'],
    ['a pirate battles and defeats the captain', 'pirate', 'captain', 'duel'],
    ['a knight attacks and defeats the dragons', 'knight', 'dragon', 'fight'],
  ])('shares the later defeat target with combat: %s', (sentence, actor, object, verb) => {
    expect(extractIntent(sentence).items).toContainEqual(expect.objectContaining({ axis: 'action', actor, object, verb, essential: true }));
  });
  it.each([
    'a boxer punches while a knight defeats a dragon',
    'a boxer punches but never defeats a dragon',
  ])('does not transfer targets from another actor or a prohibited goal: %s', sentence => {
    expect(extractIntent(sentence).items.some(item => item.actor === 'boxer' && item.object === 'dragon' && item.axis === 'action')).toBe(false);
  });

  it.each([
    'drive a boat, race and fire',
    'a pirate sails and fires',
    'run through a forest, then fire!',
    'a boat race with a cannon',
    'a truck race with cannons',
  ])('retains implicit or coordinated shooting: %s', sentence => {
    const intent = extractIntent(sentence);
    expect(intent.items).toContainEqual(expect.objectContaining({ axis: 'action', verb: 'shoot', essential: true }));
    expect(intent.items.some(item => item.axis === 'threat' && item.actor === 'fire')).toBe(false);
  });
  it.each(['drive a boat and dont fire', 'a boat race without a cannon'])('preserves shooting negation: %s', sentence => {
    const intent = extractIntent(sentence);
    expect(intent.items.some(item => item.verb === 'shoot')).toBe(false);
    expect(intent.negated).toContain('shoot');
  });
  it.each(['a knight avoids fire', 'a knight avoids lava and fire', 'a forest with fire'])('keeps fire as a hazard: %s', sentence => {
    const intent = extractIntent(sentence);
    expect(intent.items.some(item => item.verb === 'shoot')).toBe(false);
    expect(intent.items).toContainEqual(expect.objectContaining({ actor: 'fire', verb: 'hazard' }));
  });
});
