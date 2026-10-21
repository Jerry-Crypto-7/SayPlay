/**
 * Řetěz, nebo jedna hra (P56C T8). Pravidlo, které pošle do řetězu každou větu, projde všechny testy stavby
 * a zabije hloubku jasných vět – proto vedle každé větve řetězu i věty, které musí zůstat jednou hrou.
 */

import { describe, expect, it } from 'vitest';

import { classifyGenre } from '@/play/genre/classify';

import { chainOrSingle, chainReasons } from '../decide';
import { readForChain } from '../read';

const reasons = (sentence: string) => chainReasons(sentence, readForChain(sentence, null), classifyGenre(sentence, null));
const decide = (sentence: string) => chainOrSingle(sentence, readForChain(sentence, null), classifyGenre(sentence, null));

describe('chainOrSingle', () => {
  it('a) two verbs that play different controls make a chain', () => {
    expect(reasons('dodge asteroids and shoot aliens')).toEqual(['multi_verb']);
    expect(reasons('ninja cat wall-jumps up a skyscraper swatting drones and grabbing sushi on the way')).toEqual(['multi_verb']);
  });

  it('b) a sentence the classifier hears nothing in, or only a generic cell by a small margin, makes a chain', () => {
    expect(reasons('a sleepy dragon in fuzy pink slippers')).toEqual(['generic']);
    expect(reasons('a goth teenage ghost with a skateboard and a bad attitude')).toEqual(['generic']);
  });

  it('c) asking for rounds, levels, minigames, challenges or a party makes a chain', () => {
    expect(reasons('three rounds: catch falling apples')).toEqual(['cue']);
    expect(decide('a party for my cat')).toBe('chain');
  });

  it('one clear verb with its own genre stays a single game', () => {
    for (const sentence of [
      'fling a grumpy hedgehog from a slingshot to knock down towers',
      'Slice flying watermelons in half with a samurai spoon!',
      'bang on the pots and pans exactly when the chef taps the beat',
      'stack pizzas as high as the moon',
    ]) {
      expect(reasons(sentence), sentence).toEqual([]);
    }
  });

  it('a generic cell heard by a clear margin stays a single game', () => {
    const ranking = classifyGenre('steer a hot air balloon through the gaps between storm clouds', null);
    expect(`${ranking.ranked[0]!.genre}.${ranking.ranked[0]!.mode}`).toBe('voyage.race');
    expect(decide('steer a hot air balloon through the gaps between storm clouds')).toBe('single');
  });
});
