import type { GenreSpec } from '../genre/contract';
import { GENRE_ACTIONS, GENRE_MOVES, type Intent } from '../intent/contract';
import { FIND_ONE } from '../genre/classify';
import { heroClass } from '../genre/roles';
import { PRESETS, type RecipeAssembly } from './presets';
import type { Recipe } from './recipe';
import type { AssemblyPart } from './parts';
import { saidAbilities, saidAbilityWords } from '../draft/controls';

export interface AssemblySource {
  id: string;
  recipe: Recipe;
  preset: GenreSpec;
  assembly: 'native';
}

/**
 * Movement the sentence itself decides, before any reading: the said one, a machine as the hero, or (P65 T6b) a race
 * with shooting and nobody named – „a racing game with guns“ drives and shoots, it does not run.
 */
export function saidMove(intent: Intent): Recipe['move'] | undefined {
  const items = intent.items.filter(item => item.essential);
  // P71D T2: let, který domýšlí jen jméno letadla („a spaceship shoots asteroids“), nepřebije střelbu na věc věty –
  // hraje střílečka. Kroužky s „Drag… to swim“ střelbu schovaly (QA 5. 11.). Pohyb řečený slovesem platí dál.
  const aims = !intent.negated.includes('shoot') && items.some(item => item.axis === 'action' && item.verb === 'shoot' && item.object !== null && (item.actor === intent.hero || item.actor === 'hero'));
  const craftOnly = (item: Intent['items'][number]): boolean =>
    aims && item.verb === 'glide' && intent.hero !== null && item.actor === intent.hero && heroClass(intent.hero) === 'aircraft' && item.said.toLowerCase().startsWith(intent.hero);
  const explicit = items.find(item => item.axis === 'move' && !craftOnly(item))?.verb as Recipe['move'] | undefined;
  if (explicit !== undefined) return explicit;
  if (intent.hero !== null && ['vehicle', 'boat'].includes(heroClass(intent.hero) ?? '')) return 'drive';
  const shoots = items.some(item => item.verb === 'shoot') && !intent.negated.includes('shoot');
  return intent.hero === null && items.some(item => item.verb === 'race') && shoots ? 'drive' : undefined;
}

