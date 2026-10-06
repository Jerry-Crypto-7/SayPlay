import type { CastRole, GenreSpec } from '../genre/contract';
import type { GameRole, GameSpecV1 } from '../spec';
import { recipeSchema, type Recipe } from './recipe';
import { withAuthoredContent } from './content';
import { expandTemplate } from '../arcade/rules/templates';

/** New driving compositions use the native track, never the frozen voyage course. */
export function driveSpec(recipe: Recipe, content: GenreSpec): GameSpecV1 {
  recipeSchema.parse(recipe);
  if (recipe.move !== 'drive' || !['race', 'reach', 'escape'].includes(recipe.objective) ||
      recipe.actions.some(action => !['shoot', 'deliver', 'collect'].includes(action)) ||
      recipe.actions.includes('deliver') && (recipe.objective !== 'reach' || recipe.actions.length !== 1 || recipe.threats.length !== 0) ||
      recipe.threats.some(threat => !['rival', 'chaser', 'obstacle'].includes(threat)) ||
      recipe.threats.includes('rival') && recipe.objective !== 'race') {
    throw new Error('Unsupported driving recipe');
  }
  const label = (role: CastRole, fallback: string): string => content.cast?.find(item => item.does === role)?.label ?? fallback;
  const race = recipe.objective === 'race';
  const chase = recipe.objective === 'escape' || recipe.threats.includes('chaser');
  const shoot = recipe.actions.includes('shoot');
  const collect = recipe.actions.includes('collect');
  const delivery = recipe.actions.includes('deliver');
  const cargo = label('reach', label('collect', 'parcel'));
  const destination = delivery ? 'delivery point' : label('reach', 'finish line');
  const roles: GameRole[] = [
    { id: 'player', kind: 'player', label: content.hero, count: 1 },
    { id: 'barrier', kind: 'hazard', label: label('avoid', 'tire barrier'), count: 1 },
    { id: 'turbo', kind: 'collectible', label: collect ? label('collect', 'crystal') : 'turbo', count: 1 },
    { id: 'finish', kind: 'exit', label: destination, count: 1 },
  ];
  if (race) roles.push({ id: 'rival', kind: 'patrol', label: label('fight', 'rival car'), count: 3 });
  if (shoot) roles.push({ id: 'enemy', kind: 'hazard', label: label('shoot_at', 'target'), count: 1 });
  if (chase) roles.push({ id: 'chaser', kind: 'chaser', label: label('chase_me', 'police car'), count: 1 });
  if (delivery) roles.push({ id: 'cargo', kind: 'item', label: cargo, count: 1 });
  const goal = delivery ? `Pick up the ${cargo} and carry it to the delivery point.` : race ? 'Beat the rival vehicles to the finish.' : chase ? 'Reach the finish without being caught.' : `Reach the ${destination}.`;
  const params = content.params ?? {};
  const game = withAuthoredContent({
    schema: 'gamespec.v1',
    control: 'steer',
    controlParams: {
      difficulty: 'normal',
      ...(delivery ? { delivery: true } : {}),
      ...(collect ? { centerCollectibles: true } : {}),
      ...(params.roadWidth === undefined ? {} : { roadWidth: params.roadWidth }),
      ...(params.roadEntryWidth === undefined ? {} : { roadEntryWidth: params.roadEntryWidth }),
      ...(params.crashBudget === undefined ? {} : { crashBudget: params.crashBudget }),
      lengthM: Math.max(200, Math.min(800, params.lengthM ?? 450)),
      rivals: race,
      turbo: collect || params.turbo !== 0,
      drift: params.drift === 1,
    },
    title: `${content.hero} ${race ? 'race' : chase ? 'escape' : 'drive'}`,
    archetype: 'hazard_crossing',
    targetDurationSec: 60,
    theme: { setting: content.setting, mood: 'fast', ...(content.palette === undefined ? {} : { look: content.palette }) },
    // The low-level goal is finish contact. Rivals can win first; the pursuer
    // can catch the player. Neither recipe is certified by this label alone.
    objective: { kind: 'reach', description: goal, role: 'finish' },
    mechanics: [],
    roles,
    addons: [...(shoot ? ['shoot' as const] : []), ...(chase ? ['chaser' as const] : [])],
    tutorial: { goalLine: goal, controlsHint: params.crashBudget === undefined ? (shoot ? 'Drag or arrows steer. Second finger or Space shoots. Down/S brakes.' : 'Drag or arrows to steer. Down or a second finger brakes.') : (shoot ? 'Drag/arrows steer. Second finger/Space fires. Down/S brakes. Avoid barriers.' : 'Drag/arrows steer. Down or second finger brakes. Avoid barriers.') },
    verification: [{ id: 'winnable', kind: 'reachability', assert: { runState: 'won' } }],
    budgets: { maxEntities: 40, maxRules: 120, maxTriangles: 200000 },
  }, content);
  if (!delivery) return game;
  const rules = expandTemplate('carry', { item: 'cargo', goal: 'finish' })!.map(rule => ({ ...rule, id: `p41_${rule.id}` }));
  return { ...game, rules: [...rules, ...(game.rules ?? [])] };
}
