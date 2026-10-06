import { arcadeWorldOf } from '../arcade/compile';
import { verifyArcade } from '../arcade/verify';
import { matchesWitness, type ActionWitness } from '../arcade/witness';
import { draftGenreFor } from '../draft/draft';
import { classifyGenre } from '../genre/classify';
import type { CastItem, GenreSpec } from '../genre/contract';
import { essentialTriples, type Intent, type IntentTriple } from '../intent/contract';
import type { GameSpecV1 } from '../spec';
import { liveCells, type LiveCell } from './allowed';
import { compileRecipe } from './compile';
import { presetOf, type RecipeAssembly } from './presets';

export interface Composition {
  readonly cellId: string;
  readonly recipe: RecipeAssembly;
  readonly spec: GameSpecV1;
  readonly unmet: readonly IntentTriple[];
  readonly witnesses: readonly ActionWitness[];
  readonly issues: readonly string[];
}

/** Lexicographic preference: movement, objective, action, threat, old tie order. */
function distance(intent: Intent, cell: LiveCell): number[] {
  const supported = {
    move: [cell.recipe.move], objective: [cell.recipe.objective],
    action: cell.recipe.actions, threat: cell.recipe.threats,
  };
  return ['move', 'objective', 'action', 'threat'].map(axis => intent.items.filter(item =>
    item.essential && item.axis === axis && !(supported[axis as keyof typeof supported] as readonly string[]).includes(item.verb)).length);
}

function contentOf(intent: Intent, cell: LiveCell): GenreSpec {
  const draft = draftGenreFor(intent.sentence, cell.preset.genre, cell.preset.mode) ?? cell.preset;
  const cast: CastItem[] = [...(draft.cast ?? [])];
  const put = (label: string, does: CastItem['does']): void => {
    if (label === 'hero' || label === intent.hero) return;
    const index = cast.findIndex(item => item.label === label);
    if (index < 0) cast.push({ label, does });
    else cast[index] = { ...cast[index], does };
  };
  for (const item of intent.items) {
    if (!item.essential) continue;
    if (item.axis === 'threat') {
      if (item.verb === 'chaser' || item.verb === 'guard') put(item.actor, 'chase_me');
      else put(item.actor, 'avoid');
    } else if (item.object !== null && (item.actor === intent.hero || item.actor === 'hero')) {
      const roles: Partial<Record<string, CastItem['does']>> = { shoot: 'shoot_at', throw: 'throw_at', collect: 'collect', fight: 'fight', reach: 'reach', interact: 'reach' };
      const does = roles[item.verb];
      if (does !== undefined) put(item.object, does);
    }
  }
  const removed = new Set(intent.negated);
  const track = draft.genre === 'runner' || draft.genre === 'platformer';
  const allowedCast = cast.filter(item =>
    !(item.does === 'shoot_at' && (removed.has('shoot') || track && !cell.recipe.actions.includes('shoot'))) &&
    !(item.does === 'chase_me' && (removed.has('chaser') || track && !cell.recipe.threats.includes('chaser'))));
  return { ...draft, ...(intent.hero === null ? {} : { hero: intent.hero }), cast: allowedCast.slice(0, 8) };
}

export function compose(intent: Intent, seed = 1): Composition {
  const ranking = classifyGenre(intent.sentence, null).ranked;
  const order = new Map(ranking.map((choice, index) => [`${choice.genre}.${choice.mode}`, index]));
  const cells = [...liveCells()].sort((a, b) => {
    const da = distance(intent, a), db = distance(intent, b);
    for (let axis = 0; axis < da.length; axis++) if (da[axis] !== db[axis]) return da[axis] - db[axis];
    return (order.get(a.id) ?? 999) - (order.get(b.id) ?? 999);
  });
  const issues: string[] = [];
  for (const cell of cells) {
    // Explicitly forbidden mechanics must not be selected as the main action.
    if ([...cell.recipe.actions, ...cell.recipe.threats, cell.recipe.move].some(verb => intent.negated.includes(verb))) continue;
    const recipe = presetOf(contentOf(intent, cell));
    const spec = compileRecipe(recipe);
    const made = arcadeWorldOf(spec, seed);
    if (!made.ok) { issues.push(`${cell.id}: ${made.issues.join('; ')}`); continue; }
    const verdict = verifyArcade(made.world, undefined, made.roleBindings);
    if (verdict.bot.outcome !== 'won' || !verdict.replayEqual) { issues.push(`${cell.id}: ${verdict.failures.join('; ')}`); continue; }
    const witnesses = verdict.witnesses;
    const unmet = essentialTriples(intent).filter(triple => !witnesses.some(witness => matchesWitness(triple, witness)));
    return { cellId: cell.id, recipe, spec, unmet, witnesses, issues };
  }
  throw new Error(`No playable live recipe: ${issues.join('; ')}`);
}