/** Choose movement once; independent requested actions never select a cell. */
export function sourceFor(intent: Intent, fallback: GenreSpec): AssemblySource {
  const items = intent.items.filter(item => item.essential);
  const said = saidMove(intent);
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
  const first = action[0];
  const preferred = said === undefined && objective !== 'escape' && first !== undefined && !read.actions.includes(first) ? actionDefaults[first] : undefined;
  const selected = { ...fallback, ...preferred } as GenreSpec;
  const base = PRESETS[`${selected.genre}.${selected.mode}`]!;
  // A race keeps a movement that can race (the reading drives a cart); otherwise it runs.
  const move = said ?? (objective === 'escape' ? 'run' : objective === 'race' ? (['drive', 'glide'].includes(base.move) ? base.move : 'run') : base.move);
  // Unsaid actions: defeating on foot is fighting, whatever action the reading guessed ("destroy" is no quest);
  // a catch is a whole game, so the read genre's own action (collecting) was never asked for.
  const unsaid = objective === 'defeat' && move === 'roam' ? ['fight' as const] : move === base.move && objective !== 'catch' ? base.actions : [];
  const asked = action.length ? action : unsaid;
  // P71D T4: a quest for one found thing ("find the lost crown") plays the collect its "find" reads as.
  // Only one singular thing is a quest target ("looking for lost carrots" stays the arena), as in the classifier.
  const finds = selected.genre === 'quest' && selected.mode === 'spatial' && FIND_ONE.test(intent.sentence.toLowerCase().replace(/\s+/g, ' ').trim());
  const plays = (recipe: Recipe) => asked.every(verb => recipe.actions.includes(verb) || verb === 'collect' && finds);
  const threats = items.filter(item => item.axis === 'threat').map(item => item.verb) as Recipe['threats'];
  const defaults: Partial<Record<Recipe['move'], Pick<GenreSpec, 'genre' | 'mode'>>> = {
    run: { genre: 'runner', mode: 'default' }, jump: { genre: 'platformer', mode: 'default' },
    flap: { genre: 'flap', mode: 'default' }, drive: { genre: 'voyage', mode: 'race' },
    glide: { genre: 'voyage', mode: 'race' }, walk: { genre: 'quest', mode: 'spatial' },
    ball: { genre: 'throw', mode: 'default' },
    // Only the escape arena has someone on the field: a pursuer, guard or thing to dodge plays there.
    // Defeating targets is the arena fight even when the sentence says no fight verb ("knock out five scarecrows").
    roam: { genre: 'arena', mode: (action.includes('fight') || objective === 'defeat') && !action.some(verb => ['collect', 'deliver', 'interact'].includes(verb)) ? 'fight'
      : objective === 'survive' || objective === 'escape' || threats.some(threat => ['chaser', 'guard', 'obstacle'].includes(threat) && !intent.negated.includes(threat)) || intent.negated.includes('collect') ? 'escape' : 'collect' },
  };
  // The movement's genre replaces a reading of another genre on the same movement
  // only when that reading cannot play every requested action (a quest is no arena).
  const moved = defaults[move];
  const keepsReading = moved !== undefined && moved.genre !== selected.genre && move === base.move && plays(base);
  // An unnamed chase still needs someone to chase: the setting's default foe plays the prey, as in the `roam.catch` cell.
  const unnamedPrey = move === 'roam' && objective === 'catch' && !items.some(item => item.verb === 'catch' && item.object !== null);
  const preset = { ...selected, ...(items.some(item => item.axis !== 'unknown') && !keepsReading ? moved : {}), ...(unnamedPrey ? { cast: [{ label: 'cat', does: 'fight' }] } : {}) } as GenreSpec;
  const assembled = PRESETS[`${preset.genre}.${preset.mode}`]!;
  const recipe: Recipe = { move, actions: [...new Set(asked)].filter(verb => !intent.negated.includes(verb)),
    objective: objective ?? (move === 'ball' ? 'score' : move === 'drive' || move === 'glide' || move === 'walk' ? 'reach' : assembled.objective),
    threats: [...new Set(threats)].filter(verb => !intent.negated.includes(verb)) };
  return { id: `assembled.${move}`, recipe, preset, assembly: 'native' };
}

/**
 * Recipe of a P54C genre that is a whole game on its own: its pieces are its rules. A genre movement (`lanes`, `hop`,
 * `crowd`, `drop`) or a genre action on an ordinary movement (P54C T13b: `push` rolls in the ring on `roam`) –
 * the intent reads neither, so no other recipe carries them.
 */
export const wholeGame = (recipe: Pick<Recipe, 'move' | 'actions'>): boolean =>
  (GENRE_MOVES as readonly string[]).includes(recipe.move) || recipe.actions.some(action => (GENRE_ACTIONS as readonly string[]).includes(action));

/**
 * The P54C genre the classifier put first (P54C T13: its verb was heard – „catches falling apples“,
 * „slice flying watermelons“) plays its own live recipe; the movement or action the intent reads
 * elsewhere in the sentence („flying“ is a glide, „whack“ an interaction) does not recast it.
 * `null` for every other genre – those keep `sourceFor`.
 */
export function genreSource(fallback: GenreSpec): AssemblySource | null {
  const recipe = PRESETS[`${fallback.genre}.${fallback.mode}`];
  return recipe === undefined || !wholeGame(recipe) ? null : { id: `assembled.${recipe.move}`, recipe, preset: fallback, assembly: 'native' };
}

