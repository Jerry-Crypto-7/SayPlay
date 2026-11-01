/**
 * Otisk uložených her (P68 T1). P68 přidává pět žánrů za `genre.v7`; uložená hra `genre.v6` (a starší ruční spec
 * bez žánru) musí hrát bit po bitu jako na `main` `688d989d`. Pro každou uloženou hru: hash počátečního stavu,
 * robot (tik, výsledek, hash konce běhu) a nečinný hráč (tik, výsledek, hash konce běhu) se semínkem buňky.
 *
 * Hry jsou zmrazené v `evals/play/p68/hash-baseline.json` i se specem: jedna hra `genre.v6` každého z 24 žánrů
 * (pět žánrů P66 z ručních speců `e2e/fixtures/p66-<id>-spec.json`, ostatní složené z věty bez modelu – buňky
 * `p58a/framing-cells.json` jsou `genre.v5` a pinuje je `p66-hash.test.ts`) a platné specy z `src/play/__fixtures__`
 * a `src/play/arcade/__fixtures__`.
 *
 * `P68_HASH_WRITE=1` otisk znovu vyrobí – jen na `main` před P68 (překladač `genre.v6`), jinak test hází.
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { GENRE_COMPILER_VERSION, GENRE_MODES, type GenreId } from '@/play/genre/contract';
import { compileGenre, GENRE_MODULES, readGenreSpec } from '@/play/genre/index';
import { readGameSpec } from '@/play/spec';

import { arcadeWorldOf } from '../compile';
import { hashArcade, instantiate, replay } from '../kernel';
import { ARCADE_LIBRARY } from '../library';
import { loadRapier } from '../physics/world';
import { runBot } from '../verify';

const BASELINE = 'evals/play/p68/hash-baseline.json';

/** 24 žánrů na `main` před P68. */
const PRE_P68: readonly GenreId[] = ['runner', 'platformer', 'arena', 'voyage', 'quest', 'shooter', 'throw', 'timing', 'rhythm', 'duel', 'flap', 'catch', 'whack', 'defense', 'slice', 'hop', 'crowd', 'merge', 'push', 'survivor', 'hole', 'steal', 'sort', 'arrows'];
const P66_FIXTURE = (genre: string): string => `e2e/fixtures/p66-${genre}-spec.json`;

interface Run {
  readonly tick: number;
  readonly outcome: string;
  readonly hash: string;
}
interface Cell {
  /** Žánr (`genre:<id>`) nebo soubor (`fixture:<cesta>`). */
  readonly id: string;
  readonly seed: number;
  readonly spec: unknown;
  readonly initial: string;
  readonly bot: Run;
  readonly idle: Run;
}
interface Baseline {
  readonly measuredOn: string;
  readonly compilerVersion: string;
  readonly cells: readonly Cell[];
}

/** Věty žánrů bez ručního specu; plavba, krájení, dav a slučování jako `e2e/p61-portrait.spec.ts`. */
const SENTENCES: Readonly<Partial<Record<GenreId, string>>> = {
  runner: 'a fox runs down a forest path jumping over logs and grabbing berries',
  platformer: 'a frog jumps across floating platforms to collect gold coins',
  arena: 'a knight escapes the angry ghosts in a dark castle hall',
  voyage: 'a pirate ship races between islands to the treasure',
  quest: 'a little robot visits three stations in the factory to fix the machines',
  shooter: 'a farmer shoots the crows attacking his corn field',
  throw: 'a monkey throws coconuts at the cans on the beach',
  timing: 'stack the pancakes as high as you can in the diner',
  rhythm: 'a drummer hits the beats on time at a rock concert',
  duel: 'a samurai duels a ninja on the bridge',
  flap: 'a little bird flaps through the gaps between the pipes',
  catch: 'a bear catches falling apples in a basket and dodges the bombs',
  whack: 'whack the moles popping out of the garden',
  defense: 'defend the castle wall from the marching goblins',
  slice: 'a sushi chef slashes the fish flung into the air with his knife but leaves the spiky sea mines alone',
  hop: 'a chicken hops across the busy road dodging the cars',
  crowd: 'one tiny lemming dashes down a cave tunnel, go through the right doors to turn him into 10, 50, 200 lemmings, avoid the saws, then swarm the huge troll at the end',
  merge: 'a cat knocks yarn balls into a basket, two matching ones squish together into a bigger ball, keep the heap from reaching the top',
  push: 'a sumo wrestler pushes his rivals out of the ring',
};

