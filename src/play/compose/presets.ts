import type { GenreSpec } from '../genre/contract';
import { recipeKey, type Recipe } from './recipe';

export const PRESETS: Readonly<Record<string, Recipe>> = {
  'runner.default': { move: 'run', actions: [], objective: 'reach', threats: [] },
  'platformer.default': { move: 'jump', actions: [], objective: 'reach', threats: [] },
  'flap.default': { move: 'flap', actions: [], objective: 'reach', threats: [] },
  'shooter.default': { move: 'stationary', actions: ['shoot'], objective: 'defeat', threats: [] },
  'throw.default': { move: 'stationary', actions: ['throw'], objective: 'score', threats: [] },
  'timing.stack': { move: 'stationary', actions: ['stack'], objective: 'build', threats: [] },
  'timing.precision': { move: 'stationary', actions: ['time'], objective: 'score', threats: [] },
  'timing.bridge': { move: 'stationary', actions: ['time'], objective: 'score', threats: [] },
  'rhythm.default': { move: 'stationary', actions: ['beat'], objective: 'score', threats: [] },
  'duel.default': { move: 'stationary', actions: ['duel'], objective: 'score', threats: [] },
  'arena.escape': { move: 'roam', actions: [], objective: 'survive', threats: ['chaser'] },
  'arena.collect': { move: 'roam', actions: ['collect'], objective: 'collect', threats: [] },
  'arena.fight': { move: 'roam', actions: ['fight'], objective: 'defeat', threats: [] },
  // The frozen voyage.race has no competitors. Its honest recipe is reach.
  'voyage.race': { move: 'drive', actions: [], objective: 'reach', threats: [] },
  'voyage.land': { move: 'drive', actions: [], objective: 'land', threats: [] },
  'quest.spatial': { move: 'roam', actions: ['interact'], objective: 'interact', threats: ['chaser'] },
  'quest.station': { move: 'stationary', actions: ['interact'], objective: 'interact', threats: [] },
};

/** Content retains cast/parameter order, including the frozen legacy addon order. */
export type RecipeAssembly = Recipe & { readonly preset: string; readonly content: GenreSpec };

/** Native tracks have distinct names; the legacy voyage recipes stay frozen. */
export const DRIVE_PRESETS: Readonly<Record<string, Recipe>> = Object.fromEntries(
  (['race', 'reach', 'escape'] as const).flatMap(objective => [false, true].map(shoot => [
    `drive.${objective}${shoot ? '+shoot' : ''}`,
    { move: 'drive', actions: shoot ? ['shoot'] : [], objective, threats: objective === 'race' ? ['rival'] : objective === 'escape' ? ['chaser'] : [] },
  ])),
);

const GLIDE_PRESETS: Readonly<Record<string, Recipe>> = Object.fromEntries(
  (['reach', 'collect', 'race', 'escape'] as const).flatMap(objective => [false, true].map(shoot => [
    `glide.${objective}${shoot ? '+shoot' : ''}`,
    { move: 'glide', actions: [...(objective === 'collect' ? ['collect' as const] : []), ...(shoot ? ['shoot' as const] : [])], objective, threats: objective === 'race' ? ['rival'] : objective === 'escape' ? ['chaser'] : [] },
  ])),
);

export const WALKER_PRESETS: Readonly<Record<string, Recipe>> = {
  'walk.reach': { move: 'walk', actions: [], objective: 'reach', threats: [] },
  'walk.collect': { move: 'walk', actions: ['collect'], objective: 'collect', threats: [] },
  'walk.reach+guard': { move: 'walk', actions: [], objective: 'reach', threats: ['guard'] },
  'walk.collect+guard': { move: 'walk', actions: ['collect'], objective: 'collect', threats: ['guard'] },
  'walk.escape': { move: 'walk', actions: [], objective: 'escape', threats: ['chaser'] },
  'walk.escape+collect': { move: 'walk', actions: ['collect'], objective: 'escape', threats: ['chaser'] },
};
export const BALL_PRESETS: Readonly<Record<string, Recipe>> = {
  'ball.score': { move: 'ball', actions: [], objective: 'score', threats: [] },
  'ball.score+rival': { move: 'ball', actions: [], objective: 'score', threats: ['rival'] },
};
export const NATIVE_PRESETS: Readonly<Record<string, Recipe>> = { ...GLIDE_PRESETS, ...WALKER_PRESETS, ...BALL_PRESETS };

export function nativePresetOf(preset: string, content: GenreSpec): RecipeAssembly {
  const recipe = NATIVE_PRESETS[preset];
  if (recipe === undefined) throw new Error(`No native recipe ${preset}`);
  return { ...recipe, preset, content };
}

export function drivePresetOf(preset: string, content: GenreSpec): RecipeAssembly {
  const recipe = DRIVE_PRESETS[preset];
  if (recipe === undefined) throw new Error(`No native driving recipe ${preset}`);
  return { ...recipe, preset, content };
}

function recipeOf(content: GenreSpec): Recipe {
  const preset = `${content.genre}.${content.mode}`;
  const recipe = PRESETS[preset];
  if (recipe === undefined) throw new Error(`No recipe preset for ${preset}`);
  // These two legacy track assemblies play extra cast actions through addons.
  // Other genre casts may only decorate a body; do not claim their verbs here.
  const track = content.genre === 'runner' || content.genre === 'platformer';
  const shooting = track && content.cast?.some(item => item.does === 'shoot_at');
  const chasing = track && content.cast?.some(item => item.does === 'chase_me');
  const escapeCollect = content.genre === 'arena' && content.mode === 'escape' && content.cast?.some(item => item.does === 'collect');
  return { ...recipe, ...(escapeCollect ? { objective: 'collect' as const } : {}), actions: [...recipe.actions, ...(shooting ? ['shoot' as const] : []), ...(escapeCollect ? ['collect' as const] : [])], threats: [...recipe.threats, ...(chasing ? ['chaser' as const] : [])] };
}

export function presetOf(content: GenreSpec): RecipeAssembly {
  const preset = `${content.genre}.${content.mode}`;
  return { ...recipeOf(content), preset, content };
}

export function assertPreset(assembly: RecipeAssembly): void {
  const native = DRIVE_PRESETS[assembly.preset] ?? NATIVE_PRESETS[assembly.preset];
  if (native !== undefined) {
    if (recipeKey(native) !== recipeKey(assembly)) throw new Error(`Recipe does not match preset ${assembly.preset}`);
    return;
  }
  const expected = recipeOf(assembly.content);
  if (recipeKey(expected) !== recipeKey(assembly) || assembly.preset !== `${assembly.content.genre}.${assembly.content.mode}`) {
    throw new Error(`Recipe does not match preset ${assembly.preset}`);
  }
}
