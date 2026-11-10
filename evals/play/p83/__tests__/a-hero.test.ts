/**
 * P83A T4: místo hrdinou není. Slepý soud 10. 11.: rychlá verze s čtením modelem dala u věty o obchodě „You: Small shop“
 * a krabici s nápisem na louce. Dvanáct vět „místo + činnost“ (psaných před opravou, `PLACE_SENTENCES`): hrdina není
 * budova a budova, kterou věta začíná, je místo hry. Čtení, které budovu napíše za hrdinu, dá postavu budovy.
 * Před opravou: čtení „small shop“ → hrdina „small shop“, místo „counter“; „A library where …“ hrála louka.
 */

import { beforeAll, describe, expect, it } from 'vitest';

import { loadRapier } from '@/play/arcade/physics/world';
import { draftGameSpecWithMeta } from '@/play/draft';
import { buildingIn } from '@/play/draft/lexicon';
import { type Reading, readingSchema } from '@/play/read/schema';

import { PLACE_SENTENCES } from '../a-hero';

beforeAll(async () => {
  await loadRapier();
});

const BUILDING_AT_START = /^an?\s+(?:\w+\s+)?(\w+)\s+where\b/i;
/** Věta o pultu se součtem hraje od P83E obchod se součtem: místem je obchod, jak ho věta řekla, ne sada supermarketu. */
const INSIDE: Readonly<Record<string, string>> = { [PLACE_SENTENCES[0]]: 'small shop' };
/** Budova, kterou slovník míst vede pod svou sadou (shop → supermarket). */
const KNOWN_AS: Readonly<Record<string, string>> = { shop: 'supermarket' };

/** Čtení rychlé verze, které podmět věty vzalo z místa (jako u soudu). */
function placeAsHero(place: string, extra: object): Reading {
  return readingSchema.parse({
    control: 'move_free',
    verbs: [{ word: 'collect', class: 'move_free' }],
    hero: place,
    roles: [],
    setting: place,
    mood: null,
    numbers: { seconds: null, counts: [] },
    genre: { genre: 'arena', mode: 'collect' },
    sure: true,
    foe: null,
    item: null,
    world: null,
    title: null,
    ...extra,
  });
}

describe('P83A T4: a place is never the hero', () => {
  it.each(PLACE_SENTENCES)('%s – hero is not a building, the building is the place', (sentence) => {
    const { genre, spec } = draftGameSpecWithMeta(sentence, 1);
    const building = BUILDING_AT_START.exec(sentence)![1]!.toLowerCase();
    expect(buildingIn(genre!.hero)).toBeNull();
    expect(spec.roles.find((role) => role.kind === 'player')?.label).toBe(genre!.hero);
    expect(spec.theme.setting.toLowerCase()).toContain(INSIDE[sentence] ?? KNOWN_AS[building] ?? building);
  });

  it.each([
    [PLACE_SENTENCES[0], 'small shop', 'customer', { roles: [{ noun: 'items', kind: 'collectible', count: 3 }], item: 'items', numbers: { seconds: null, counts: [3] } }],
    [PLACE_SENTENCES[1], 'library', 'student', { roles: [{ noun: 'books', kind: 'collectible', count: null }], item: 'books' }],
    [PLACE_SENTENCES[2], 'castle', 'knight', { roles: [{ noun: 'goblins', kind: 'threat', count: null }], foe: 'goblins', genre: { genre: 'arena', mode: 'fight' } }],
  ] as const)('%s – a reading with the hero "%s" plays as a %s', (sentence, place, person, extra) => {
    const { genre, spec } = draftGameSpecWithMeta(sentence, 1, { reading: placeAsHero(place, extra) });
    expect(genre!.hero).toBe(person);
    expect(spec.roles.find((role) => role.kind === 'player')?.label).toBe(person);
    expect(spec.theme.setting).toContain(place.split(' ').at(-1));
  });

  it('a hero who is not a building keeps playing (knight, librarian, guard)', () => {
    expect(PLACE_SENTENCES.slice(5, 7).map((sentence) => draftGameSpecWithMeta(sentence, 1).genre!.hero)).toEqual(['librarian', 'knight']);
    expect(draftGameSpecWithMeta(PLACE_SENTENCES[9], 1).genre!.hero).toBe('guard');
  });
});
