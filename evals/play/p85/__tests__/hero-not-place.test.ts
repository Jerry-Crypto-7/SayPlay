/**
 * P85A T2: hrdina není místo. Před opravou psala karta startu „Place: spaceship“ (s03) a „Place: farmer“ (s04):
 * slovo hrdiny vybralo sadu vzhledu a `withPlace` ho vzal za místo. Teď je místem ta sada; scéna zůstává stejná.
 * Obměny: jiná věta téhož hrdiny a jiné povolání.
 */

import { beforeAll, describe, expect, it } from 'vitest';

import { lookOf } from '@/play/arcade/look';
import { loadRapier } from '@/play/arcade/physics/world';
import { draftGameSpecWithMeta } from '@/play/draft';

beforeAll(async () => {
  await loadRapier();
});

const HEROES = [
  ['A spaceship dodges asteroids and shoots three alien ships', 'spaceship', 'space'],
  ['A farmer plants five seeds and waters them until they grow', 'farmer', 'meadow'],
  ['A spaceship collects ten stars', 'spaceship', 'space'],
  ['A farmer catches falling apples', 'farmer', 'meadow'],
  ['a gardener prunes hedges into animal shapes', 'gardener', 'meadow'],
] as const;

describe('P85A T2: the hero is not the place', () => {
  it.each(HEROES)('%s: the %s plays in the %s scene', (sentence, hero, look) => {
    const { theme } = draftGameSpecWithMeta(sentence, 1).spec;
    expect(theme.setting).not.toBe(hero);
    expect(theme.setting).toBe(look);
    expect(lookOf(theme)).toBe(look);
  });

  it('a place the sentence names stays', () => {
    expect(draftGameSpecWithMeta('A farmer feeds the pigs in the barn', 1).spec.theme.setting).toBe('barn');
  });
});
