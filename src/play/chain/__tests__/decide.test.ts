/**
 * Řetěz, nebo jedna hra (P56C T8). Pravidlo, které pošle do řetězu každou větu, projde všechny testy stavby
 * a zabije hloubku jasných vět – proto vedle každé větve řetězu i věty, které musí zůstat jednou hrou.
 */

import { describe, expect, it } from 'vitest';

import { classifyGenre } from '@/play/genre/classify';
import type { Reading } from '@/play/read/schema';

import { chainOrSingle, chainReasons } from '../decide';
import { readForChain } from '../read';

const reasons = (sentence: string) => chainReasons(sentence, readForChain(sentence, null), classifyGenre(sentence, null));
const decide = (sentence: string) => chainOrSingle(sentence, readForChain(sentence, null), classifyGenre(sentence, null));

describe('chainOrSingle', () => {
  it('a) two verbs that play different controls make a chain', () => {
    expect(reasons('dodge asteroids and shoot aliens')).toEqual(['multi_verb']);
    expect(reasons('ninja cat wall-jumps up a skyscraper swatting drones and grabbing sushi on the way')).toEqual(['multi_verb']);
  });

  it('b) a sentence the classifier hears nothing in makes a chain', () => {
    expect(reasons('a sleepy dragon in fuzy pink slippers')).toEqual(['generic']);
    expect(decide('a desert of pink sand under three moons')).toBe('chain');
  });

  // P61 T4: slyšená obecná buňka hraje jednu hru (dřív `generic` s náskokem pod 3), počítaný cíl i se dvěma slovesy.
  describe('a heard sentence plays one game (P61 T4)', () => {
    const KNIGHT = 'A knight must collect three keys in a haunted castle while dodging ghosts.';

    it('a generic cell heard by a small margin stays a single game', () => {
      const ranking = classifyGenre('a goth teenage ghost with a skateboard and a bad attitude', null);
      expect(`${ranking.ranked[0]!.genre}.${ranking.ranked[0]!.mode}`).toBe('runner.default');
      expect(ranking.ranked[0]!.score - ranking.ranked[1]!.score).toBeLessThan(3);
      expect(reasons('a goth teenage ghost with a skateboard and a bad attitude')).toEqual([]);
    });

    it('collecting a counted item on a heard generic cell is one game even with a second verb', () => {
      const ranking = classifyGenre(KNIGHT, null);
      expect(`${ranking.ranked[0]!.genre}.${ranking.ranked[0]!.mode}`).toBe('arena.escape');
      expect(readForChain(KNIGHT, null).verbs.map((verb) => verb.class)).toEqual(['move_free', 'steer']);
      expect(reasons(KNIGHT)).toEqual([]);
      // Bez počtu, nebo s počtem jiné věci než té sbírané, zůstanou dvě slovesa řetězem.
      expect(reasons('A knight must collect keys in a haunted castle while dodging ghosts.')).toEqual(['multi_verb']);
      expect(reasons('A knight with two swords collects keys in a haunted castle while dodging ghosts.')).toEqual(['multi_verb']);
    });

    it('two verbs without a counted goal, an unheard sentence and asking for rounds still make a chain', () => {
      expect(reasons('A corgi runs through a park grabbing sausages and jumping over sprinklers')).toEqual(['multi_verb']);
      expect(reasons('Captain Biscuit, a very serious corgi astronaut.')).toEqual(['generic']);
      expect(decide(`${KNIGHT} Make it five levels.`)).toBe('chain');
      expect(reasons(`${KNIGHT} Make it five levels.`)).toEqual(['cue']);
    });
  });

  it('c) asking for rounds, levels, minigames, challenges or a party makes a chain', () => {
    expect(reasons('three rounds: catch falling apples')).toEqual(['cue']);
    expect(decide('a party for my cat')).toBe('chain');
    // „party“ jako přívlastek věci o víc her nežádá – startovní věta zůstane jednou hrou (T10).
    expect(reasons('Carry a fragile cake across a kitchen to a party table.')).toEqual([]);
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

  // T17b: uložená čtení gpt-oss-20b (P56A, `evals/play/p56a/readings`). Čtení dává svému žánru +4, takže klasifikátor
  // „slyší“ vždy – věta bez hratelného slovesa se pozná až podle sloves čtení.
  describe('with a model reading', () => {
    const none = { seconds: null, counts: [] };
    const read = (sentence: string, reading: Reading) => chainReasons(sentence, readForChain(sentence, reading), classifyGenre(sentence, reading));

    it('two verbs the model reads that play different controls make a chain', () => {
      const sentence = 'obby game with lava and spinning bars';
      const reading: Reading = { control: 'platform', verbs: [{ word: 'platform', class: 'platform' }, { word: 'timing', class: 'timing' }], hero: null, roles: [{ noun: 'lava', kind: 'obstacle', count: null }, { noun: 'spinning bars', kind: 'obstacle', count: null }], setting: null, mood: null, numbers: none, genre: { genre: 'platformer', mode: 'default' }, sure: true, foe: null, item: null, world: null, title: 'Obby Game with Lava and Spinning' };
      expect(read(sentence, reading)).toContain('multi_verb');
    });

    it('a reading with no playable verb makes a chain even though its genre gets the reading bonus', () => {
      const sentence = 'purple elephants doing taxes on a volcano';
      const reading: Reading = { control: 'tap_go', verbs: [{ word: 'idle', class: 'idle' }], hero: null, roles: [{ noun: 'taxes', kind: 'collectible', count: null }], setting: 'volcano', mood: null, numbers: none, genre: { genre: 'quest', mode: 'spatial' }, sure: true, foe: null, item: 'taxes', world: null, title: 'Purple Elephants Doing Taxes' };
      expect(read(sentence, reading)).toEqual(['generic']);
    });

    it('a reading that lands on a chain microgame stays a single game even when the model calls the verb idle', () => {
      const sentence = 'a wizard defends his tower from goblin hordes';
      const reading: Reading = { control: 'lanes', verbs: [{ word: 'defends', class: 'idle' }], hero: 'wizard', roles: [{ noun: 'goblin hordes', kind: 'threat', count: null }], setting: 'tower', mood: null, numbers: none, genre: { genre: 'defense', mode: 'default' }, sure: true, foe: 'goblin', item: null, world: null, title: 'Wizard Tower Defense' };
      expect(read(sentence, reading)).toEqual([]);
    });

    it('one verb the model reads with its own genre stays a single game', () => {
      const sentence = 'a chef catches eggs dropping into the kitchen while avoiding bombs';
      const reading: Reading = { control: 'timing', verbs: [{ word: 'catches', class: 'timing' }], hero: 'chef', roles: [{ noun: 'eggs', kind: 'target', count: null }, { noun: 'bombs', kind: 'hazard', count: null }], setting: 'kitchen', mood: 'busy', numbers: none, genre: { genre: 'catch', mode: 'default' }, sure: true, foe: null, item: 'eggs', world: null, title: 'Chef Egg Catch' };
      expect(read(sentence, reading)).toEqual([]);
    });
  });

  it('a generic cell heard by a clear margin stays a single game', () => {
    const ranking = classifyGenre('steer a hot air balloon through the gaps between storm clouds', null);
    expect(`${ranking.ranked[0]!.genre}.${ranking.ranked[0]!.mode}`).toBe('voyage.race');
    expect(decide('steer a hot air balloon through the gaps between storm clouds')).toBe('single');
  });
});
