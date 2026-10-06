import type { GenreSpec } from '../genre/contract';
import type { Recipe } from './recipe';

interface Cell {
  readonly id: string;
  readonly recipe: Recipe;
  /** Reference assembly used by the executable five-seed capability check. */
}
export type AllowedCell = Cell & ({ readonly status: 'live'; readonly preset: GenreSpec } | { readonly status: 'staged'; readonly preset: GenreSpec | null });
export type LiveCell = Extract<AllowedCell, { status: 'live' }>;

export const ALLOWED: readonly AllowedCell[] = [
  { id: 'runner.default', status: 'live', recipe: { move: 'run', actions: [], objective: 'reach', threats: [] }, preset: { genre: 'runner', mode: 'default', hero: 'fox', setting: 'forest' } },
  { id: 'platformer.default', status: 'live', recipe: { move: 'jump', actions: [], objective: 'reach', threats: [] }, preset: { genre: 'platformer', mode: 'default', hero: 'fox', setting: 'forest' } },
  { id: 'shooter.default', status: 'live', recipe: { move: 'stationary', actions: ['shoot'], objective: 'defeat', threats: [] }, preset: { genre: 'shooter', mode: 'default', hero: 'robot', setting: 'space' } },
  // Missing runtime/scene must never become eligible just because the intent asks for it.
  { id: 'glide.reach', status: 'staged', recipe: { move: 'glide', actions: [], objective: 'reach', threats: [] }, preset: null },
];

export const liveCells = (): readonly LiveCell[] => ALLOWED.filter((cell): cell is LiveCell => cell.status === 'live');
