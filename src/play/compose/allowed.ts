import type { GenreSpec } from '../genre/contract';
import type { Recipe } from './recipe';
import { PRESETS } from './presets';

interface Cell {
  readonly id: string;
  readonly recipe: Recipe;
  /** Reference assembly used by the executable five-seed capability check. */
}
export type AllowedCell = Cell & ({ readonly status: 'live'; readonly preset: GenreSpec } | { readonly status: 'staged'; readonly preset: GenreSpec | null });
export type LiveCell = Extract<AllowedCell, { status: 'live' }>;

export const ALLOWED: readonly AllowedCell[] = [
  ...Object.entries(PRESETS).map(([id, recipe]): LiveCell => {
    const [genre, mode] = id.split('.');
    return { id, status: 'live', recipe, preset: { genre, mode, hero: 'fox', setting: 'forest' } as GenreSpec };
  }),
  // Missing runtime/scene must never become eligible just because the intent asks for it.
  { id: 'glide.reach', status: 'staged', recipe: { move: 'glide', actions: [], objective: 'reach', threats: [] }, preset: null },
];

export const liveCells = (): readonly LiveCell[] => ALLOWED.filter((cell): cell is LiveCell => cell.status === 'live');
