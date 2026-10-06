import type { GenreSpec } from '../genre/contract';
import { recipeKey, type Recipe } from './recipe';

export const CONTROL_PRESETS: Readonly<Record<string, Recipe>> = {
  'runner.default': { move: 'run', actions: [], objective: 'reach', threats: [] },
  'platformer.default': { move: 'jump', actions: [], objective: 'reach', threats: [] },
  'flap.default': { move: 'flap', actions: [], objective: 'reach', threats: [] },
  'shooter.default': { move: 'stationary', actions: ['shoot'], objective: 'defeat', threats: [] },
  'throw.default': { move: 'stationary', actions: ['throw'], objective: 'defeat', threats: [] },
  'timing.stack': { move: 'stationary', actions: ['stack'], objective: 'build', threats: [] },
  'timing.precision': { move: 'stationary', actions: ['time'], objective: 'score', threats: [] },
  'timing.bridge': { move: 'stationary', actions: ['time'], objective: 'score', threats: [] },
  'rhythm.default': { move: 'stationary', actions: ['beat'], objective: 'score', threats: [] },
  'duel.default': { move: 'stationary', actions: ['duel'], objective: 'score', threats: [] },
};

/** Content retains cast/parameter order, including the frozen legacy addon order. */
export type RecipeAssembly = Recipe & { readonly preset: string; readonly content: GenreSpec };

function recipeOf(content: GenreSpec): Recipe {
  const preset = `${content.genre}.${content.mode}`;
  const recipe = CONTROL_PRESETS[preset];
  if (recipe === undefined) throw new Error(`No recipe preset for ${preset}`);
  // These two legacy track assemblies play extra cast actions through addons.
  // Other genre casts may only decorate a body; do not claim their verbs here.
  const track = content.genre === 'runner' || content.genre === 'platformer';
  const shooting = track && content.cast?.some(item => item.does === 'shoot_at');
  const chasing = track && content.cast?.some(item => item.does === 'chase_me');
  return { ...recipe, actions: [...recipe.actions, ...(shooting ? ['shoot' as const] : [])], threats: [...recipe.threats, ...(chasing ? ['chaser' as const] : [])] };
}

export function presetOf(content: GenreSpec): RecipeAssembly {
  const preset = `${content.genre}.${content.mode}`;
  return { ...recipeOf(content), preset, content };
}

export function assertPreset(assembly: RecipeAssembly): void {
  const expected = recipeOf(assembly.content);
  if (recipeKey(expected) !== recipeKey(assembly) || assembly.preset !== `${assembly.content.genre}.${assembly.content.mode}`) {
    throw new Error(`Recipe does not match preset ${assembly.preset}`);
  }
}
