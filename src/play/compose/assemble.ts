import type { GenreSpec } from '../genre/contract';
import type { Intent } from '../intent/contract';
import { heroClass } from '../genre/roles';
import { PRESETS, type RecipeAssembly } from './presets';
import type { Recipe } from './recipe';
import type { AssemblyPart } from './parts';
import { singular } from '../draft/lexicon';

export interface AssemblySource {
  id: string;
  recipe: Recipe;
  preset: GenreSpec;
  assembly: 'native';
}

/** Choose movement once; independent requested actions never select a cell. */
export function sourceFor(intent: Intent, fallback: GenreSpec): AssemblySource {
  const items = intent.items.filter(item => item.essential);
  const explicit = items.find(item => item.axis === 'move')?.verb as Recipe['move'] | undefined;
  const implied = intent.hero !== null && ['vehicle', 'boat'].includes(heroClass(intent.hero) ?? '') ? 'drive' : undefined;
  const objective = items.find(item => item.axis === 'objective')?.verb as Recipe['objective'] | undefined;
  const action = items.filter(item => item.axis === 'action').map(item => item.verb) as Recipe['actions'];
  const actionDefaults: Partial<Record<string, Pick<GenreSpec, 'genre' | 'mode'>>> = {
    shoot: { genre: 'shooter', mode: 'default' }, throw: { genre: 'throw', mode: 'default' },
    duel: { genre: 'duel', mode: 'default' }, fight: { genre: 'arena', mode: 'fight' },
    interact: { genre: 'quest', mode: 'station' }, stack: { genre: 'timing', mode: 'stack' },
    beat: { genre: 'rhythm', mode: 'default' },
  };
  // The sentence reading stands when its own recipe plays the requested action:
  // lighting candles in a haunted house stays the spatial quest the reading chose.
  const read = PRESETS[`${fallback.genre}.${fallback.mode}`]!;
  const plays = (recipe: Recipe) => action.every(verb => recipe.actions.includes(verb));
  const first = action[0];
  const preferred = explicit === undefined && implied === undefined && objective !== 'escape' && first !== undefined && !read.actions.includes(first) ? actionDefaults[first] : undefined;
  const selected = { ...fallback, ...preferred } as GenreSpec;
  const base = PRESETS[`${selected.genre}.${selected.mode}`]!;
  // A race keeps a movement that can race (the reading drives a cart); otherwise it runs.
  const move = explicit ?? implied ?? (objective === 'escape' ? 'run' : objective === 'race' ? (['drive', 'glide'].includes(base.move) ? base.move : 'run') : base.move);
  const threats = items.filter(item => item.axis === 'threat').map(item => item.verb) as Recipe['threats'];
  const defaults: Partial<Record<Recipe['move'], Pick<GenreSpec, 'genre' | 'mode'>>> = {
    run: { genre: 'runner', mode: 'default' }, jump: { genre: 'platformer', mode: 'default' },
    flap: { genre: 'flap', mode: 'default' }, drive: { genre: 'voyage', mode: 'race' },
    glide: { genre: 'voyage', mode: 'race' }, walk: { genre: 'quest', mode: 'spatial' },
    ball: { genre: 'throw', mode: 'default' },
    // Only the escape arena has someone on the field: a pursuer, guard or thing to dodge plays there.
    roam: { genre: 'arena', mode: action.includes('fight') && !action.some(verb => ['collect', 'deliver', 'interact'].includes(verb)) ? 'fight'
      : objective === 'survive' || objective === 'escape' || threats.some(threat => ['chaser', 'guard', 'obstacle'].includes(threat) && !intent.negated.includes(threat)) || intent.negated.includes('collect') ? 'escape' : 'collect' },
  };
  // The movement's genre replaces a reading of another genre on the same movement
  // only when that reading cannot play every requested action (a quest is no arena).
  const moved = defaults[move];
  const keepsReading = moved !== undefined && moved.genre !== selected.genre && move === base.move && plays(base);
  const preset = { ...selected, ...(items.some(item => item.axis !== 'unknown') && !keepsReading ? moved : {}) } as GenreSpec;
  const assembled = PRESETS[`${preset.genre}.${preset.mode}`]!;
  const recipe: Recipe = { move, actions: [...new Set(action.length ? action : move === base.move ? base.actions : [])].filter(verb => !intent.negated.includes(verb)),
    objective: objective ?? (move === 'ball' ? 'score' : move === 'drive' || move === 'glide' || move === 'walk' ? 'reach' : assembled.objective),
    threats: [...new Set(threats)].filter(verb => !intent.negated.includes(verb)) };
  return { id: `assembled.${move}`, recipe, preset, assembly: 'native' };
}

/** Names belong to parts, not to whichever genre happened to provide scenery. */
export function assemble(intent: Intent, source: AssemblySource, content: GenreSpec): RecipeAssembly {
  const parts: (AssemblyPart & { label: string })[] = [];
  const phaseAt = intent.sentence.toLowerCase().search(/\band then\b|\bthen\b/);
  for (const item of intent.items) {
    if (!item.essential) continue;
    const kind = item.verb as AssemblyPart['kind'];
    if (!['catch', 'rival', 'hazard', 'chaser', 'fight', 'duel', 'deliver', 'interact', 'escape'].includes(kind)) continue;
    if (kind === 'escape' && (item.object === null || intent.items.some(other => other.axis === 'threat' && other.actor === item.object))) continue;
    // Mechanics already implemented by the movement keep their native rules.
    const native = kind === 'rival' && (source.recipe.move === 'ball' || ['drive', 'glide'].includes(source.recipe.move) && source.recipe.objective === 'race') ||
      kind === 'chaser' && (['run', 'jump', 'drive', 'walk', 'roam'].includes(source.recipe.move) || source.recipe.move === 'glide' && source.recipe.objective === 'escape') ||
      kind === 'fight' && source.recipe.move === 'roam' && source.preset.mode === 'fight' ||
      kind === 'duel' && source.recipe.move === 'stationary' && source.preset.genre === 'duel' ||
      kind === 'interact' && source.preset.genre === 'quest' && ['stationary', 'roam'].includes(source.recipe.move) ||
      kind === 'deliver' && source.recipe.move === 'drive' && source.recipe.actions.length === 1 && source.recipe.threats.length === 0;
    if (native && phaseAt < 0) continue;
    const label = item.axis === 'threat' ? item.actor : item.object;
    if (label === null) continue;
    if (parts.some(part => part.kind === kind && part.label === label)) continue;
    const at = intent.sentence.toLowerCase().indexOf(item.said.toLowerCase(), Math.max(0, phaseAt));
    parts.push({ kind, label, role: `part_${parts.length}`, phase: phaseAt >= 0 && at > phaseAt ? 1 : 0,
      motion: /\b(?:laser|arrow|missile|bullet)/i.test(label) ? 'fly' : 'fall' });
  }
  const head = (label: string) => singular(label.toLowerCase()).split(' ').at(-1);
  const cast = content.cast?.filter(member => member.does === 'scenery' && member.verb === 'shoot' || !parts.some(part => head(part.label) === head(member.label)));
  return { ...source.recipe, preset: 'assembled', content: { ...content, cast }, parts };
}
