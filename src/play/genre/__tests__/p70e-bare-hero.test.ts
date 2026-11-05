/**
 * Věta jen ze jména je hrdina (P70E): majitel napsal „rabbit“ a hrál lišku. Holé jméno ani „a dragon“ nemělo
 * sloveso, takže hrdinu nikdo nepřečetl, nastoupil náhradník a příšera skončila jako vlastní pronásledovatel.
 */

import { beforeAll, describe, expect, it } from 'vitest';

import { loadRapier } from '@/play/arcade/physics/world';
import { draftGameSpecWithMeta } from '@/play/draft';

const CHARACTERS = ['rabbit', 'bunny', 'cat', 'dog', 'fox', 'horse', 'frog', 'duck', 'bear', 'wolf', 'pig', 'cow', 'mouse', 'monkey', 'lion', 'tiger', 'penguin', 'turtle', 'shark', 'owl',
  'dragon', 'unicorn', 'dinosaur', 'robot', 'ninja', 'pirate', 'knight', 'princess', 'zombie', 'wizard', 'astronaut', 'alien', 'ghost', 'cowboy', 'superhero', 'mermaid', 'car', 'rocket', 'boat', 'plane'];

const roles = (sentence: string) => draftGameSpecWithMeta(sentence, 1).spec.roles ?? [];
const player = (sentence: string) => roles(sentence).find((role) => role.kind === 'player')?.label;

beforeAll(() => loadRapier());

describe('a sentence that is only a name plays that name', () => {
  it('every common hero, bare and with an article, is the player', () => {
    const wrong = CHARACTERS.flatMap((word) => [word, `a ${word}`]).filter((sentence) => !(player(sentence) ?? '').includes(sentence.replace(/^a /, '')));
    expect(wrong).toEqual([]);
  }, 300_000);

  it('a monster named alone is not also its own chaser', () => {
    for (const sentence of ['a dragon', 'zombies', 'ghost', 'shark']) {
      const hero = player(sentence)!;
      expect(roles(sentence).filter((role) => role.kind !== 'player' && role.kind !== 'rival').map((role) => role.label)).not.toContain(hero);
    }
  }, 120_000);

  it('a place, a sport or a game name does not become the hero', () => {
    expect(player('golf')).toBe('golf ball');
    expect(player('castle')).not.toBe('castle');
    expect(player('tetris')).not.toMatch(/^tetri/);
    expect(player('zombie apocalypse')).not.toBe('apocalypse');
  }, 120_000);
});
