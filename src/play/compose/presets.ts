import type { AbilityId } from '../arcade/contract';
import type { AbilityWord } from '../draft/controls';
import type { GenreSpec } from '../genre/contract';
import { recipeKey, type Recipe } from './recipe';
import type { AssemblyPart } from './parts';

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
  'voyage.land': { move: 'glide', actions: [], objective: 'land', threats: [] },
  'quest.spatial': { move: 'roam', actions: ['interact'], objective: 'interact', threats: ['chaser'] },
  'quest.station': { move: 'stationary', actions: ['interact'], objective: 'interact', threats: [] },
  // P54C T5: chytání je živé – jeho buňka se z `STAGED_PRESETS` přesunula sem.
  'catch.default': { move: 'lanes', actions: ['collect'], objective: 'collect', threats: ['hazard'] },
  // P54C T6: bouchání je živé.
  'whack.default': { move: 'lanes', actions: ['whack'], objective: 'defeat', threats: [] },
  // P54C T7: obrana pruhů je živá.
  'defense.default': { move: 'lanes', actions: ['shoot'], objective: 'defend', threats: ['chaser'] },
  // P54C T8: krájení je živé.
  'slice.default': { move: 'lanes', actions: ['slice'], objective: 'score', threats: ['hazard'] },
  // P54C T9: přeskákání silnice je živé (vlastní ovládání `hop`, ne pruhy).
  'hop.default': { move: 'hop', actions: [], objective: 'reach', threats: ['obstacle'] },
  // P54C T10: dav a brány je živý (vlastní ovládání `crowd`).
  'crowd.default': { move: 'crowd', actions: [], objective: 'defeat', threats: ['obstacle'] },
  // P54C T11: pouštění a slučování je živé (vlastní ovládání `merge`, Rapier).
  'merge.default': { move: 'drop', actions: ['merge'], objective: 'score', threats: [] },
  // P54C T12: vytlačování z ringu je živé (vlastní ovládání `push`, Rapier).
  'push.default': { move: 'roam', actions: ['push'], objective: 'defeat', threats: ['rival'] },
  // P66 T12: the five P66 genres are live – their cells moved here from `STAGED_PRESETS` in one selection change.
  'survivor.default': { move: 'roam', actions: ['autofire'], objective: 'defeat', threats: ['chaser'] },
  'hole.default': { move: 'roam', actions: ['swallow'], objective: 'score', threats: [] },
  'steal.default': { move: 'roam', actions: ['steal'], objective: 'score', threats: ['guard'] },
  'sort.default': { move: 'stationary', actions: ['sort'], objective: 'score', threats: [] },
  'arrows.default': { move: 'stationary', actions: ['unblock'], objective: 'score', threats: [] },
  // P68 T11: the build-shift shop is live – its cell moved here from `STAGED_PRESETS`.
  'buildshift.default': { move: 'stationary', actions: ['shopbuild'], objective: 'score', threats: [] },
  // P68 T8: the stunt race is live.
  'stunt.default': { move: 'drive', actions: ['stunt'], objective: 'reach', threats: ['obstacle'] },
  // P68 T9: one minigolf hole is live – its cell moved here from `STAGED_PRESETS`.
  'minigolf.default': { move: 'stationary', actions: ['putt'], objective: 'score', threats: [] },
  // P68 T12: draw-to-save is live – its cell moved here from `STAGED_PRESETS`.
  'drawsave.default': { move: 'stationary', actions: ['drawwall'], objective: 'survive', threats: ['hazard'] },
  // P68 T10: the first-person rail shooter is live – its cell moved here from `STAGED_PRESETS`.
  'railfps.default': { move: 'stationary', actions: ['railshoot'], objective: 'defeat', threats: ['chaser'] },
  // P83C T4: the tap-to-explore scene is live – its cell moved here from `STAGED_PRESETS`.
  'orrery.default': { move: 'stationary', actions: ['explore'], objective: 'score', threats: [] },
};

/**
 * Recipes of staged genres (P54C T4, P66 T2). They stay out of `PRESETS` – every PRESETS entry is a
 * live cell and a `sourceFor` reading – until the genre's own task makes its cell live.
 * P54C T12 and P66 T12 made the last ones live; the table stays for a genre whose own task has to fall back.
 * P68 T1 stages its five games here; each P68-I activation task moves its own line to `PRESETS`.
 */
