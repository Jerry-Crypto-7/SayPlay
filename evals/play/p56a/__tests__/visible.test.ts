/**
 * Slepý soud viditelnosti P56A (T12): co soudce hledá a kdy věta „je vidět“. Číslo `visible-dev.json` stojí na těchhle
 * dvou pravidlech – tiše povolené vynechané slovo by z „nevidím“ udělalo „vidím“.
 */

import { describe, expect, it } from 'vitest';

import { nounsOf, questionOf, verdictOf } from '../visible.mjs';

describe('visible', () => {
  it('asks for the hero and the foe, the item only when the sentence names no foe', () => {
    expect(nounsOf({ hero: 'cat', foe: 'vacuum robot', item: 'couch' })).toEqual(['cat', 'vacuum robot']);
    expect(nounsOf({ hero: 'frog', foe: null, item: 'fly' })).toEqual(['frog', 'fly']);
    expect(nounsOf({ hero: null, foe: 'ghost', item: null })).toEqual(['ghost']);
    expect(questionOf(['frog', 'fly'])).toContain('"frog", "fly"');
  });

  it('sees the sentence only when the judge saw every noun', () => {
    const answer = { scene: 's', nouns: [{ noun: 'Frog', visible: true, seenAs: 'frog' }, { noun: 'fly', visible: false, seenAs: 'coin' }] };
    expect(verdictOf(['frog', 'fly'], answer)).toEqual({ all: false, nouns: [{ noun: 'frog', visible: true, seenAs: 'frog' }, { noun: 'fly', visible: false, seenAs: 'coin' }] });
    expect(verdictOf(['frog'], answer).all).toBe(true);
  });

  it('counts a noun the judge left out as not seen', () => {
    expect(verdictOf(['frog', 'fly'], { scene: 's', nouns: [{ noun: 'frog', visible: true, seenAs: 'frog' }] }).all).toBe(false);
    expect(verdictOf([], { scene: 's', nouns: [] }).all).toBe(false);
  });
});
