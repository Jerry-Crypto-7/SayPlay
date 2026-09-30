/**
 * Registr žánrů (P32-0 T3): pět modulů a čtení `GenreSpec` včetně mezí
 * parametrů, které drží modul žánru.
 */

import type { GameSpecV1 } from '../spec';

import { arenaGenre } from './arena';
import { type GenreId, type GenreModule, type GenreSpec, countIssues, genreSpecSchema, withCounts } from './contract';
import { platformerGenre } from './platformer';
import { questGenre } from './quest';
import { runnerGenre } from './runner';
import { voyageGenre } from './voyage';

export const GENRE_MODULES: { readonly [G in GenreId]: GenreModule<G> } = {
  runner: runnerGenre,
  platformer: platformerGenre,
  arena: arenaGenre,
  voyage: voyageGenre,
  quest: questGenre,
};

export type GenreSpecResult = { readonly ok: true; readonly value: GenreSpec } | { readonly ok: false; readonly issues: readonly string[] };

/** Tvar podle `genreSpecSchema`, pak parametry proti mezím modulu žánru. */
export function readGenreSpec(input: unknown): GenreSpecResult {
  const parsed = genreSpecSchema.safeParse(input);
  if (!parsed.success) return { ok: false, issues: parsed.error.issues.map((issue) => `/${issue.path.join('/')}: ${issue.message}`) };
  const bounds = GENRE_MODULES[parsed.data.genre].paramBounds;
  const issues = Object.entries(parsed.data.params ?? {}).flatMap(([key, value]) => {
    const range = bounds[key];
    if (range === undefined) return [`/params/${key}: ${parsed.data.genre} has no such parameter (known: ${Object.keys(bounds).join(', ') || 'none'})`];
    return value < range.min || value > range.max ? [`/params/${key}: ${String(value)} is outside ${String(range.min)}–${String(range.max)}`] : [];
  });
  issues.push(...countIssues(parsed.data, bounds));
  return issues.length > 0 ? { ok: false, issues } : { ok: true, value: parsed.data };
}

/** `GenreSpec` → `GameSpecV1` modulem jeho žánru; počty rolí jdou do parametrů, které modul čte (B-R4). */
export function compileGenre(spec: GenreSpec): GameSpecV1 {
  // Sjednocení `spec` se na modul jeho žánru nezúží samo – `genre` je obojímu společný klíč.
  return (GENRE_MODULES[spec.genre] as GenreModule).compile(withCounts(spec) as never);
}
