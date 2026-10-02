/**
 * Registr žánrů (P32-0 T3, od P36A T11 jedenáct): moduly a čtení `GenreSpec` včetně mezí
 * parametrů, které drží modul žánru.
 */

import { ARCADE_HZ, ARCADE_LIMITS, type AddonId } from '../arcade/contract';
import { CAPABILITIES } from '../capabilities';
import type { GameSpecV1 } from '../spec';

import { arenaGenre } from './arena';
import { type EnemyMove, type GenreId, type GenreModule, type GenreSpec, type ParamBounds, countIssues, genreSpecSchema, withCounts } from './contract';
import { duelGenre } from './duel';
import { flapGenre } from './flap';
import { platformerGenre } from './platformer';
import { questGenre } from './quest';
import { rhythmGenre } from './rhythm';
import { runnerGenre } from './runner';
import { shooterGenre } from './shooter';
import { throwGenre } from './throw';
import { timingGenre } from './timing';
import { voyageGenre } from './voyage';

export const GENRE_MODULES: { readonly [G in GenreId]: GenreModule<G> } = {
  runner: runnerGenre,
  platformer: platformerGenre,
  arena: arenaGenre,
  voyage: voyageGenre,
  quest: questGenre,
  shooter: shooterGenre,
  throw: throwGenre,
  timing: timingGenre,
  rhythm: rhythmGenre,
  duel: duelGenre,
  flap: flapGenre,
};

/**
 * Hloubka hry, kterou režisér nastaví v každém žánru (P36A T8): ploché
 * parametry vedle parametrů modulu. Modul je nečte – do hry je propíše
 * `compileWith` (životy, cílové skóre, časový limit). `targetScore` a
 * `timeLimit` 0 = bez cíle, bez limitu; limit nejvýš horizont jádra.
 */
export const DEPTH_PARAM_BOUNDS = {
  lives: { min: 1, max: 9 },
  targetScore: { min: 0, max: 9999 },
  timeLimit: { min: 0, max: ARCADE_LIMITS.maxTicks / ARCADE_HZ },
} as const satisfies ParamBounds;
type DepthParam = keyof typeof DEPTH_PARAM_BOUNDS;
type Depth = Partial<Readonly<Record<DepthParam, number>>>;

/** Meze všech parametrů, které `GenreSpec` žánru smí nést: modul + hloubka. */
export const paramBoundsOf = (module: GenreModule): ParamBounds => ({ ...module.paramBounds, ...DEPTH_PARAM_BOUNDS });

export type GenreSpecResult = { readonly ok: true; readonly value: GenreSpec } | { readonly ok: false; readonly issues: readonly string[] };

/** Tvar podle `genreSpecSchema`, pak parametry proti mezím modulu žánru. */
export function readGenreSpec(input: unknown): GenreSpecResult {
  const parsed = genreSpecSchema.safeParse(input);
  if (!parsed.success) return { ok: false, issues: parsed.error.issues.map((issue) => `/${issue.path.join('/')}: ${issue.message}`) };
  const bounds = paramBoundsOf(GENRE_MODULES[parsed.data.genre] as GenreModule);
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
  return compileWith(GENRE_MODULES[spec.genre] as GenreModule, spec);
}

/**
 * Překlad modulem `module` a pak hloubka (P36A T8): parametry hloubky modul
 * nevidí, hra je dostane až hotová. Bez nich je výsledek přesně překlad modulu.
 * Jediná cesta pro rychlý návrh, odpověď režiséra i opravné kolo.
 */
export function compileWith(module: GenreModule, spec: GenreSpec): GameSpecV1 {
  const own = { ...(spec.params ?? {}) };
  const depth: Record<string, number> = {};
  for (const key of Object.keys(DEPTH_PARAM_BOUNDS)) {
    if (own[key] === undefined) continue;
    depth[key] = own[key];
    delete own[key];
  }
  const { params: _params, ...rest } = spec;
  const plain = (Object.keys(own).length === 0 ? rest : { ...rest, params: own }) as GenreSpec;
  return withEnemyAddon(withDepth(module.compile(withCounts(plain) as never), depth), spec.enemyMoves);
}

/**
 * Životy do mechaniky `health` (hra žánru ji nese, výchozí 3), cílové skóre do
 * `scoring.target` (kompilátor ho ořízne na dosažitelné, mez specu je 10),
 * časový limit do časovače, který končí prohrou: hodiny, které hra už má,
 * dostanou novou délku; přežití (časovač končící výhrou) délku nese v `seconds`
 * modulu a limit ho nemění. Exportované pro rychlý návrh (životy a skóre z věty).
 */
export function withDepth(spec: GameSpecV1, depth: Depth): GameSpecV1 {
  const { lives, targetScore, timeLimit } = depth;
  let mechanics = spec.mechanics;
  if (lives !== undefined) mechanics = mechanics.map((mechanic) => (mechanic.id === 'health' ? { id: 'health', params: { max: lives } } : mechanic));
  if (timeLimit !== undefined && timeLimit > 0) {
    const clock = mechanics.find((mechanic) => mechanic.id === 'timer');
    if (clock === undefined) mechanics = [...mechanics, { id: 'timer', params: { id: 'clock', seconds: timeLimit, onEnd: 'lose' } }];
    else if ((clock.params as { readonly onEnd?: string }).onEnd === 'lose') mechanics = mechanics.map((mechanic) => (mechanic === clock ? { id: 'timer', params: { ...mechanic.params, seconds: timeLimit } } : mechanic));
  }
  const target = targetScore !== undefined && targetScore > 0 && spec.scoring !== undefined ? Math.max(10, targetScore) : null;
  return {
    ...spec,
    mechanics,
    ...(target === null ? {} : { scoring: { ...spec.scoring, target } }),
  };
}

/** Chování nepřítele jako doplněk ovládání (`chase` → pronásledovatel, `shoot` → střelba). */
const ENEMY_ADDONS: Partial<Readonly<Record<EnemyMove, AddonId>>> = { chase: 'chaser', shoot: 'shoot' };

/**
 * Doplněk jen hře, která staví trať ovládáním (běžec, skákačka) a ovládání ho
 * bere (`CAPABILITIES`). Hra s generátorem režimu (aréna, plavba, úkol) hraje
 * chování ve svém modulu, nebo ho nemá čím zahrát.
 */
function withEnemyAddon(spec: GameSpecV1, move: EnemyMove | undefined): GameSpecV1 {
  const addon = move === undefined ? undefined : ENEMY_ADDONS[move];
  const generator = (spec.controlParams as { readonly generator?: string } | undefined)?.generator;
  if (addon === undefined || generator !== undefined || spec.control === undefined || !CAPABILITIES[spec.control].addons.includes(addon)) return spec;
  const fireHint = `${spec.tutorial.controlsHint} F or Fire to shoot.`;
  return {
    ...spec,
    addons: [...new Set([...(spec.addons ?? []), addon])],
    ...(addon === 'shoot' && fireHint.length <= 80 ? { tutorial: { ...spec.tutorial, controlsHint: fireHint } } : {}),
  };
}
