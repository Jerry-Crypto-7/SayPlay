import type { GenreSpec } from '../genre/contract';
import type { GameSpecV1 } from '../spec';
import type { Recipe } from './recipe';

/** Reference prey pace and field the catch game is calibrated for (the `roam.catch` cell). */
export const CATCH_TUNING: Readonly<Record<string, number>> = { half: 40000, preySpeed: 250, seconds: 11 };

export function catchSpec(recipe: Recipe, content: GenreSpec): GameSpecV1 {
  if (recipe.move !== 'roam' || recipe.objective !== 'catch' || recipe.actions.length || recipe.threats.length) throw new Error('Unsupported catch recipe');
  const prey = content.cast?.find(item => item.does === 'fight')?.label;
  if (prey === undefined) throw new Error('Catch requires an explicit prey identity');
  const goal = `Catch the moving ${prey} before time runs out.`;
  return {
    schema: 'gamespec.v1', control: 'move_free', controlParams: { generator: 'arena_catch', tuning: {
      ...(content.params?.preySpeed === undefined ? {} : { preySpeed: content.params.preySpeed }),
      ...(content.params?.half === undefined ? {} : { half: content.params.half }),
      ...(content.params?.seconds === undefined ? {} : { catchSeconds: content.params.seconds }),
    } },
    title: `${content.hero} chases ${prey}`, archetype: 'combat_lite', targetDurationSec: 30,
    theme: { setting: content.setting, mood: 'adventurous', ...(content.palette === undefined ? {} : { look: content.palette }) },
    objective: { kind: 'defeat_targets', description: goal, role: 'prey', count: 1 },
    roles: [{ id: 'player', kind: 'player', label: content.hero, count: 1 }, { id: 'prey', kind: 'target', label: prey, count: 1 }],
    mechanics: [], addons: [], tutorial: { goalLine: goal, controlsHint: 'Move with arrows or WASD, or drag to chase.' },
    verification: [{ id: 'winnable', kind: 'reachability', assert: { runState: 'won' } }],
    budgets: { maxEntities: 64, maxRules: 120, maxTriangles: 200000 },
  };
}