function measure(id: string, spec: unknown, seed: number): Cell {
  const read = readGameSpec(spec);
  if (!read.ok) throw new Error(`${id}: ${read.issues.join('; ')}`);
  const made = arcadeWorldOf(read.value, seed);
  if (!made.ok) throw new Error(`${id}: ${made.issues.join('; ')}`);
  const bot = runBot(made.world);
  const idle = replay(made.world, [], ARCADE_LIBRARY);
  return {
    id,
    seed,
    spec,
    initial: hashArcade(instantiate(made.world)),
    bot: { tick: bot.tick, outcome: bot.outcome, hash: bot.hash },
    idle: { tick: idle.tick, outcome: idle.outcome, hash: idle.hash },
  };
}

/** Uložené hry na `main`: jen pro `P68_HASH_WRITE=1`. */
function savedGames(): readonly (readonly [string, unknown])[] {
  const genres = PRE_P68.map((genre) => {
    if (existsSync(P66_FIXTURE(genre))) return [`genre:${genre}`, JSON.parse(readFileSync(P66_FIXTURE(genre), 'utf8')) as unknown] as const;
    // Prostředí, které slovník ve větě nenajde („corn field“), dosadí les a režim, který věta nezvolí, první režim
    // žánru (volí ho jinak klasifikátor) – věta nese jen hrdinu a obsazení.
    const read = readGenreSpec({ hero: 'fox', setting: 'forest', mode: GENRE_MODES[genre][0], ...(GENRE_MODULES[genre].draftFill(SENTENCES[genre]!, null) as object) });
    if (!read.ok) throw new Error(`${genre}: ${read.issues.join('; ')}`);
    return [`genre:${genre}`, compileGenre(read.value)] as const;
  });
  const fixtures = ['src/play/__fixtures__', 'src/play/__fixtures__/p25d', 'src/play/arcade/__fixtures__'].flatMap((dir) =>
    readdirSync(dir)
      .filter((name) => name.endsWith('.json') && !name.startsWith('invalid-'))
      .map((name) => [`fixture:${dir}/${name}`, JSON.parse(readFileSync(join(dir, name), 'utf8')) as unknown] as const),
  );
  return [...genres, ...fixtures];
}

// Fyzikální tělesa (míč, tlačení) chtějí Rapier před prvním tikem – už při sběru testů v režimu zápisu.
await loadRapier();

if (process.env.P68_HASH_WRITE === '1') {
  if (GENRE_COMPILER_VERSION !== 'genre.v6') throw new Error(`P68_HASH_WRITE only on main before P68 (compiler ${GENRE_COMPILER_VERSION})`);
  const cells = savedGames().map(([id, spec]) => measure(id, spec, 1));
  writeFileSync(BASELINE, `${JSON.stringify({ measuredOn: 'main 688d989d', compilerVersion: GENRE_COMPILER_VERSION, cells } satisfies Baseline, null, 1)}\n`);
}

const baseline = (existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, 'utf8')) : { cells: [] }) as Baseline;

describe('saved games play bit for bit as on main before P68 (P68 T1)', () => {
  it('pins one saved genre.v6 game of every pre-P68 genre', () => {
    const pinned = baseline.cells.filter((cell) => cell.id.startsWith('genre:'));
    expect(pinned.map((cell) => cell.id.slice('genre:'.length)).sort()).toEqual([...PRE_P68].sort());
    for (const cell of pinned) expect((cell.spec as { readonly genre: { readonly compilerVersion: string } }).genre.compilerVersion, cell.id).toBe('genre.v6');
  });

  it.each(baseline.cells.map((cell) => [cell.id, cell] as const))('%s: robot and idle player end in the pinned state', (_, cell) => {
    const now = measure(cell.id, cell.spec, cell.seed);
    expect({ initial: now.initial, bot: now.bot, idle: now.idle }).toEqual({ initial: cell.initial, bot: cell.bot, idle: cell.idle });
  });
});