export const STAGED_PRESETS: Readonly<Record<string, Recipe>> = {};

/**
 * What the sentence asked for, passed by `assemble` (P45B T9): its words and the requested
 * actions the recipe cannot play. Only an assembly carrying it gets a rule template.
 */
export interface RecipeIntent {
  readonly words: readonly string[];
  readonly unplayed: readonly string[];
}

/** Content retains cast/parameter order, including the frozen legacy addon order. */
// `abilities`: akce hrdiny, které věta řekla, v jejím pořadí (P46A T8); ovládání si z nich vezme, co bere.
// `saidWords`: sloveso věty pro akci ze seznamu `ABILITY_WORDS` (P47B T10) – popisek tlačítka, svět ho nečte.
export type RecipeAssembly = Recipe & {
  readonly preset: string;
  readonly content: GenreSpec;
  readonly parts?: readonly (AssemblyPart & { readonly label: string })[];
  readonly intent?: RecipeIntent;
  readonly abilities?: readonly AbilityId[];
  readonly saidWords?: Readonly<Partial<Record<AbilityId, AbilityWord>>>;
};

/** Native tracks have distinct names; the legacy voyage recipes stay frozen. */
export const DRIVE_PRESETS: Readonly<Record<string, Recipe>> = { ...Object.fromEntries(
  (['race', 'reach', 'escape'] as const).flatMap(objective => [false, true].map(shoot => [
    `drive.${objective}${shoot ? '+shoot' : ''}`,
    { move: 'drive', actions: shoot ? ['shoot'] : [], objective, threats: objective === 'race' ? ['rival'] : objective === 'escape' ? ['chaser'] : [] },
  ])),
  ),
  'drive.reach+deliver': { move: 'drive', actions: ['deliver'], objective: 'reach', threats: [] },
  'drive.reach+shoot+collect': { move: 'drive', actions: ['shoot', 'collect'], objective: 'reach', threats: [] },
};

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
    'walk.escape+collect+guard': { move: 'walk', actions: ['collect'], objective: 'escape', threats: ['guard'] },
};
/** Opt-in track objectives; no legacy preset or default assembly changes. */
export const TRACK_GOAL_PRESETS: Readonly<Record<string, Recipe>> = {
  'run.escape': { move: 'run', actions: [], objective: 'escape', threats: ['chaser'] },
  'jump.escape': { move: 'jump', actions: [], objective: 'escape', threats: ['chaser'] },
  'flap.collect': { move: 'flap', actions: ['collect'], objective: 'collect', threats: [] },
};
export function trackGoalPresetOf(preset: string, content: GenreSpec): RecipeAssembly {
  const recipe = TRACK_GOAL_PRESETS[preset];
  if (recipe === undefined) throw new Error(`No track objective ${preset}`);
  return { ...recipe, preset, content };
}

export const BALL_PRESETS: Readonly<Record<string, Recipe>> = {
  'ball.defeat': { move: 'ball', actions: [], objective: 'defeat', threats: [] },
  'ball.score': { move: 'ball', actions: [], objective: 'score', threats: [] },
  'ball.score+rival': { move: 'ball', actions: [], objective: 'score', threats: ['rival'] },
};
export const CATCH_PRESETS: Readonly<Record<string, Recipe>> = { 'roam.catch': { move: 'roam', actions: [], objective: 'catch', threats: [] } };
export function catchPresetOf(preset: string, content: GenreSpec): RecipeAssembly {
  const recipe = CATCH_PRESETS[preset];
  if (recipe === undefined) throw new Error('Unknown catch recipe');
  return { ...recipe, preset, content };
}

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
  const native = CATCH_PRESETS[assembly.preset] ?? DRIVE_PRESETS[assembly.preset] ?? NATIVE_PRESETS[assembly.preset] ?? TRACK_GOAL_PRESETS[assembly.preset];
  if (native !== undefined) {
    if (recipeKey(native) !== recipeKey(assembly)) throw new Error(`Recipe does not match preset ${assembly.preset}`);
    return;
  }
  const expected = recipeOf(assembly.content);
  if (recipeKey(expected) !== recipeKey(assembly) || assembly.preset !== `${assembly.content.genre}.${assembly.content.mode}`) {
    throw new Error(`Recipe does not match preset ${assembly.preset}`);
  }
}
