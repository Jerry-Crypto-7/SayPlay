import { CATCH_TUNING } from './catch';
import { LEGACY_DIFFICULTY } from './legacy-difficulty';
import { withCounts, type GenreSpec } from '../genre/contract';
import type { Recipe } from './recipe';
import { CATCH_PRESETS, catchPresetOf, DRIVE_PRESETS, NATIVE_PRESETS, PRESETS, STAGED_PRESETS, TRACK_GOAL_PRESETS, trackGoalPresetOf, drivePresetOf, nativePresetOf, presetOf, type RecipeAssembly } from './presets';

interface Cell {
  readonly id: string;
  readonly recipe: Recipe;
  readonly assembly?: 'drive' | 'native' | 'track-goal' | 'catch';
  /** Reference assembly used by the executable five-seed capability check. */
}
export type AllowedCell = Cell & ({ readonly status: 'live'; readonly preset: GenreSpec } | { readonly status: 'staged'; readonly preset: GenreSpec | null });
export type LiveCell = Extract<AllowedCell, { status: 'live' }>;

const BASE_ALLOWED: readonly AllowedCell[] = [
  { id: 'roam.catch', assembly: 'catch', status: 'live', recipe: CATCH_PRESETS['roam.catch']!, preset: { genre: 'arena', mode: 'collect', hero: 'dog', setting: 'park', params: { ...CATCH_TUNING }, cast: [{ label: 'cat', does: 'fight' }] } },
  ...Object.entries(TRACK_GOAL_PRESETS).map(([id, recipe]): LiveCell => ({
    id, recipe, assembly: 'track-goal', status: 'live',
    preset: { genre: recipe.move === 'run' ? 'runner' : recipe.move === 'jump' ? 'platformer' : 'flap', mode: 'default', hero: recipe.move === 'flap' ? 'bird' : 'fox', setting: 'forest',
      cast: recipe.objective === 'escape' ? [{ label: 'wolf', does: 'chase_me' }] : [{ label: 'coin', does: 'collect' }] },
  })),
  ...Object.entries(DRIVE_PRESETS).map(([id, recipe]): AllowedCell => ({
    id, recipe, assembly: 'drive', status: 'live',
    preset: { genre: 'voyage', mode: 'race', hero: 'car', setting: 'city', cast: [
      ...(recipe.actions.includes('shoot') ? [{ label: 'zombie', does: 'shoot_at' as const }] : []),
      ...(recipe.actions.includes('collect') ? [{ label: 'crystal', does: 'collect' as const }] : []),
      ...(recipe.threats.includes('chaser') ? [{ label: 'police car', does: 'chase_me' as const }] : []),
    ] },
  })),
  ...Object.entries(PRESETS).map(([id, recipe]): LiveCell => {
    const [genre, mode] = id.split('.');
    return { id, status: 'live', recipe, preset: { genre, mode, hero: 'fox', setting: 'forest' } as GenreSpec };
  }),
  // Already supported track addons also need explicit executable cells. Without
  // these, routing the draft through ALLOWED would regress existing run + shoot.
  ...(['runner', 'platformer'] as const).flatMap(genre => [
    [{ label: 'robot', does: 'shoot_at' as const }],
    [{ label: 'wolf', does: 'chase_me' as const }],
    [{ label: 'wolf', does: 'chase_me' as const }, { label: 'robot', does: 'shoot_at' as const }],
  ].map((cast): LiveCell => {
    const preset: GenreSpec = { genre, mode: 'default', hero: 'fox', setting: 'forest', cast };
    const { content: _content, preset: _preset, ...recipe } = presetOf(preset);
    return { id: `${genre}.default+${cast.map(item => item.does).join('+')}`, status: 'live', recipe, preset };
  })),
  { id: 'arena.escape+collect', status: 'live', recipe: { move: 'roam', actions: ['collect'], objective: 'collect', threats: ['chaser'] }, preset: { genre: 'arena', mode: 'escape', hero: 'fox', setting: 'forest', cast: [{ label: 'wolf', does: 'chase_me' }, { label: 'coin', does: 'collect' }] } },
  // Missing runtime/scene must never become eligible just because the intent asks for it.
  ...Object.entries(NATIVE_PRESETS).map(([id, recipe]): AllowedCell => ({
    id, recipe, assembly: 'native', status: 'live',
    preset: recipe.move === 'ball' ? { genre: 'throw', mode: 'default', hero: 'penguin', setting: 'football field', cast: [{ label: recipe.objective === 'defeat' ? 'pin' : 'goal', does: 'throw_at' }, { label: 'walrus', does: 'fight' }] } : recipe.move === 'walk' ? { genre: 'quest', mode: 'spatial', hero: 'fox', setting: 'maze', params: { paceBudgetPct: 100, corridorRisePermille: 200 }, cast: [
      { label: recipe.threats.includes('guard') ? 'guard' : 'wolf', does: 'chase_me' }, { label: 'coin', does: 'collect' }, { label: 'exit', does: 'reach' },
    ] } : { genre: 'voyage', mode: 'race', hero: 'fish', setting: 'coral reef', params: { clearancePermille: 275, clearanceRisePermille: 10 }, cast: [
      { label: 'ring', does: 'collect' }, { label: 'reef', does: 'avoid' },
      { label: 'dolphin', does: 'fight' }, { label: 'shark', does: 'chase_me' },
      ...(recipe.actions.includes('shoot') ? [{ label: 'eel', does: 'shoot_at' as const }] : []),
    ] },
  })),
  // P54C T4: the eight new genres are known but never selected; each genre task flips its own line to live.
  ...Object.entries(STAGED_PRESETS).map(([id, recipe]): AllowedCell => ({ id, recipe, status: 'staged', preset: null })),
];

