/** Legacy genre reader; named control genres compile through recipe assemblies. */
import type { GameSpecV1 } from '../spec';
import { type GenreModule, type GenreSpec, type ParamBounds, boundCounts, genreSpecSchema, legacyCast } from './contract';
import { GENRE_MODULES } from './modules';
import { compileRecipe, DEPTH_PARAM_BOUNDS } from '../compose/compile';
import { presetOf } from '../compose/presets';
export { GENRE_MODULES } from './modules';
export { compileWith, withDepth, DEPTH_PARAM_BOUNDS } from '../compose/compile';
/** Meze všech parametrů, které `GenreSpec` žánru smí nést: modul + hloubka. */
export const paramBoundsOf = (module: GenreModule): ParamBounds => ({ ...module.paramBounds, ...DEPTH_PARAM_BOUNDS });

export type GenreSpecResult = { readonly ok: true; readonly value: GenreSpec } | { readonly ok: false; readonly issues: readonly string[] };

/** Tvar podle `genreSpecSchema`, pak parametry proti mezím modulu žánru; počty se do mezí jen oříznou. */
export function readGenreSpec(input: unknown): GenreSpecResult {
  const parsed = genreSpecSchema.safeParse(legacyCast(input));
  if (!parsed.success) return { ok: false, issues: parsed.error.issues.map((issue) => `/${issue.path.join('/')}: ${issue.message}`) };
  const bounds = paramBoundsOf(GENRE_MODULES[parsed.data.genre] as GenreModule);
  const issues = Object.entries(parsed.data.params ?? {}).flatMap(([key, value]) => {
    const range = bounds[key];
    if (range === undefined) return [`/params/${key}: ${parsed.data.genre} has no such parameter (known: ${Object.keys(bounds).join(', ') || 'none'})`];
    return value < range.min || value > range.max ? [`/params/${key}: ${String(value)} is outside ${String(range.min)}–${String(range.max)}`] : [];
  });
  return issues.length > 0 ? { ok: false, issues } : { ok: true, value: boundCounts(parsed.data, bounds) };
}

export function compileGenre(spec: GenreSpec): GameSpecV1 {
  return compileRecipe(presetOf(spec));
}
