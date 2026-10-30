/**
 * Otisk uložených her (P66 T1). P66 přidává žánry a háčky za `genre.v6`; uložená hra `genre.v5` (a starší spec bez
 * žánru) musí hrát bit po bitu jako na `main` `e661855c`. Pro každou uloženou hru: hash počátečního stavu, robot
 * (tik, výsledek, hash konce běhu) a nečinný hráč (tik, výsledek, hash konce běhu) se semínkem buňky.
 *
 * Hry jsou zmrazené v `evals/play/p66/hash-baseline.json` i se specem: 19 žánrů (15 z `p58a/framing-cells.json`,
 * plavba, krájení, dav a slučování složené z věty bez modelu jako `e2e/p61-portrait.spec.ts`), tři ovládací buňky
 * z `framing-cells` a platné specy z `src/play/__fixtures__` a `src/play/arcade/__fixtures__`.
 *
 * `P66_HASH_WRITE=1` otisk znovu vyrobí – jen na `main` před P66 (překladač `genre.v5`), jinak test hází.
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { GENRE_COMPILER_VERSION, GENRES, type GenreId } from '@/play/genre/contract';
import { compileGenre, GENRE_MODULES, readGenreSpec } from '@/play/genre/index';
import { readGameSpec } from '@/play/spec';

import { arcadeWorldOf } from '../compile';
import { hashArcade, instantiate, replay } from '../kernel';
import { ARCADE_LIBRARY } from '../library';
import { loadRapier } from '../physics/world';
import { runBot } from '../verify';

const BASELINE = 'evals/play/p66/hash-baseline.json';

interface Run {
  readonly tick: number;
  readonly outcome: string;
  readonly hash: string;
}
interface Cell {
  /** Žánr (`genre:<id>`), ovládací buňka (`control:<id>`) nebo soubor (`fixture:<cesta>`). */
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

/** Stejné věty jako `e2e/p61-portrait.spec.ts` pro žánry, které `framing-cells` nemá. */
const SENTENCES: Readonly<Partial<Record<GenreId, string>>> = {
  voyage: 'a pirate ship races between islands to the treasure',
  slice: 'a sushi chef slashes the fish flung into the air with his knife but leaves the spiky sea mines alone',
  crowd: 'one tiny lemming dashes down a cave tunnel, go through the right doors to turn him into 10, 50, 200 lemmings, avoid the saws, then swarm the huge troll at the end',
  merge: 'a cat knocks yarn balls into a basket, two matching ones squish together into a bigger ball, keep the heap from reaching the top',
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

/** Uložené hry na `main`: jen pro `P66_HASH_WRITE=1`. */
function savedGames(): readonly (readonly [string, unknown])[] {
  const framing = JSON.parse(readFileSync('evals/play/p58a/framing-cells.json', 'utf8')) as Record<string, { readonly spec: unknown }>;
  const genres = GENRES.map((genre) => {
    const cell = framing[genre];
    if (cell !== undefined) return [`genre:${genre}`, cell.spec] as const;
    const read = readGenreSpec({ hero: 'fox', ...(GENRE_MODULES[genre].draftFill(SENTENCES[genre]!, null) as object) });
    if (!read.ok) throw new Error(`${genre}: ${read.issues.join('; ')}`);
    return [`genre:${genre}`, compileGenre(read.value)] as const;
  });
  const controls = Object.entries(framing).filter(([key]) => key.startsWith('control:')).map(([key, cell]) => [key, cell.spec] as const);
  const fixtures = ['src/play/__fixtures__', 'src/play/__fixtures__/p25d', 'src/play/arcade/__fixtures__'].flatMap((dir) =>
    readdirSync(dir)
      .filter((name) => name.endsWith('.json') && !name.startsWith('invalid-'))
      .map((name) => [`fixture:${dir}/${name}`, JSON.parse(readFileSync(join(dir, name), 'utf8')) as unknown] as const),
  );
  return [...genres, ...controls, ...fixtures];
}

// Fyzikální tělesa (míč, tlačení) chtějí Rapier před prvním tikem – už při sběru testů v režimu zápisu.
await loadRapier();

if (process.env.P66_HASH_WRITE === '1') {
  if (GENRE_COMPILER_VERSION !== 'genre.v5') throw new Error(`P66_HASH_WRITE only on main before P66 (compiler ${GENRE_COMPILER_VERSION})`);
  const cells = savedGames().map(([id, spec]) => measure(id, spec, 1));
  writeFileSync(BASELINE, `${JSON.stringify({ measuredOn: 'main e661855c', compilerVersion: GENRE_COMPILER_VERSION, cells } satisfies Baseline, null, 1)}\n`);
}

const baseline = (existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, 'utf8')) : { cells: [] }) as Baseline;

describe('saved games play bit for bit as on main before P66 (P66 T1)', () => {
  it('pins one saved genre.v5 game of every pre-P66 genre', () => {
    const pinned = baseline.cells.filter((cell) => cell.id.startsWith('genre:'));
    expect(pinned.map((cell) => cell.id.slice('genre:'.length)).sort()).toEqual(
      ['arena', 'catch', 'crowd', 'defense', 'duel', 'flap', 'hop', 'merge', 'platformer', 'push', 'quest', 'rhythm', 'runner', 'shooter', 'slice', 'throw', 'timing', 'voyage', 'whack'],
    );
    for (const cell of pinned) expect((cell.spec as { readonly genre: { readonly compilerVersion: string } }).genre.compilerVersion).toBe('genre.v5');
  });

  it.each(baseline.cells.map((cell) => [cell.id, cell] as const))('%s: robot and idle player end in the pinned state', (_, cell) => {
    const now = measure(cell.id, cell.spec, cell.seed);
    expect({ initial: now.initial, bot: now.bot, idle: now.idle }).toEqual({ initial: cell.initial, bot: cell.bot, idle: cell.idle });
  });
});