/** Actions a movement plays itself (`compileAssembly`, track addons, the arena's pickups). */
const MOVE_ACTIONS: Partial<Record<Recipe['move'], readonly string[]>> = {
  run: ['shoot', 'collect'], jump: ['shoot', 'collect'], drive: ['shoot', 'collect'],
  glide: ['shoot', 'collect'], walk: ['collect'], roam: ['collect'], ball: ['kick', 'throw'],
};
/** Actions an attachable part plays on any movement. */
const PART_ACTIONS = ['fight', 'duel', 'deliver', 'interact'];

/** Requested actions a source plays neither itself nor through an attachable part. */
function unplayedActions(source: AssemblySource): string[] {
  const own = [...(MOVE_ACTIONS[source.recipe.move] ?? []), ...PRESETS[`${source.preset.genre}.${source.preset.mode}`]!.actions];
  return source.recipe.actions.filter(verb => !own.includes(verb) && !PART_ACTIONS.includes(verb));
}

export const unplayed = (source: AssemblySource): number => unplayedActions(source).length;

/**
 * Names belong to parts, not to whichever genre happened to provide scenery.
 * The content still lists every named thing – it is the quick version's
 * GenreSpec the director and the fidelity check read; `compileAssembly` drops
 * the names its parts play from the base genre.
 */
export function assemble(intent: Intent, source: AssemblySource, content: GenreSpec): RecipeAssembly {
  // P54C T13: a lanes genre takes no parts, rule template or hero buttons – a hazard part would drop a second bomb
  // into the lanes, and its generators take no abilities (`ABILITY_GENERATORS`).
  if (wholeGame(source.recipe)) return { ...source.recipe, preset: 'assembled', content };
  const parts: (AssemblyPart & { label: string })[] = [];
  const phaseAt = intent.sentence.toLowerCase().search(/\band then\b|\bthen\b/);
  // P63 T2: a roam cell with no threat and no fight (the arena collect a reading decided) has nobody on the field, so
  // the pursuer, guard or obstacle the sentence names comes as the hazard part the bot proves there (sharks, ghosts);
  // left in the cast, the arena collect drops it.
  const foeless = source.recipe.move === 'roam' && source.recipe.threats.length === 0 && !source.recipe.actions.includes('fight');
  for (const item of intent.items) {
    if (!item.essential) continue;
    const kind = (foeless && ['chaser', 'guard', 'obstacle'].includes(item.verb) ? 'hazard' : item.verb) as AssemblyPart['kind'];
    if (!['catch', 'rival', 'hazard', 'chaser', 'fight', 'duel', 'deliver', 'interact', 'escape'].includes(kind)) continue;
    if (kind === 'escape' && (item.object === null || intent.items.some(other => other.axis === 'threat' && other.actor === item.object))) continue;
    // Mechanics already implemented by the movement keep their native rules.
    const native = kind === 'catch' && source.recipe.move === 'roam' && source.recipe.objective === 'catch' && source.recipe.actions.length === 0 && source.recipe.threats.length === 0 ||
      kind === 'rival' && (source.recipe.move === 'ball' || ['drive', 'glide'].includes(source.recipe.move) && source.recipe.objective === 'race') ||
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
  // The sentence goes with the recipe: `compileRecipe` picks its rule template by it (P45B T9).
  const words = intent.sentence.toLowerCase().match(/[a-z]+/g) ?? [];
  // Akce hrdiny (P46A T8) jdou s receptem i bez šablony – recept bez šablony `intent` nenese.
  const abilities = saidAbilities(intent.sentence.toLowerCase(), intent);
  // Sloveso věty pro tlačítko (P47B T10): i pro akci, kterou dodá až režisér.
  const saidWords = saidAbilityWords(intent.sentence.toLowerCase(), intent);
  return {
    ...source.recipe, preset: 'assembled', content, parts, intent: { words, unplayed: unplayedActions(source) },
    ...(abilities.length === 0 ? {} : { abilities }), ...(Object.keys(saidWords).length === 0 ? {} : { saidWords }),
  };
}
