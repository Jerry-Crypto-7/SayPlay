import { arcadeWorldOf } from '../arcade/compile';
import { verifyArcade } from '../arcade/verify';
import { matchesWitness, type ActionWitness } from '../arcade/witness';
import { draftChoiceOrder, draftGenreFor } from '../draft/draft';
import { nounPhrase, singular } from '../draft/lexicon';
import { classifyGenre } from '../genre/classify';
import type { CastItem, GenreSpec } from '../genre/contract';
import { defaultCollectible, defaultFoe, heroClass } from '../genre/roles';
import { essentialTriples, type Intent, type IntentTriple } from '../intent/contract';
import type { GameSpecV1 } from '../spec';
import type { Reading } from '../read/schema';
import { assemblyOfCell, liveCells, type LiveCell } from './allowed';
import { compileRecipe } from './compile';
import { type RecipeAssembly } from './presets';

export interface Composition {
  readonly cellId: string;
  readonly recipe: RecipeAssembly;
  readonly spec: GameSpecV1;
  readonly unmet: readonly IntentTriple[];
  readonly witnesses: readonly ActionWitness[];
  readonly issues: readonly string[];
}

// Repeated publication of the same sentence must not replay identical worlds
// on every request. Bounded and keyed by every input; callers get owned copies.
const compositions = new Map<string, Composition>();

/** Lexicographic preference: movement, objective, action, threat, old tie order. */
function distance(intent: Intent, cell: LiveCell): number[] {
  const inferredDrive = !intent.items.some(item => item.essential && item.axis === 'move') &&
    intent.hero !== null && ['vehicle', 'boat'].includes(heroClass(intent.hero) ?? '');
  const supported = {
    move: [cell.recipe.move], objective: [cell.recipe.objective],
    action: cell.recipe.actions, threat: cell.recipe.threats,
  };
  return ['move', 'objective', 'action', 'threat'].map(axis => axis === 'move' && inferredDrive ? Number(cell.recipe.move !== 'drive') : intent.items.filter(item =>
    item.essential && item.axis === axis && !(supported[axis as keyof typeof supported] as readonly string[]).includes(item.verb)).length);
}

function contentOf(intent: Intent, cell: LiveCell, reading: Reading | null): GenreSpec {
  const draft = draftGenreFor(intent.sentence, cell.preset.genre, cell.preset.mode, { reading }) ?? cell.preset;
  const cast: CastItem[] = [...(draft.cast ?? [])];
  const spoken: string[] = [];
  const sentenceHeads = (intent.sentence.toLowerCase().match(/[a-z][a-z-]*/g) ?? []).map(singular);
  const head = (label: string): string => singular(label.toLowerCase()).split(' ').at(-1) ?? label;
  for (const fallback of cell.preset.cast ?? []) {
    const roles = draft.genre === 'arena' && fallback.does === 'chase_me'
      ? ['chase_me', 'avoid', 'fight', 'shoot_at', 'throw_at'] : [fallback.does];
    if (!cast.some(item => roles.includes(item.does))) cast.push({ ...fallback, label: fallback.does === 'collect' ? defaultCollectible(draft.setting) : ['chase_me', 'avoid', 'fight', 'shoot_at', 'throw_at'].includes(fallback.does) ? defaultFoe(draft.setting, draft.genre).label : fallback.label });
  }
  const put = (label: string, does: CastItem['does']): void => {
    if (label === 'hero' || label === intent.hero) return;
    const index = cast.findIndex(item => head(item.label) === head(label));
    if (index < 0) cast.push({ label, does });
    else cast[index] = { ...cast[index], does };
    spoken.push(index < 0 ? label : cast[index].label);
  };
  for (const item of intent.items) {
    if (!item.essential) continue;
    if (item.axis === 'threat') {
      // Implied traffic/watchers express a requirement, not a named character.
      // Keep the setting's existing cast; unmatched identities stay unmet.
      if (!sentenceHeads.includes(head(item.actor))) continue;
      if (item.verb === 'chaser' || item.verb === 'guard') put(item.actor, 'chase_me');
      else put(item.actor, 'avoid');
    } else if (item.object !== null && (item.actor === intent.hero || item.actor === 'hero')) {
      // The cargo remains visible as a destination when this recipe cannot
      // carry it. That never certifies delivery: its triple still needs a witness.
      const roles: Partial<Record<string, CastItem['does']>> = { shoot: 'shoot_at', throw: 'throw_at', collect: 'collect', fight: 'fight', reach: 'reach', interact: 'reach', deliver: 'reach' };
      if (item.verb === 'throw' && item.object === 'ball' && sentenceHeads.includes('basketball')) {
        // A sports ball is the thrown object, never the thing thrown at.
        if (!cast.some(member => member.label === 'basketball')) cast.push({ label: 'basketball', does: 'scenery', verb: 'throw' });
        continue;
      }
      const does = roles[item.verb];
      if (does !== undefined) put(item.object, does);
      else if (item.axis === 'unknown' && /^(?:sweep|mop)$/.test(item.verb) && draft.genre === 'arena' && draft.mode === 'collect' && draft.heroAction === 'sweep') {
        // Retain the surface named by a cleaning request in its established
        // collection stand-in. Picking up that surface never proves cleaning.
        const at = intent.sentence.toLowerCase().indexOf(item.said);
        const phrase = at < 0 ? null : nounPhrase(intent.sentence.slice(at + item.said.length));
        put(phrase !== null && head(phrase) === item.object ? singular(phrase) : item.object, 'collect');
      }
    }
  }
  const thrown = /\bthrow(?:s|ing)? (?:a |an |the |some )?([a-z][a-z -]*)/i.exec(intent.sentence);
  const ammunition = thrown === null ? null : nounPhrase(thrown[1]);
  if (draft.genre === 'throw' && ammunition !== null && /(?:ball|snowball|basketball|rock|stone|pizza|pie)$/.test(head(ammunition))) {
    for (let index = 0; index < cast.length; index++) if (cast[index].verb === 'throw' && cast[index].does === 'scenery') cast[index] = { ...cast[index], verb: undefined };
    const label = singular(ammunition);
    const existing = cast.findIndex(item => head(item.label) === head(label));
    if (existing < 0) cast.push({ label, does: 'scenery', verb: 'throw' });
    else if (cast[existing].does === 'scenery') cast[existing] = { ...cast[existing], verb: 'throw' };
  }
  const removed = new Set(intent.negated);
  const track = draft.genre === 'runner' || draft.genre === 'platformer';
  const allowedCast = cast.filter(item =>
    !/^(?:top-down|side-scrolling|first-person|third-person|twin-stick)$/.test(item.label) &&
    !(item.does === 'shoot_at' && (removed.has('shoot') || track && !cell.recipe.actions.includes('shoot'))) &&
    !(item.does === 'chase_me' && (removed.has('chaser') || track && !cell.recipe.threats.includes('chaser'))));
  allowedCast.sort((a, b) => Number(spoken.includes(b.label)) - Number(spoken.includes(a.label)));
  const words = (intent.sentence.toLowerCase().match(/[a-z][a-z-]*/g) ?? []).map(singular);
  const namedSetting = (draft.setting.toLowerCase().match(/[a-z][a-z-]*/g) ?? []).some(word => word.length > 2 && words.includes(singular(word)));
  const setting = intent.setting !== null && !draft.setting.includes(intent.setting) && !namedSetting ? intent.setting : draft.setting;
  const draftedAt = words.indexOf(head(draft.hero));
  const intendedAt = intent.hero === null ? -1 : words.indexOf(intent.hero);
  // A later subordinate actor must not erase an earlier, explicitly named
  // protagonist. Explicit player bindings such as "as a frog" still win.
  const explicitPlayer = /\b(?:as|you are|you're|i am|i'm|you control) (?:a |an |the )?/.test(intent.sentence.toLowerCase());
  const keepNamedHero = !explicitPlayer && draftedAt >= 0 && intendedAt > draftedAt;
  const hero = intent.hero !== null && head(draft.hero) !== intent.hero && !keepNamedHero ? intent.hero : draft.hero;
  return { ...draft, hero, setting, cast: allowedCast.slice(0, 8) };
}

