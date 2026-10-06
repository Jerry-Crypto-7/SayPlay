import type { GenreSpec } from '../genre/contract';
import type { Recipe } from './recipe';
import { DRIVE_PRESETS, NATIVE_PRESETS, PRESETS, drivePresetOf, nativePresetOf, presetOf, type RecipeAssembly } from './presets';

interface Cell {
  readonly id: string;
  readonly recipe: Recipe;
  readonly assembly?: 'drive' | 'native';
  /** Reference assembly used by the executable five-seed capability check. */
}
export type AllowedCell = Cell & ({ readonly status: 'live'; readonly preset: GenreSpec } | { readonly status: 'staged'; readonly preset: GenreSpec | null });
export type LiveCell = Extract<AllowedCell, { status: 'live' }>;

export const ALLOWED: readonly AllowedCell[] = [
  ...Object.entries(DRIVE_PRESETS).map(([id, recipe]): AllowedCell => ({
    id, recipe, assembly: 'drive', status: 'live',
    preset: { genre: 'voyage', mode: 'race', hero: 'car', setting: 'city', cast: [
      ...(recipe.actions.includes('shoot') ? [{ label: 'zombie', does: 'shoot_at' as const }] : []),
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
    id, recipe, assembly: 'native', status: 'staged',
    preset: recipe.move === 'walk' ? { genre: 'quest', mode: 'spatial', hero: 'fox', setting: 'maze', cast: [
      { label: recipe.threats.includes('guard') ? 'guard' : 'wolf', does: 'chase_me' }, { label: 'coin', does: 'collect' }, { label: 'exit', does: 'reach' },
    ] } : { genre: 'voyage', mode: 'race', hero: 'fish', setting: 'coral reef', cast: [
      { label: 'ring', does: 'collect' }, { label: 'reef', does: 'avoid' },
      { label: 'dolphin', does: 'fight' }, { label: 'shark', does: 'chase_me' },
      ...(recipe.actions.includes('shoot') ? [{ label: 'eel', does: 'shoot_at' as const }] : []),
    ] },
  })),
];

export const liveCells = (): readonly LiveCell[] => ALLOWED.filter((cell): cell is LiveCell => cell.status === 'live');

export function assemblyOfCell(cell: AllowedCell, content = cell.preset): RecipeAssembly {
  if (content === null) throw new Error(`No assembly for staged cell ${cell.id}`);
  return cell.assembly === 'native' ? nativePresetOf(cell.id, content) : cell.assembly === 'drive' ? drivePresetOf(cell.id, content) : presetOf(content);
}
