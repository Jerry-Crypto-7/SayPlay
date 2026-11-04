/**
 * Pět žánrů P66: T2 je zapsal do kontraktu a všech sdílených registrů jako kostry (`staged`), T5–T9 postavily jejich
 * hru a T12 je jednou změnou výběru pustil živě – `ready`, narážky, buňka receptu v `PRESETS`. Test drží konečný stav:
 * každý z pěti hraje celou cestou věty (klasifikátor → buňka → překlad → svět generátoru) a žádný nezůstal napůl,
 * třeba `ready` bez buňky receptu (shodí skladbu každé věty) nebo buňku živou bez `ready` (klasifikátor ji nevidí).
 */

import { beforeAll, describe, expect, it } from 'vitest';

import { BUTTON } from '@/play/arcade/contract';
import { ARCADE_LIBRARY, MODE_GENERATORS } from '@/play/arcade/library';
import { loadRapier } from '@/play/arcade/physics/world';
import { ALLOWED, liveCells } from '@/play/compose/allowed';
import { PRESETS, STAGED_PRESETS } from '@/play/compose/presets';
import { STAGES } from '@/play/compose/stage-registry';
import { CONTROLS, READ_CONTROLS, readGameSpec } from '@/play/spec';
import { SUBSYSTEMS } from '@/sim/rng';

import { classifyGenre } from '../classify';
import { COUNT_PARAMS, FOE_DOES, GENRES, GENRE_COMPILER_VERSION, GENRE_MODES, type GenreId, genreSpecSchema } from '../contract';
import { GENRE_MODULES, compileGenre } from '../index';
import { P68_GENRES } from '../p68-contract';

const P66 = ['survivor', 'hole', 'steal', 'sort', 'arrows'] as const;
type P66Genre = (typeof P66)[number];
/** Generátor režimu, který úloha žánru naplnila (registrace je z T2). */
const GENERATOR: Readonly<Record<P66Genre, string>> = {
  survivor: 'survivor_waves',
  hole: 'hole_swallow',
  steal: 'steal_bases',
  sort: 'sort_bins',
  arrows: 'arrows_grid',
};
/** Joystick pro pohyb po ploše, klepnutí do sloupce (fronta) nebo buňky (osa nese buňku, `cellAxisAt`). */
const INPUT: Readonly<Record<P66Genre, string>> = { survivor: 'arena', hole: 'arena', steal: 'arena', sort: 'lanes', arrows: 'lanes' };

/** Věty, které nový žánr jmenují přímo (napsané v T2, kdy je kostra ještě dostat nesměla) – teď je dostanou. */
const NAMING: readonly (readonly [P66Genre, string])[] = [
  ['survivor', 'a soldier survives waves of zombies, shooting on his own and picking an upgrade after each wave'],
  ['hole', 'a black hole swallows the cars of a busy city and grows'],
  ['steal', 'steal the gold from the rival base and carry it home before the guards catch you'],
  ['sort', 'sort the colored balls into the matching jars'],
  ['arrows', 'tap the cars so they drive out of the jammed parking lot in the right order'],
];

beforeAll(async () => {
  await loadRapier();
});

