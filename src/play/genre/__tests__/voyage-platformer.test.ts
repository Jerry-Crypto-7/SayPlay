/**
 * Moduly Plavba a Skákačka (P32F T3): věty z přijímací sady (`evals/play/p32/sentences.json`)
 * vyplní modul žánru bez AI, spec projde `readGameSpec`, zkompiluje se na generátory
 * T1 a T2 a robot ho dohraje.
 */

import { describe, expect, it } from 'vitest';

import { compileArcade } from '@/play/arcade/compile';
import { type GameSpecV1, readGameSpec } from '@/play/spec';

import { type GenreId, type GenreSpec, GENRES } from '../contract';
import { GENRE_MODULES, compileGenre, readGenreSpec } from '../index';
import { voyageHeroClass } from '../voyage';

const PIRATE = 'A pirate ship dodges cannonballs while sailing between islands to find buried treasure';
const ROCKET = 'A rocket lands on Mars';
const DOG = 'A dog walks through a city';
const FROG = 'A frog jumps across lily pads to reach the island';

/** Žánry, jejichž narážka stojí ve větě jako celé slovo s koncovkou („sailing“, „walks through“; „island“ není „land“). */
function cuedGenres(sentence: string): GenreId[] {
  const hits = (cue: string) => new RegExp(`\\b${cue.split(' ').map((word) => `${word}\\w*`).join('\\s+')}\\b`, 'i').test(sentence);
  return GENRES.filter((genre) => GENRE_MODULES[genre].cues.some(hits));
}

/** Věta → `GenreSpec` modulem žánru, bez čtení modelem. */
function draft<G extends 'voyage' | 'platformer'>(genre: G, sentence: string): GenreSpec {
  const read = readGenreSpec(GENRE_MODULES[genre].draftFill(sentence, null));
  if (!read.ok) throw new Error(read.issues.join('; '));
  return read.value;
}

/** Spec přes `readGameSpec` a první semínko, na kterém robot vyhraje – jako dveře publikace. */
function play(spec: GenreSpec): { readonly game: GameSpecV1; readonly kinds: readonly string[] } {
  const read = readGameSpec(compileGenre(spec));
  if (!read.ok) throw new Error(`${read.reason}: ${read.issues.join('; ')}`);
  const issues: string[] = [];
  for (let seed = 1; seed <= 8; seed += 1) {
    const compiled = compileArcade(read.value, seed);
    if (compiled.ok) return { game: read.value, kinds: compiled.value.arcade?.kinds ?? [] };
    issues.push(...compiled.issues);
  }
  throw new Error(`no seed wins: ${issues.join('; ')}`);
}

const roleOf = (game: GameSpecV1, kind: string) => game.roles.find((role) => role.kind === kind);
const generatorOf = (game: GameSpecV1) => (game.controlParams as { readonly generator?: string } | undefined)?.generator;

describe('voyage and platformer genre modules (P32F T3)', () => {
  it('the pirate sails a race to buried treasure, dodging cannonballs, and the hero is a boat', () => {
    expect(cuedGenres(PIRATE)).toContain('voyage');
    const spec = draft('voyage', PIRATE);
    expect(spec).toMatchObject({ genre: 'voyage', mode: 'race', hero: 'pirate ship' });
    expect(voyageHeroClass(spec.hero)).toBe('boat');
    const { game, kinds } = play(spec);
    expect(generatorOf(game)).toBe('voyage_race');
    expect(roleOf(game, 'hazard')?.label).toBe('cannonball');
    expect(roleOf(game, 'exit')?.label).toMatch(/\btreasure$/);
    expect(kinds).toEqual(expect.arrayContaining(['island', 'gate', 'shot', 'goal']));
  });

  it('the rocket lands on Mars', () => {
    expect(cuedGenres(ROCKET)).toContain('voyage');
    const spec = draft('voyage', ROCKET);
    expect(spec).toMatchObject({ genre: 'voyage', mode: 'land', hero: 'rocket', palette: 'space' });
    expect(spec.setting).toMatch(/mars/i);
    expect(voyageHeroClass(spec.hero)).toBe('aircraft');
    const { game, kinds } = play(spec);
    expect(generatorOf(game)).toBe('voyage_land');
    expect(kinds).toContain('pad');
    expect(GENRE_MODULES.voyage.availability('land')).toBe('ready');
  });

  it('the dog races through gates between the buildings of a city', () => {
    expect(cuedGenres(DOG)).toContain('voyage');
    const spec = draft('voyage', DOG);
    expect(spec).toMatchObject({ genre: 'voyage', mode: 'race', hero: 'dog' });
    expect(voyageHeroClass(spec.hero)).toBe('animal');
    const { game, kinds } = play(spec);
    expect(generatorOf(game)).toBe('voyage_race');
    expect(kinds).toEqual(expect.arrayContaining(['building', 'gate']));
    expect(kinds).not.toContain('island');
  });

  it('a race through a look with neither sea nor streets weaves between rocks and dodges boulders', () => {
    const spec = draft('voyage', 'A car drives through the desert');
    expect(spec).toMatchObject({ genre: 'voyage', mode: 'race', palette: 'desert' });
    const { game, kinds } = play(spec);
    expect(game.controlParams).toMatchObject({ tuning: { terrain: 'rocks' } });
    expect(roleOf(game, 'hazard')?.label).toBe('boulder');
    expect(kinds).toContain('rock');
    expect(kinds).not.toContain('island');
    expect(kinds).not.toContain('building');
  });

  it('cues cover the ways a sentence says "travel across" and "jump up"', () => {
    expect(GENRE_MODULES.voyage.cues).toEqual(expect.arrayContaining(['sail', 'fly', 'ride', 'drive', 'pilot', 'walk through', 'cruise', 'land']));
    expect(GENRE_MODULES.platformer.cues).toEqual(expect.arrayContaining(['jump', 'climb', 'hop', 'leap', 'platform']));
  });

  it('a ship is always a boat, never a vehicle', () => {
    for (const hero of ['ship', 'pirate ship', 'big red ships', 'sailboat', 'submarine']) expect(voyageHeroClass(hero), hero).toBe('boat');
    for (const [hero, kind] of [['witch on a broomstick', 'humanoid'], ['plane', 'aircraft'], ['race car', 'vehicle']] as const) expect(voyageHeroClass(hero), hero).toBe(kind);
  });

  it('the frog jumping across lily pads is a platformer with the forgiving jump', () => {
    expect(cuedGenres(FROG)).toContain('platformer');
    expect(cuedGenres(FROG)).not.toContain('voyage');
    const spec = draft('platformer', FROG);
    expect(spec).toMatchObject({ genre: 'platformer', mode: 'default', hero: 'frog' });
    const { game } = play(spec);
    expect(game.control).toBe('platform');
    expect(game.controlParams).toMatchObject({ tuning: { feel: 2 } });
  });
});
