import type { CastRole, GenreSpec } from '../genre/contract';
import type { GameRole, GameSpecV1 } from '../spec';
import { UNIT } from '../arcade/contract';
import { GLIDE_FINALE, glideRingZs } from '../arcade/pieces/glide';
import { recipeSchema, type Recipe } from './recipe';
import { withAuthoredContent } from './content';

const bounded = (value: number | undefined, fallback: number, min: number, max: number) => Math.max(min, Math.min(max, Math.round(value ?? fallback)));
const role = (id: string, kind: GameRole['kind'], label: string, count = 1): GameRole => ({ id, kind, label, count });

/**
 * Pure content-to-spec assembly. Native runtime registration is a separate gate.
 * `paced`: a new glide, walker or ball game carries the new-game mark `segments` (P51 T3, T4 – pacing and a
 * finale, `GENRE_PACING`); a game with P42 parts does not, so its course stays as it was (the drive pattern).
 */
export function nativeSpec(recipe: Recipe, content: GenreSpec, paced = true): GameSpecV1 {
  recipeSchema.parse(recipe);
  const label = (does: CastRole, fallback: string): string => content.cast?.find(item => item.does === does)?.label ?? fallback;
  const params = content.params ?? {};
  const roles: GameRole[] = [role('player', 'player', content.hero)];
  const base = (control: 'glide' | 'walker' | 'ball', controlParams: GameSpecV1['controlParams'], goal: string, hint: string, objective: GameSpecV1['objective'], addons: GameSpecV1['addons'] = []): GameSpecV1 => withAuthoredContent({
    schema: 'gamespec.v1', control, controlParams,
    title: `${content.hero} ${recipe.objective}`,
    archetype: objective.kind === 'collect' ? 'collect_exit' : objective.kind === 'defeat_targets' ? 'combat_lite' : 'hazard_crossing', targetDurationSec: 60,
    theme: { setting: content.setting, mood: 'adventurous', ...(content.palette === undefined ? {} : { look: content.palette }) },
    objective, roles, mechanics: control === 'walker' ? [{ id: 'health', params: { max: bounded(params.lives, 3, 1, 9) } }] : [], addons,
    tutorial: { goalLine: goal, controlsHint: hint },
    verification: [{ id: 'winnable', kind: 'reachability', assert: { runState: 'won' } }],
    budgets: { maxEntities: 64, maxRules: 120, maxTriangles: 200000 },
  }, content);
  const unsupported = (): never => { throw new Error(`Unsupported native recipe: ${recipe.move}/${recipe.objective}`); };

  if (recipe.move === 'glide') {
    if (!['reach', 'collect', 'race', 'escape'].includes(recipe.objective) || recipe.actions.some(action => !['shoot', 'collect'].includes(action)) ||
      recipe.threats.some(threat => !['rival', 'chaser', 'obstacle'].includes(threat)) ||
      recipe.threats.includes('rival') && recipe.objective !== 'race' || recipe.threats.includes('chaser') && recipe.objective !== 'escape') return unsupported();
    const shoot = recipe.actions.includes('shoot');
    const lengthM = bounded(params.lengthM, paced ? GLIDE_FINALE.lengthM : 160, 80, 400);
    const topSpeed = bounded(params.topSpeed, 180, 120, 240);
    const rings = glideRingZs(lengthM * UNIT, paced, topSpeed).length;
    roles.push(role('glide_ring', 'collectible', label('collect', 'ring'), rings), role('glide_reef', 'hazard', label('avoid', 'reef')),
      role('glide_current', 'zone', 'current'), role('finish', 'exit', label('reach', 'finish')));
    if (recipe.objective === 'race') roles.push(role('glide_rival', 'patrol', label('fight', 'rival')));
    if (recipe.objective === 'escape') roles.push(role('glide_pursuer', 'chaser', label('chase_me', 'shark')));
    if (shoot) roles.push(role('enemy', 'hazard', label('shoot_at', 'target')));
    const goal = recipe.objective === 'race' ? 'Pass every ring and finish before your rival.' : recipe.objective === 'escape' ? 'Pass every ring and reach the finish without being caught.' : 'Pass every ring and reach the finish.';
    return base('glide', { generator: 'glide_course', mode: recipe.objective as 'reach' | 'collect' | 'race' | 'escape', ...(params.clearancePermille === undefined ? {} : { clearancePermille: params.clearancePermille }), ...(params.clearanceRisePermille === undefined ? {} : { clearanceRisePermille: params.clearanceRisePermille }), difficulty: 'normal', lengthM, topSpeed, ...(paced ? { segments: true } : {}) }, goal,
      shoot ? 'Drag in two directions to swim. Second finger or Space fires. Shift brakes.' : 'Drag in two directions, or use arrows to swim. Shift or a second finger brakes.',
      recipe.objective === 'collect' ? { kind: 'collect', description: goal, role: 'glide_ring', count: rings } : { kind: 'reach', description: goal, role: 'finish' }, shoot ? ['shoot'] : []);
  }

  if (recipe.move === 'walk') {
    const guard = recipe.threats.includes('guard');
    const chaser = recipe.threats.includes('chaser') || recipe.objective === 'escape' && !guard;
    if (!['reach', 'collect', 'escape'].includes(recipe.objective) || recipe.actions.some(action => action !== 'collect') ||
      recipe.threats.some(threat => !['guard', 'chaser', 'obstacle'].includes(threat)) || guard && chaser) return unsupported();
    const collect = recipe.objective === 'collect' || recipe.actions.includes('collect');
    if (guard && recipe.objective === 'escape' && !collect) return unsupported();
    const size = bounded(params.size, 11, 7, 15) | 1;
    roles.push(role('wall', 'hazard', label('avoid', 'wall')), role('finish', 'exit', label('reach', 'exit')));
    if (guard) roles.push(role('guard', 'patrol', label('chase_me', 'guard')));
    if (chaser) roles.push(role('chaser', 'chaser', label('chase_me', 'pursuer')));
    if (collect) roles.push(role('coin', 'collectible', label('collect', 'coin')));
    const item = label('collect', 'coin');
    const goal = collect ? `Collect the ${item} and reach the exit.` : chaser ? 'Reach the exit without being caught.' : guard ? 'Sneak past the guard and reach the exit.' : 'Find a path through the maze to the exit.';
    return base('walker', { generator: guard ? 'walker_stealth' : chaser ? 'walker_escape' : 'walker_labyrinth', size, ...(params.corridorRisePermille === undefined ? {} : { corridorRisePermille: params.corridorRisePermille }), ...(params.paceBudgetPct === undefined ? {} : { paceBudgetPct: params.paceBudgetPct }), speed: bounded(params.speed, 110, 80, 160), ...(collect ? { collect: true } : {}), ...(paced ? { segments: true } : {}) }, goal,
      'Drag in any direction, or use arrows or WASD to walk.',
      collect ? { kind: 'collect', description: goal, role: 'coin', count: 1 } : { kind: 'reach', description: goal, role: 'finish' });
  }

  if (recipe.move === 'ball') {
    if (!['score', 'defeat'].includes(recipe.objective) || recipe.actions.length > 1 || recipe.actions.some(action => !['kick', 'throw'].includes(action)) || recipe.threats.some(threat => threat !== 'rival')) return unsupported();
    const words = [content.hero, content.setting, ...(content.cast ?? []).map(item => item.label)].join(' ').toLowerCase();
    const goal = recipe.objective === 'defeat' ? 'goal' : /\b(?:hoop|basket|basketball)\b/.test(words) ? 'hoop' : /\b(?:golf|hole|putt)\b/.test(words) ? 'hole' : 'goal';
    const keeper = recipe.threats.includes('rival');
    const targets = bounded(content.counts?.target ?? params.targets, 1, 1, 5);
    const ball = label('scenery', goal === 'hoop' ? 'basketball' : goal === 'hole' ? 'golf ball' : 'football');
    const targetKind = recipe.objective === 'defeat' ? 'pin' : goal;
    const target = label('throw_at', label('reach', targetKind));
    roles.push(role('physics_ball', 'item', ball), role(targetKind, 'target', target, targets));
    if (keeper) roles.push(role('goalkeeper', 'patrol', label('fight', label('avoid', 'goalkeeper'))));
    const description = recipe.objective === 'defeat' ? 'Knock down every pin with the ball.' : goal === 'hoop' ? 'Score in every hoop.' : goal === 'hole' ? 'Putt the ball into every hole.' : 'Score in every goal.';
    const pace = { ...(params.shotRecoveryTicks === undefined ? {} : { shotRecoveryTicks: params.shotRecoveryTicks }), ...(params.shotRecoveryRiseTicks === undefined ? {} : { shotRecoveryRiseTicks: params.shotRecoveryRiseTicks }), ...(params.paceSeconds === undefined ? {} : { paceSeconds: params.paceSeconds }) };
    return base('ball', { generator: 'ball_pitch', goal, keeper, difficulty: 'normal', targets, ...pace, ...(recipe.objective === 'defeat' ? { knockdown: true } : {}), ...(paced ? { segments: true } : {}) }, description,
      'Drag to aim. Hold and release to shoot; the yellow dial shows when you can fire.', { kind: 'defeat_targets', description, role: targetKind, count: targets });
  }
  return unsupported();
}