export const ALLOWED: readonly AllowedCell[] = BASE_ALLOWED.map((cell): AllowedCell => {
  const params = cell.assembly === 'drive' ? { lengthM: 700, roadWidth: cell.recipe.actions.includes('collect') ? 3800 : 3600, crashBudget: 1, roadEntryWidth: cell.recipe.objective === 'race' ? 10000 : cell.recipe.actions.includes('collect') ? 4200 : 4000 } : LEGACY_DIFFICULTY[cell.id];
  return params === undefined || cell.preset === null ? cell : { ...cell, preset: { ...cell.preset, params: { ...params, ...cell.preset.params } } };
});

export const liveCells = (): readonly LiveCell[] => ALLOWED.filter((cell): cell is LiveCell => cell.status === 'live');

export function assemblyOfCell(cell: AllowedCell, content = cell.preset): RecipeAssembly {
  if (content === null) throw new Error(`No assembly for staged cell ${cell.id}`);
  let defaults = cell.preset?.params;
  if (cell.id === 'arena.escape' && content.params?.seconds !== undefined) {
    // The reference pressure is calibrated for its default survival duration.
    // A requested duration keeps the legacy balance; explicit pressure still wins.
    const { entryDistance: _entry, chaseLead: _lead, chaserSpeed: _speed, lives: _lives, ...rest } = defaults ?? {};
    defaults = rest;
  }
  const requestedItems = content.params?.items ?? content.counts?.collectible;
  if (cell.id === 'arena.collect' && requestedItems !== undefined && requestedItems !== defaults?.items) {
    // The eight-pickup challenge is calibrated as a whole. An explicit different
    // count uses the legacy course balance; authored tuning still takes priority.
    const { pursuitCeiling: _ceiling, itemSizePct: _size, ...rest } = defaults ?? {};
    defaults = rest;
  }
  // Named counts are explicit content, so resolve them before adding recipe
  // defaults. Explicit params retain the existing precedence over counts.
  const tuned = defaults !== undefined ? { ...content, params: { ...defaults, ...withCounts(content).params } } : content;
  return cell.assembly === 'catch' ? catchPresetOf(cell.id, tuned) : cell.assembly === 'track-goal' ? trackGoalPresetOf(cell.id, tuned) : cell.assembly === 'native' ? nativePresetOf(cell.id, tuned) : cell.assembly === 'drive' ? drivePresetOf(cell.id, tuned) : presetOf(tuned);
}
