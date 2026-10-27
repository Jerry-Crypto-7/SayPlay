/**
 * Diagnóza P63 (T1) pošle opravu T2 do souboru kroku, kde se věta rozešla. Krok přiřazený špatně = oprava ve špatném
 * souboru. Aplikace je tu nahrazená ručně zadanými výsledky kroků, takže test drží logiku diagnózy, ne dnešní žánry.
 */

import { describe, expect, it } from 'vitest';

import { diagnoseSentence, divergeStep, EXPECT, locate } from '../diagnose.mjs';

const KNIGHT = { id: 'h18', text: 'A knight must slay the dragon guarding the castle gate.' };

interface Game { readonly genre: string; readonly hero: string; readonly roles: readonly string[] }

/** Návrh hry, jak ho vrací `draftGameSpecWithMeta`: žánr, hrdina (`player`) a role. */
const meta = ({ genre, hero, roles }: Game) => {
  const [id, mode] = genre.split('.');
  return {
    spec: {
      genre: { id, mode },
      roles: [{ kind: 'player', label: hero }, ...roles.map((role) => ({ kind: role.split(':')[0], label: role.split(':')[1] }))],
      theme: { setting: 'castle' },
      tutorial: { goalLine: 'Defeat the dragon' },
      objective: null,
    },
    genre: { id, mode },
    composition: { cellId: genre },
  };
};

/** Ručně zadané čtení věty o rytíři; `genre` a `sure` řídí, co čtečka řekla. */
const reading = (genre: string, sure: boolean) => {
  const [id, mode] = genre.split('.');
  return {
    genre: { id, mode },
    sure,
    control: 'move',
    verbs: [{ word: 'slay', class: 'defeat' }],
    hero: 'knight',
    foe: 'dragon',
    item: null,
    world: 'castle',
    roles: [{ kind: 'chaser', noun: 'dragon', count: null }],
  };
};

/** Server v malém: klasifikátor, rychlá hra a hra po čtení zadané ručně, jedna hra (bez řetězu). */
const deps = ({ classified, quick, read, differs }: { classified: string; quick: Game; read: Game; differs: boolean }) => ({
  classifyGenre: (_sentence: string, given: unknown) => {
    const [genre, mode] = (given === null ? quick.genre : classified).split('.');
    return { ranked: [{ genre, mode, why: 'test' }], decided: 'reading' };
  },
  draftGameSpecWithMeta: (_sentence: string, _seed: number, { reading: given }: { reading: unknown }) => meta(given === null ? quick : read),
  readForChain: () => null,
  chainOrSingle: () => 'single',
  readingDiffers: () => differs,
});

const RACE: Game = { genre: 'voyage.race', hero: 'car', roles: ['obstacle:rock'] };
const FIGHT: Game = { genre: 'arena.fight', hero: 'knight', roles: ['chaser:red dragon'] };

describe('diagnose: krok, kde se hra po čtení rozešla s větou', () => {
  it('čtení se žánrem věty a hra s rytířem i drakem → none, bez místa v kódu', () => {
    const row = diagnoseSentence(KNIGHT, reading('arena.fight', true), EXPECT.h18, deps({ classified: 'arena.fight', quick: RACE, read: FIGHT, differs: true }));
    expect(row.step).toBe('none');
    expect(row.location).toBeNull();
    expect(row.reading.genre).toBe('arena.fight');
    expect(row.readingGame?.cast).toEqual({ hero: 'knight', roles: ['chaser:red dragon'] });
  });

  it('čtečka řekla jiný žánr (závod místo souboje) → reader, i když další kroky sedí', () => {
    const row = diagnoseSentence(KNIGHT, reading('voyage.race', true), EXPECT.h18, deps({ classified: 'arena.fight', quick: RACE, read: FIGHT, differs: true }));
    expect(row.step).toBe('reader');
    expect(row.location).toMatch(/^src\/play\/read\/prompt\.ts:\d+$/);
  });

  it('nejisté správné čtení, klasifikátor zvolí jiný žánr → classifier', () => {
    const row = diagnoseSentence(KNIGHT, reading('arena.fight', false), EXPECT.h18, deps({ classified: 'voyage.race', quick: RACE, read: RACE, differs: true }));
    expect(row.step).toBe('classifier');
    expect(row.classified.first).toBe('voyage.race');
    expect(row.location).toMatch(/^src\/play\/genre\/classify\.ts:\d+$/);
  });

  it('zbylé kroky: skladba, překlad rolí, publikace', () => {
    const base = { expect: EXPECT.h18, readGenre: 'arena.fight', classified: 'arena.fight', quickGame: { genre: 'voyage.race', cast: { hero: 'car', roles: [] } } };
    const fight = { genre: 'arena.fight', cast: { hero: 'knight', roles: ['chaser:red dragon'] } };
    expect(divergeStep({ ...base, readingGame: { ...fight, genre: 'voyage.race' }, published: true })).toBe('compose');
    expect(divergeStep({ ...base, readingGame: { ...fight, cast: { hero: 'knight', roles: ['chaser:ghost'] } }, published: true })).toBe('translation');
    expect(divergeStep({ ...base, readingGame: fight, published: false })).toBe('publish');
    // Nevznikla, ale rychlá hra už větu hraje: žádný rozchod.
    expect(divergeStep({ ...base, quickGame: fight, readingGame: fight, published: false })).toBe('none');
  });

  it('každý krok kromě none ukazuje na existující řádek kódu', () => {
    for (const step of ['reader', 'classifier', 'compose', 'translation', 'publish']) expect(locate(step)).toMatch(/^src\/.+:\d+$/);
    expect(locate('none')).toBeNull();
  });
});