export function compose(intent: Intent, seed = 1, reading: Reading | null = null): Composition {
  const cacheKey = JSON.stringify([intent, seed, reading]);
  const cached = compositions.get(cacheKey);
  if (cached !== undefined) return structuredClone(cached);
  const classified = classifyGenre(intent.sentence, reading);
  // Preserve the established absurd-transfer fallback only when there is no
  // known essential mechanic to prioritize. Unknown requests remain unmet.
  const hasKnownAction = intent.items.some(item => item.essential && item.axis !== 'unknown');
  const ranking = hasKnownAction ? classified.ranked : draftChoiceOrder(intent.sentence, classified, reading);
  const order = new Map(ranking.map((choice, index) => [`${choice.genre}.${choice.mode}`, index]));
  const cells = [...liveCells()].sort((a, b) => {
    const da = distance(intent, a), db = distance(intent, b);
    for (let axis = 0; axis < da.length; axis++) if (da[axis] !== db[axis]) return da[axis] - db[axis];
    return (order.get(`${a.preset.genre}.${a.preset.mode}`) ?? 999) - (order.get(`${b.preset.genre}.${b.preset.mode}`) ?? 999);
  });
  const issues: string[] = [];
  for (const cell of cells) {
    // Explicitly forbidden mechanics must not be selected as the main action.
    if ([...cell.recipe.actions, ...cell.recipe.threats, cell.recipe.move].some(verb => intent.negated.includes(verb))) continue;
    const recipe = assemblyOfCell(cell, contentOf(intent, cell, reading));
    const spec = compileRecipe(recipe);
    const made = arcadeWorldOf(spec, seed);
    if (!made.ok) { issues.push(`${cell.id}: ${made.issues.join('; ')}`); continue; }
    const verdict = verifyArcade(made.world, undefined, made.roleBindings);
    if (verdict.bot.outcome !== 'won' || !verdict.replayEqual) { issues.push(`${cell.id}: ${verdict.failures.join('; ')}`); continue; }
    const witnesses = verdict.witnesses;
    const unmet = essentialTriples(intent).filter(triple => !witnesses.some(witness => matchesWitness(triple, witness)));
    const composition = { cellId: cell.id, recipe, spec, unmet, witnesses, issues };
    if (compositions.size >= 64) compositions.delete(compositions.keys().next().value!);
    compositions.set(cacheKey, structuredClone(composition));
    return composition;
  }
  throw new Error(`No playable live recipe: ${issues.join('; ')}`);
}
