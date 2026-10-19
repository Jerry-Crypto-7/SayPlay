import { z } from 'zod';
import { phasesSchema, dependsOnSchema } from './progression';
import { ACTIONS, GENRE_ACTIONS, GENRE_MOVES, GENRE_OBJECTIVES, MOVES, OBJECTIVES, THREATS } from '../intent/contract';

const unique = <T>(items: T[]) => new Set(items).size === items.length;
/** Stationary controls (aim, throw, rhythm…) have actions but no travel. */
export const recipeSchema = z.object({
  phases: phasesSchema.optional(),
  dependsOn: dependsOnSchema.optional(),
  move: z.enum(['stationary', ...MOVES, ...GENRE_MOVES]),
  actions: z.array(z.enum([...ACTIONS, ...GENRE_ACTIONS])).max(ACTIONS.length + GENRE_ACTIONS.length).refine(unique, 'Duplicate action'),
  // Interaction courses finish the sequence of target states; they need no
  // artificial score or finish line to describe their existing objective.
  objective: z.enum([...OBJECTIVES, 'interact', ...GENRE_OBJECTIVES]),
  threats: z.array(z.enum(THREATS)).max(THREATS.length).refine(unique, 'Duplicate threat'),
}).strict();
export type Recipe = z.infer<typeof recipeSchema>;

/** Stable key; ordering of independent pieces cannot create a second cell. */
export const recipeKey = (recipe: Recipe): string => [recipe.move, [...recipe.actions].sort().join('+'), recipe.objective, [...recipe.threats].sort().join('+')].join('/');