describe('P66 genres go live (T2 staged them, T12 routes sentences to them)', () => {
  it('the contract has 24 genres before P68: the 19 before P66 and five live ones with one default mode and their own cues', () => {
    // P68 T1 přidal pět dalších koster (`p68-staged.test.ts`) – 24 platí pro žánry do P66.
    expect(GENRES.filter((genre) => !(P68_GENRES as readonly string[]).includes(genre))).toHaveLength(24);
    for (const genre of P66) {
      expect(GENRES).toContain(genre);
      expect(GENRE_MODES[genre as GenreId]).toEqual(['default']);
      const module = GENRE_MODULES[genre as GenreId];
      expect(module.id).toBe(genre);
      expect(module.availability('default' as never), genre).toBe('ready');
      expect(module.cues.length, genre).toBeGreaterThan(0);
      expect(FOE_DOES[genre as GenreId]).toBeDefined();
      expect(COUNT_PARAMS[genre as GenreId]).toBeDefined();
      // Každý počet, který věta řekne, má parametr s mezemi v modulu (úloha žánru je smí změnit, ne vynechat).
      const counted = (COUNT_PARAMS[genre as GenreId] as Readonly<Record<string, Readonly<Record<string, string>> | undefined>>).default ?? {};
      for (const key of Object.values(counted)) expect(module.paramBounds[key], `${genre} ${key}`).toBeDefined();
      expect(genreSpecSchema.safeParse({ genre, mode: 'default', hero: 'fox', setting: 'forest' }).success).toBe(true);
    }
  });

  it('every P66 genre has a live cell with its own recipe and none is left staged', () => {
    // Kostry P68 (T1) mají buňku ve `STAGED_PRESETS`; žádný žánr P66 ne.
    expect(Object.keys(STAGED_PRESETS).filter((id) => (P66 as readonly string[]).includes(id.split('.')[0]!))).toEqual([]);
    for (const genre of P66) {
      const cell = ALLOWED.find((entry) => entry.id === `${genre}.default`);
      expect(cell?.status, genre).toBe('live');
      expect(PRESETS[`${genre}.default`], genre).toBeDefined();
      expect(cell?.recipe, genre).toEqual(PRESETS[`${genre}.default`]);
      expect(liveCells().some((entry) => entry.preset.genre === genre), genre).toBe(true);
    }
  });

  it('the recipe path of the game compiles each genre to a spec that reads (no "not live" skeleton left)', () => {
    for (const genre of P66) {
      const game = compileGenre({ genre, mode: 'default', hero: 'fox', setting: 'forest' } as never);
      expect(game.control, genre).toBe(genre);
      expect(readGameSpec(game).ok, genre).toBe(true);
    }
  });

  it('the classifier ranks every live mode once, puts each naming sentence in its genre and leaves a sentence without a cue in the arena collect', () => {
    const playing = GENRES.flatMap((genre) => GENRE_MODES[genre].filter((mode) => GENRE_MODULES[genre].availability(mode as never) !== 'staged').map((mode) => `${genre}.${mode}`));
    for (const genre of P66) expect(playing, genre).toContain(`${genre}.default`);
    for (const [genre, sentence] of NAMING) {
      const ranked = classifyGenre(sentence, null).ranked;
      expect(ranked.map((choice) => `${choice.genre}.${choice.mode}`).sort(), sentence).toEqual([...playing].sort());
      expect(ranked[0]?.genre, sentence).toBe(genre);
    }
    expect(classifyGenre('a cozy game', null).ranked[0]).toMatchObject({ genre: 'arena', mode: 'collect', score: 0 });
  });

  it('every P66 genre has its control, scene, input, bot and generator registered, and the generator builds a world', () => {
    for (const genre of P66) {
      expect(CONTROLS, genre).toContain(genre);
      expect(READ_CONTROLS, genre).not.toContain(genre);
      expect(STAGES[genre as keyof typeof STAGES], genre).toEqual({ scene: genre, input: INPUT[genre] });
      expect(ARCADE_LIBRARY.controls[genre]?.id, genre).toBe(genre);
      expect(ARCADE_LIBRARY.bots[`${genre}_bot`]?.id, genre).toBe(`${genre}_bot`);
      const id = GENERATOR[genre];
      expect(MODE_GENERATORS[id]?.id, genre).toBe(id);
      expect(ARCADE_LIBRARY.generators[id], genre).toBe(MODE_GENERATORS[id]);
      const generator = MODE_GENERATORS[id]!;
      const parts = generator.parts(1, generator.params.parse({}), undefined);
      expect(parts.issues ?? [], genre).toEqual([]);
      expect(parts.control.id, genre).toBe(genre);
      // Žánr s výběrem vylepšení má robota žánru pod obalem háčků (`withHooks` → `hooks_bot`).
      const bot = parts.bot.id === 'hooks_bot' ? (parts.bot.params as { base: { id: string } }).base.id : parts.bot.id;
      expect(bot, genre).toBe(`${genre}_bot`);
    }
  });
});

describe('genre.v6 and the hooks contract (P66 T2)', () => {
  it('new games are genre.v8 (P68 T1 and P70A T3 moved on from genre.v6, which brought the hooks)', () => {
    expect(GENRE_COMPILER_VERSION).toBe('genre.v8');
  });

  it('the hook streams come after every stream that existed, so saved games draw what they drew before', () => {
    expect(SUBSYSTEMS.slice(0, 7)).toEqual(['spawn', 'ai', 'effect', 'layout', 'pacing', 'merge', 'chain']);
    expect(SUBSYSTEMS.slice(7)).toEqual(['upgrades', 'rarity', 'rounds']);
  });

  it('the upgrade card buttons are new bits, clear of every button a saved game could hold', () => {
    const old = BUTTON.TAP | BUTTON.LEFT | BUTTON.RIGHT | BUTTON.UP | BUTTON.DOWN | BUTTON.HOLD | BUTTON.FIRE | BUTTON.ATTACK | BUTTON.INTERACT | BUTTON.ACTION_A | BUTTON.ACTION_B;
    const cards = [BUTTON.PICK_1, BUTTON.PICK_2, BUTTON.PICK_3];
    expect(new Set(cards).size).toBe(3);
    for (const bit of cards) expect(bit & old).toBe(0);
  });
});
