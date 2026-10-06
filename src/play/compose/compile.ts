import { ARCADE_HZ, ARCADE_LIMITS, type AddonId } from '../arcade/contract';
import { CAPABILITIES } from '../capabilities';
import type { GameSpecV1 } from '../spec';
import { type CastRole, FOE_DOES, type GenreModule, type GenreSpec, type ParamBounds, withCounts } from '../genre/contract';
import { GENRE_MODULES } from '../genre/modules';
import { DRIVE_PRESETS, NATIVE_PRESETS, assertPreset, type RecipeAssembly } from './presets';
import { driveSpec } from './drive';
import { nativeSpec } from './native';

/** Recipes select an assembly; existing piece builders retain their frozen output. */
export function compileRecipe(assembly: RecipeAssembly): GameSpecV1 {
  assertPreset(assembly);
  if (DRIVE_PRESETS[assembly.preset] !== undefined) {
    const { move, actions, objective, threats } = assembly;
    return driveSpec({ move, actions, objective, threats }, assembly.content);
  }
  if (NATIVE_PRESETS[assembly.preset] !== undefined) {
    const { move, actions, objective, threats } = assembly;
    return nativeSpec({ move, actions, objective, threats }, assembly.content);
  }
  return compileWith(GENRE_MODULES[assembly.content.genre] as GenreModule, assembly.content);
}
export const DEPTH_PARAM_BOUNDS = {
  lives: { min: 1, max: 9 },
  targetScore: { min: 0, max: 9999 },
  timeLimit: { min: 0, max: ARCADE_LIMITS.maxTicks / ARCADE_HZ },
} as const satisfies ParamBounds;
type DepthParam = keyof typeof DEPTH_PARAM_BOUNDS;
type Depth = Partial<Readonly<Record<DepthParam, number>>>;

/**
 * Překlad modulem `module` a pak hloubka (P36A T8): parametry hloubky modul
 * nevidí, hra je dostane až hotová – jen časový limit dostane modul s hodinami
 * (`clockParam`) i předem. Bez nich je výsledek přesně překlad modulu.
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
  // Limit režiséra jsou hodiny, do kterých modul plánuje délku (úkol svá kola, F3); hodiny pak nastaví `withDepth` stejně.
  if (module.clockParam !== undefined && depth.timeLimit !== undefined && depth.timeLimit > 0) own[module.clockParam] = depth.timeLimit;
  const { params: _params, ...rest } = spec;
  const plain = (Object.keys(own).length === 0 ? rest : { ...rest, params: own }) as GenreSpec;
  const game = withEnemyAddon(withDepth(module.compile(withCounts(plain) as never), depth), spec);
  // Činnost hrdiny je jen vzhled (P37A T3): modul ji nečte, hra ji dostane hotová.
  return spec.heroAction === undefined ? game : { ...game, heroAction: spec.heroAction };
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

/** Role obsazení jako doplněk ovládání (`chase_me` → pronásledovatel, `shoot_at` → střelba). */
const ENEMY_ADDONS: Partial<Readonly<Record<CastRole, AddonId>>> = { chase_me: 'chaser', shoot_at: 'shoot' };

/**
 * Doplněk jen hře, která staví trať ovládáním (běžec, skákačka) a ovládání ho
 * bere (`CAPABILITIES`). Hra s generátorem režimu (aréna, plavba, úkol) hraje
 * chování ve svém modulu podle `does` (lovec, hlídka). Role, kterou žánr hraje
 * sám (`FOE_DOES`: aréna honí, střílečka střílí), doplněk nedostane. Každá
 * role obsazení dostane svůj doplněk (P39 T7), v pořadí obsazení.
 */
function withEnemyAddon(spec: GameSpecV1, genre: Pick<GenreSpec, 'genre' | 'cast'>): GameSpecV1 {
  const generator = (spec.controlParams as { readonly generator?: string } | undefined)?.generator;
  if (generator !== undefined || spec.control === undefined) return spec;
  const allowed = CAPABILITIES[spec.control].addons;
  const wanted = new Set((genre.cast ?? []).map((item) => (item.does === FOE_DOES[genre.genre] ? undefined : ENEMY_ADDONS[item.does])));
  // Pevné pořadí (pronásledovatel, střelba), ne pořadí obsazení: doplňky přidávají těla, takže pořadí obsazení by pohnulo hashem světa (T8).
  const added = Object.values(ENEMY_ADDONS).filter((addon) => wanted.has(addon) && allowed.includes(addon));
  if (added.length === 0) return spec;
  const fireHint = `${spec.tutorial.controlsHint} F or Fire to shoot.`;
  return {
    ...spec,
    addons: [...new Set([...(spec.addons ?? []), ...added])],
    ...(added.includes('shoot') && fireHint.length <= 80 ? { tutorial: { ...spec.tutorial, controlsHint: fireHint } } : {}),
  };
}
