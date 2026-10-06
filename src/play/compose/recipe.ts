import { z } from 'zod';
import { ACTIONS, MOVES, OBJECTIVES, THREATS } from '../intent/contract';

const unique = <T>(items: T[]) => new Set(items).size === items.length;
/** Stationary controls (aim, throw, rhythm…) have actions but no travel. */
export const recipeSchema = z.object({
  move: z.enum(['stationary', ...MOVES]),
  actions: z.array(z.enum(ACTIONS)).max(ACTIONS.length).refine(unique, 'Duplicate action'),
  objective: z.enum(OBJECTIVES),
  threats: z.array(z.enum(THREATS)).max(THREATS.length).refine(unique, 'Duplicate threat'),
}).strict();
export type Recipe = z.infer<typeof recipeSchema>;

/** Stable key; ordering of independent pieces cannot create a second cell. */
export const recipeKey = (recipe: Recipe): string => [recipe.move, [...recipe.actions].sort().join('+'), recipe.objective, [...recipe.threats].sort().join('+')].join('/');
