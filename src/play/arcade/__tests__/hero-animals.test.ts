/**
 * Zvíře z věty je hrdinou jako to zvíře (P35 T1). Přejímka O10 ukázala, že
 * králík kreslený křečkem projde okem jako hra, jen ne ta z věty – astra ho
 * naslepo nepoznala. Test drží model pro každé zvíře v každém žánru, kde ho
 * žánr za hrdinu pustí, a že se model hýbe klipy, ne jen procedurálně.
 */

import { describe, expect, it } from 'vitest';

import type { GenreId } from '../../genre/contract';
import { GENRE_MODULES } from '../../genre/index';
import { heroChoice, modelOf, riggedCharacter } from '../models';

/** Ovládání, na které žánr hru překládá (`src/play/genre/*.ts`). */
const CONTROL: Readonly<Record<GenreId, string>> = {
  runner: 'runner',
  platformer: 'platform',
  arena: 'move_free',
  voyage: 'steer',
  quest: 'move_free',
};

/** Slovo věty → model, který to zvíře zobrazuje; `clips` = hýbe se klipy z GLB. */
const ANIMALS: ReadonlyArray<readonly [word: string, model: string, clips: boolean]> = [
  ['rabbit', 'rigged:pet-bunny', true],
  ['bunny', 'rigged:pet-bunny', true],
  ['rabbits', 'rigged:pet-bunny', true],
  ['cat', 'rigged:pet-cat', true],
  ['kitten', 'rigged:pet-cat', true],
  ['dog', 'rigged:pet-dog', true],
  ['puppy', 'rigged:pet-dog', true],
  ['turtle', 'gen3d-tortoise', false],
  ['tortoise', 'gen3d-tortoise', false],
];

const GENRES = (Object.keys(GENRE_MODULES) as GenreId[]).filter((genre) => GENRE_MODULES[genre].heroClasses.includes('animal'));

describe('the animal the sentence names is the hero (P35 T1)', () => {
  it.each(GENRES.flatMap((genre) => ANIMALS.map(([word, model, clips]) => [word, genre, model, clips] as const)))('%s in %s is drawn as %s', (word, genre, model, clips) => {
    const choice = heroChoice(`a little ${word}`, genre, CONTROL[genre]);
    expect(choice).toMatchObject({ model, level: 'identity' });
    expect(riggedCharacter(choice.model) !== undefined, `${word} moves by clips`).toBe(clips);
  });

  it('no animal falls back to a hamster or a fox when it has its own model', () => {
    for (const [word, model] of ANIMALS) {
      expect(heroChoice(word, undefined, 'move_free').model, word).toBe(model);
      expect(modelOf(word, true), word).not.toMatch(/^(hamster|fox)$/);
    }
  });

  it('the bunny runs with its own clips', () => {
    const bunny = riggedCharacter('rigged:pet-bunny');
    expect(bunny?.clips.run).toBe('run');
    expect(bunny?.clips.idle).toBe('idle');
  });

  it.each(['bear', 'lion', 'tiger', 'pig', 'cow', 'horse', 'sheep', 'goat', 'monkey', 'panda', 'koala', 'deer', 'hedgehog', 'snake', 'sloth', 'llama', 'giraffe', 'elephant', 'zebra', 'otter', 'beaver', 'owl', 'bat'])(
    'the %s with a model of its own never falls to the fox',
    (word) => {
      const choice = heroChoice(`a ${word}`, 'arena', 'move_free');
      expect(choice.level, word).toBe('identity');
      expect(choice.model, word).not.toBe('fox');
      expect(modelOf(word, true), word).not.toBe('fox');
    },
  );
});
