import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { GENRES } from '../src/play/genre/contract';
import { compileGenre, GENRE_MODULES, readGenreSpec } from '../src/play/genre/index';

/**
 * Buňky rámování P64 (T1): 19 žánrů jako `p61-portrait` – hra z `p58a/framing-cells.json`, žánr, který tam není,
 * složený z věty bez modelu (`draftFill`) – a tři ovládání bez žánru z téhož souboru (`control:steer`, `walker`,
 * `ball`), protože jejich kamery přepisuje T5. Sdílí je audit na výšku, stráž šířky a hash v jádře.
 */

export interface P64Cell {
  /** Žánr, nebo `control:<id>`. */
  readonly key: string;
  /** Id buňky v `framing-cells.json`, `draft` = složená z věty. */
  readonly id: string;
  readonly spec: unknown;
}

const FRAMING = JSON.parse(readFileSync(join(process.cwd(), 'evals/play/p58a/framing-cells.json'), 'utf8')) as Record<string, { id: string; spec: unknown }>;

/** Věty žánrů, které `framing-cells.json` nemá – tytéž jako `p61-portrait`. */
const SENTENCES: Readonly<Record<string, string>> = {
  voyage: 'a pirate ship races between islands to the treasure',
  slice: 'a sushi chef slashes the fish flung into the air with his knife but leaves the spiky sea mines alone',
  crowd: 'one tiny lemming dashes down a cave tunnel, go through the right doors to turn him into 10, 50, 200 lemmings, avoid the saws, then swarm the huge troll at the end',
  merge: 'a cat knocks yarn balls into a basket, two matching ones squish together into a bigger ball, keep the heap from reaching the top',
};

/** Žánry P66 (survivor, hole, steal, sort, arrows) mají ruční spec, na kterém jedou jejich vlastní e2e. */
const P66_FIXTURE = (key: string): string => join(process.cwd(), `e2e/fixtures/p66-${key}-spec.json`);

function cellOf(key: string): P64Cell {
  const cell = FRAMING[key];
  if (cell !== undefined) return { key, id: cell.id, spec: cell.spec };
  if (existsSync(P66_FIXTURE(key))) return { key, id: 'p66-fixture', spec: JSON.parse(readFileSync(P66_FIXTURE(key), 'utf8')) as unknown };
  const genre = key as (typeof GENRES)[number];
  const read = readGenreSpec({ hero: 'fox', ...(GENRE_MODULES[genre].draftFill(SENTENCES[key]!, null) as object) });
  if (!read.ok) throw new Error(read.issues.join('; '));
  return { key, id: 'draft', spec: compileGenre(read.value) };
}

/**
 * Žánry P66 přišly do `main` až po T1: na výšku je rámuje vlastní šev `genres/portrait-first.ts` a hlídají jejich
 * vlastní e2e, ne stráže P64 (šířka, hash). Audit na výšku je jen měří (`P64_AUDIT_CELLS`).
 */
const P66_GENRES: readonly string[] = ['survivor', 'hole', 'steal', 'sort', 'arrows'];

export const P64_CELLS: readonly P64Cell[] = [...GENRES.filter((genre) => !P66_GENRES.includes(genre)), 'control:steer', 'control:walker', 'control:ball'].map(cellOf);

export const P64_AUDIT_CELLS: readonly P64Cell[] = [...P64_CELLS, ...P66_GENRES.map(cellOf)];
