/**
 * Kostry P66 (T2): pět nových žánrů je v kontraktu a ve všech sdílených registrech, ale nehraje – klasifikátor,
 * návrh ani režisér je nevidí a překlad hází, dokud úloha žánru (T5–T9) modul nepřepne. Kostra, která by se omylem
 * dostala do pořadí klasifikátoru, by kradla věty starým žánrům dřív, než cokoli hraje.
 */

import { describe, expect, it } from 'vitest';

import { BUTTON } from '@/play/arcade/contract';
import { ARCADE_LIBRARY, MODE_GENERATORS } from '@/play/arcade/library';
import { modeNotBuilt } from '@/play/arcade/pieces/mode-stub';
import { ALLOWED, liveCells } from '@/play/compose/allowed';
import { STAGED_PRESETS } from '@/play/compose/presets';
import { STAGES } from '@/play/compose/stage-registry';
import { CONTROLS, READ_CONTROLS } from '@/play/spec';
import { SUBSYSTEMS } from '@/sim/rng';

import { classifyGenre } from '../classify';
import { COUNT_PARAMS, FOE_DOES, GENRES, GENRE_COMPILER_VERSION, GENRE_MODES, type GenreId, genreSpecSchema } from '../contract';
import { GENRE_MODULES, compileGenre } from '../index';

const P66 = ['survivor', 'hole', 'steal', 'sort', 'arrows'] as const;
/** Žánry, které jejich úloha už postavila (překlad i generátor hrají z ručního specu); pro výběr zůstávají `staged` do T12. */
const LIVE: readonly string[] = ['arrows', 'sort', 'steal', 'hole', 'survivor'];
const STAGED = P66.filter((genre) => !LIVE.includes(genre));
/** Generátor režimu, který úloha žánru naplní (registrace je hotová v T2). */
const GENERATOR: Readonly<Record<(typeof P66)[number], string>> = {
  survivor: 'survivor_waves',
  hole: 'hole_swallow',
  steal: 'steal_bases',
  sort: 'sort_bins',
  arrows: 'arrows_grid',
};
/** Joystick pro pohyb po ploše, klepnutí do sloupce (fronta) nebo buňky (osa nese buňku, `cellAxisAt`). */
const INPUT: Readonly<Record<(typeof P66)[number], string>> = { survivor: 'arena', hole: 'arena', steal: 'arena', sort: 'lanes', arrows: 'lanes' };

/** Věty, které nový žánr jmenují přímo – kostra je přesto nesmí dostat. */
const NAMING = [
  'a soldier survives waves of zombies, shooting on his own and picking an upgrade after each wave',
  'a black hole swallows the cars of a busy city and grows',
  'steal the gold from the rival base and carry it home before the guards catch you',
  'sort the colored balls into the matching jars',
  'tap the cars so they drive out of the jammed parking lot in the right order',
  'a cozy game',
];

describe('P66 staged genres (T2)', () => {
  it('the contract has 24 genres: the 19 before P66 and five staged ones with one default mode', () => {
    expect(GENRES).toHaveLength(24);
    for (const genre of P66) {
      expect(GENRES).toContain(genre);
      expect(GENRE_MODES[genre as GenreId]).toEqual(['default']);
      const module = GENRE_MODULES[genre as GenreId];
      expect(module.id).toBe(genre);
      expect(module.availability('default' as never)).toBe('staged');
      expect(module.cues).toEqual([]);
      expect(FOE_DOES[genre as GenreId]).toBeDefined();
      expect(COUNT_PARAMS[genre as GenreId]).toBeDefined();
      // Každý počet, který věta řekne, má parametr s mezemi v modulu (úloha žánru je smí změnit, ne vynechat).
      const counted = (COUNT_PARAMS[genre as GenreId] as Readonly<Record<string, Readonly<Record<string, string>> | undefined>>).default ?? {};
      for (const key of Object.values(counted)) expect(module.paramBounds[key], `${genre} ${key}`).toBeDefined();
      expect(genreSpecSchema.safeParse({ genre, mode: 'default', hero: 'fox', setting: 'forest' }).success).toBe(true);
    }
  });

  it('compiling a skeleton throws until its task makes it live', () => {
    for (const genre of STAGED) {
      const spec = { genre, mode: 'default', hero: 'fox', setting: 'forest' } as never;
      expect(() => GENRE_MODULES[genre as GenreId].compile(spec), genre).toThrow(/not live/);
      // Cesta hry žánru jde přes buňku receptu; kostra živou buňku nemá (`presetOf`), takže hází i tady.
      expect(() => compileGenre(spec), genre).toThrow();
    }
  });

  it('the classifier never ranks a skeleton, even when the sentence names it', () => {
    const playing = GENRES.flatMap((genre) => GENRE_MODES[genre].filter((mode) => GENRE_MODULES[genre].availability(mode as never) !== 'staged').map((mode) => `${genre}.${mode}`));
    for (const sentence of NAMING) {
      const ranked = classifyGenre(sentence, null).ranked;
      expect(ranked.filter((choice) => (P66 as readonly string[]).includes(choice.genre)), sentence).toEqual([]);
      expect(ranked.map((choice) => `${choice.genre}.${choice.mode}`).sort(), sentence).toEqual([...playing].sort());
    }
  });

  it('every skeleton has a staged cell with its own recipe and no live one', () => {
    for (const genre of P66) {
      const cell = ALLOWED.find((entry) => entry.id === `${genre}.default`);
      expect(cell?.status, genre).toBe('staged');
      expect(STAGED_PRESETS[`${genre}.default`], genre).toBeDefined();
      expect(liveCells().some((entry) => entry.preset.genre === genre), genre).toBe(false);
    }
  });

  it('every skeleton has its control, scene, input, bot and generator registered, and the generator builds no world', () => {
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
      const parts = generator.parts(1, LIVE.includes(genre) ? generator.params.parse({}) : {}, undefined);
      expect(parts.issues ?? [], genre).toEqual(LIVE.includes(genre) ? [] : [modeNotBuilt(id)]);
      expect(parts.control.id, genre).toBe(genre);
      // Žánr s výběrem vylepšení má robota žánru pod obalem háčků (`withHooks` → `hooks_bot`).
      const bot = parts.bot.id === 'hooks_bot' ? (parts.bot.params as { base: { id: string } }).base.id : parts.bot.id;
      expect(bot, genre).toBe(`${genre}_bot`);
    }
  });
});

describe('genre.v6 and the hooks contract (P66 T2)', () => {
  it('new games are genre.v6', () => {
    expect(GENRE_COMPILER_VERSION).toBe('genre.v6');
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
