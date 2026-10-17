import { ARCADE_HZ, ARCADE_LIMITS, type AbilityId, type AddonId } from '../arcade/contract';
import { CAPABILITIES } from '../capabilities';
import type { GameSpecV1 } from '../spec';
import { type CastRole, FOE_DOES, type GenreModule, type GenreSpec, type ParamBounds, withCounts } from '../genre/contract';
import { GENRE_MODULES } from '../genre/modules';
import { DRIVE_PRESETS, NATIVE_PRESETS, TRACK_GOAL_PRESETS, assertPreset, type RecipeAssembly } from './presets';
import { CATCH_TUNING, catchSpec } from './catch';
import { driveSpec } from './drive';
import { nativeSpec } from './native';
import { timeOfDayFor } from '../arcade/look';
import { BALL_DIFFICULTY } from './ball-difficulty';
import { singular } from '../draft/lexicon';
import { type AbilityWord, abilitiesOfControl, abilityHint, abilityWordsOf } from '../draft/controls';
import { RULE_TEMPLATES, type RuleTemplate, TEMPLATE_NAMES, type TemplateName, type TemplateSlot, says, templateParts, templatesFor } from '../arcade/rules/templates';
import { FINALE_GENRE_VERSION, genreAtLeast } from '../arcade/pieces/pacing-parts';

/** Recipes select an assembly; existing piece builders retain their frozen output. */
export function compileRecipe(assembly: RecipeAssembly): GameSpecV1 {
  return compileTemplated(assembly).spec;
}

/** `compileRecipe` and the rule template it attached (P45B T9); `null` = none. */
export function compileTemplated(assembly: RecipeAssembly): { readonly spec: GameSpecV1; readonly template: TemplateName | null } {
  const templated = withTemplate(compileRecipeSpec(assembly), assembly);
  return { ...templated, spec: withDirectorExtras(withAbilities(templated.spec, assembly), assembly.content) };
}

/**
 * Boss a scénář úseků z odpovědi režiséra (P46E T4) jdou do specu beze změny; co z nich hra unese, rozhodne
 * průběh (`pacingParts`) a ověření robotem v `direct()`. Obsah rychlé verze je nenese, její spec se nemění.
 */
function withDirectorExtras(spec: GameSpecV1, content: GenreSpec): GameSpecV1 {
  const { boss, segments } = content;
  return { ...spec, ...(boss === undefined ? {} : { boss: { name: boss.name, role: boss.role } }), ...(segments === undefined || segments.length === 0 ? {} : { segments: [...segments] }) };
}

const ATTACK_HINT = / J or Attack strikes nearby opponents\.$/;

/**
 * Generátory režimu, kde robot akce použije a ověření je dokáže (P46A T10, matice T9 a živé
 * věty); souboj (`fight`) od P47B T6 jen s akcemi `FIGHT_ABILITIES`, let (`glide_course`, matice P47B T9) všechny.
 * Ostatní generátory nikdo neměřil.
 */
export const ABILITY_GENERATORS: ReadonlySet<string> = new Set(['arena_escape', 'arena_collect', 'walker_labyrinth', 'fight', 'glide_course']);

/** Souboj má vlastní úder (Attack) a nic ke krádeži: bere jen dash a štít proti úderu soupeře (P47B T6). */
export const FIGHT_ABILITIES: readonly AbilityId[] = ['dash', 'shield'];

/** Bere hra generátoru `generator` (bez generátoru staví trať ovládání) akci `id`? Čte i měřidlo P47B. */
export const generatorTakes = (generator: string | undefined, id: AbilityId): boolean =>
  generator === undefined || (ABILITY_GENERATORS.has(generator) && (generator !== 'fight' || FIGHT_ABILITIES.includes(id)));

/**
 * Akce hrdiny ze sloves věty (P46A T8, `assemble`), jen akce, které ovládání bere, a jen hře,
 * která staví trať ovládáním nebo generátorem z `ABILITY_GENERATORS`. `compose` ověří svět
 * a akce, které robot nedokáže, zahodí. Úder bije i díl souboje, takže nápověda k Attack
 * ustoupí tlačítkům akcí. Sloveso věty (P47B T10, `saidWords`) dá tlačítku i nápovědě své
 * slovo („J to dodge.“); svět ho nečte.
 */
function withAbilities(spec: GameSpecV1, assembly: RecipeAssembly): GameSpecV1 {
  const generator = (spec.controlParams as { readonly generator?: string } | undefined)?.generator;
  // Akce z odpovědi režiséra (P46E T4) za akcemi věty; dvě tlačítka bere `abilitiesOfControl`.
  const said = [...new Set([...(assembly.abilities ?? []), ...(assembly.content.abilities ?? [])])].filter((id) => generatorTakes(generator, id));
  if (said.length === 0 || spec.control === undefined) return spec;
  const abilities = abilitiesOfControl(said, spec.control);
  if (abilities.length === 0) return spec;
  const heard = assembly.saidWords ?? {};
  const words = abilityWordsOf(abilities, heard);
  const labelled = { ...spec, abilities, ...(words === undefined ? {} : { abilityWords: words }) };
  // Duel hraje akce vlastním úderem a úhybem (P47B T8): tlačítko J nemá, jeho nápověda řekne sloveso věty.
  if (spec.control === 'duel') return { ...labelled, tutorial: { ...spec.tutorial, controlsHint: duelHint(spec.tutorial.controlsHint, abilities, heard) } };
  const own = abilities.includes('strike') ? spec.tutorial.controlsHint.replace(ATTACK_HINT, '') : spec.tutorial.controlsHint;
  // Delší slovo nápovědu nepřetáhne: nevejde-li se, platí obecná slovesa jako dřív.
  const hint = [abilityHint(abilities, words), abilityHint(abilities)].map((buttons) => `${own} ${buttons}`).find((line) => line.length <= 80) ?? own;
  return { ...labelled, tutorial: { ...spec.tutorial, controlsHint: hint } };
}

/**
 * Nápověda souboje se slovesy věty (P47B T10): „to strike“ dostane slovo úderu, „to dodge“ slovo
 * dashe nebo štítu („Tap right or Space to shove, tap left or Down to dodge.“). Akce bez slova věty
 * nechá obecné sloveso; nad 80 znaků zůstane nápověda žánru.
 */
function duelHint(hint: string, abilities: readonly AbilityId[], heard: Readonly<Partial<Record<AbilityId, AbilityWord>>>): string {
  const strike = abilities.includes('strike') ? heard.strike : undefined;
  const dodge = abilities.filter((id) => id === 'dash' || id === 'shield').map((id) => heard[id]).find((word) => word !== undefined);
  let said = hint;
  if (strike !== undefined) said = said.replace(/\bto strike\b/, `to ${strike.toLowerCase()}`);
  if (dodge !== undefined) said = said.replace(/\bto dodge\b/, `to ${dodge.toLowerCase()}`);
  return said.length <= 80 ? said : hint;
}

/** Druhy rolí hry, které šablona dosadí do slotu – první volná role hry v pořadí `roles[]`. */
const SLOT_KINDS: Readonly<Record<TemplateSlot, readonly string[]>> = {
  item: ['item', 'key', 'collectible'], goal: ['destination', 'exit'], target: ['target'], lever: ['switch'], door: ['door'],
  enemy: ['chaser', 'patrol', 'hazard'], hazard: ['hazard'], exit: ['exit', 'destination'], zone: ['zone', 'checkpoint'],
};

/**
 * Šablona pravidel pro recept ze `assemble` (P45B T9; jiné cesty záměr nenesou a šablonu
 * nedostanou). Žánr, který žádané sloveso nehraje (`unplayed`), dostane nejdřív `goal` šablonu
 * toho slovesa; jinak (a po ní) `overlay` podle os receptu a slov věty. Sloty berou role hry –
 * ne role dílů ani munici; chybí-li role, šablona se přeskočí. Platí první, která se vejde
 * do zbylých pravidel; nevejde-li se hra s vestavěnými pravidly, `compose` ji zkusí bez ní.
 */
function withTemplate(game: GameSpecV1, assembly: RecipeAssembly): { readonly spec: GameSpecV1; readonly template: TemplateName | null } {
  const { intent } = assembly;
  if (intent === undefined || game.logic !== undefined) return { spec: game, template: null };
  const budget = ARCADE_LIMITS.maxRules - (game.rules ?? []).length;
  const axes = [`move:${assembly.move}`, ...assembly.actions.map((action) => `action:${action}`), `objective:${assembly.objective}`];
  const goals = templatesFor(intent.unplayed.map((verb) => `action:${verb}`), budget).filter((name) => RULE_TEMPLATES[name].kind === 'goal');
  // Quest v prostoru od `genre.v4` (P47A T2, varianta B): hustotu nese průběh, overlay šablona ne – pod průběhem
  // vyhrál robot intermediate 6–7/8 (bez šablony 8/8, začátečník 3–5/8, `evals/play/p47a/README.md`).
  const pacedQuest = game.genre?.id === 'quest' && game.genre.mode === 'spatial' && genreAtLeast(game, FINALE_GENRE_VERSION);
  const overlays = TEMPLATE_NAMES.filter((name) => {
    const template: RuleTemplate = RULE_TEMPLATES[name];
    return template.kind === 'overlay' && !pacedQuest && template.budget <= budget && (template.axes.some((axis) => axes.includes(axis)) || template.verbs.some((verb) => says(intent.words, verb)));
  });
  const taken = new Set(['ammunition', ...(game.assemblyParts ?? []).map((part) => part.role)]);
  for (const name of [...goals, ...overlays]) {
    const roles: Partial<Record<TemplateSlot, string>> = {};
    for (const slot of RULE_TEMPLATES[name].slots) {
      const role = game.roles.find((item) => SLOT_KINDS[slot].includes(item.kind) && !taken.has(item.id) && !Object.values(roles).includes(item.id));
      if (role !== undefined) roles[slot] = role.id;
    }
    const parts = templateParts(name, roles);
    if (parts === null) continue;
    return {
      spec: { ...game, rules: [...(game.rules ?? []), ...parts.rules], ...(parts.things.length === 0 ? {} : { things: [...(game.things ?? []), ...parts.things] }), ...(parts.logic === undefined ? {} : { logic: parts.logic }) },
      template: name,
    };
  }
  return { spec: game, template: null };
}

function compileRecipeSpec(assembly: RecipeAssembly): GameSpecV1 {
  const base = compileRecipeBase(assembly);
  const time = timeOfDayFor(assembly.content.setting);
  const game = time === null ? base : { ...base, theme: { ...base.theme, timeOfDay: time } };
  const roles = [...game.roles];
  // One native bullet template is one ammunition identity. Additional named
  // kinds require additional physical templates and therefore stay unmet.
  const ammunition = assembly.content.cast?.find(item => item.does === 'scenery' && item.verb === 'shoot');
  if (ammunition !== undefined && !roles.some(role => role.id === 'ammunition')) roles.push({ id: 'ammunition', kind: 'item', label: ammunition.label, count: 1 });
  for (const node of assembly.dependsOn ?? []) if (!roles.some(role => role.id === node.goal)) {
    if (node.action === undefined) throw new Error('New dependency goals require an explicit action: ' + node.goal);
    roles.push({ ...game.roles[0]!, id: node.goal, label: node.label ?? node.goal, kind: node.action === 'open' ? 'door' : node.action === 'collect' ? 'key' : 'checkpoint' });
  }
  const ordered: NonNullable<RecipeAssembly['dependsOn']>[number][] = [];
  const visit = (goal: string): void => {
    if (ordered.some(node => node.goal === goal)) return;
    const node = assembly.dependsOn!.find(node => node.goal === goal)!;
    node.prerequisites.forEach(visit); ordered.push(node);
  };
  assembly.dependsOn?.forEach(node => visit(node.goal));
  const steps = ordered.map(node => {
    const role = roles.find(role => role.id === node.goal)!;
    const action = node.action ?? (role.kind === 'door' ? 'open' : role.kind === 'key' || role.kind === 'collectible' ? 'collect' : 'reach');
    return `${action} ${node.label ?? role.label}`;
  });
  const instruction = steps.join(', then ');
  const goalLine = instruction.length > 79 ? 'Complete the linked goals in order, then reach the finish.' : `${instruction.charAt(0).toUpperCase()}${instruction.slice(1)}.`;
  return { ...game, roles, ...(steps.length === 0 ? {} : { tutorial: { ...game.tutorial, goalLine } }), ...(assembly.phases === undefined ? {} : { phases: assembly.phases }), ...(assembly.dependsOn === undefined ? {} : { dependsOn: assembly.dependsOn }) };
}
function compileRecipeBase(assembly: RecipeAssembly): GameSpecV1 {
  if (assembly.preset === 'assembled') return compileAssembly(assembly);
  assertPreset(assembly);
  if (assembly.preset === 'roam.catch') return catchSpec(assembly, assembly.content);
  if (DRIVE_PRESETS[assembly.preset] !== undefined) {
    const { move, actions, objective, threats } = assembly;
    return driveSpec({ move, actions, objective, threats }, assembly.content);
  }
  if (NATIVE_PRESETS[assembly.preset] !== undefined) {
    const { move, actions, objective, threats } = assembly;
    // Resolve the sport before applying course-specific defaults. A remix of
    // football into golf must not inherit football's shorter shot deadline.
    const differentBallGoal = move === 'ball' && /\b(?:basketball|hoops?|golf|holes?|putt(?:ing)?)\b/i.test([assembly.content.setting, ...(assembly.content.cast ?? []).map(role => role.label)].join(' '));
    const defaults = differentBallGoal ? undefined : BALL_DIFFICULTY[assembly.preset];
    const content = defaults === undefined ? assembly.content : { ...assembly.content, params: { ...defaults, ...assembly.content.params } };
    return nativeSpec({ move, actions, objective, threats }, content);
  }
  if (TRACK_GOAL_PRESETS[assembly.preset] !== undefined) {
    const escape = assembly.objective === 'escape';
    const cast = assembly.content.cast ?? [];
    const content: GenreSpec = escape && !cast.some(item => item.does === 'chase_me')
      ? { ...assembly.content, cast: [...cast, { label: 'wolf', does: 'chase_me' }] } : assembly.content;
    const compiled = compileWith(GENRE_MODULES[content.genre] as GenreModule, content);
    if (escape) {
      // Getting caught ends this new course. Existing reach+chaser still retains its legacy health.
      const chaser = compiled.roles.find(role => role.kind === 'chaser')?.label ?? 'pursuer';
      // Útěk běží na trati z náhodných řad: hrozby průběhu (P45C) stavby trati ze vzorů (P46D T2) nečtou – 0 úderů a prohra robota.
      const { patterns: _patterns, ...controlParams } = compiled.controlParams as Record<string, unknown>;
      // One life gets no pacing (`GENRE_PACING.platform_level`), so no paced layout either: the course stays as it was.
      const paced = (controlParams.tuning as Record<string, unknown> | undefined)?.segments === true;
      const { segments: _segments, ...tuning } = (controlParams.tuning ?? {}) as Record<string, unknown>;
      return { ...compiled, controlParams: paced ? { ...controlParams, tuning } : controlParams,
        mechanics: compiled.mechanics.map(mechanic => mechanic.id === 'health' ? { id: 'health', params: { max: 1 } } : mechanic),
        tutorial: { ...compiled.tutorial, goalLine: `Reach the finish without being caught by the ${chaser}.` },
        objective: { ...compiled.objective, description: `Escape the ${chaser} and reach the finish without being caught.` } };
    }
    const item = compiled.roles.find(role => role.kind === 'collectible')?.label ?? 'coin';
    return { ...compiled, controlParams: { ...compiled.controlParams, coins: false, collectAll: true },
      objective: { ...compiled.objective, description: `Collect every ${item} and reach the finish.` },
      tutorial: { ...compiled.tutorial, goalLine: `Collect every ${item}, then reach the finish.` } };
  }
  return compileWith(GENRE_MODULES[assembly.content.genre] as GenreModule, assembly.content);
}

/** Compile a movement, then attach independently named gameplay parts. */
/** A separately attached rival turns a non-ball race into reaching the finish. */
const assembledObjective = (assembly: RecipeAssembly) =>
  (assembly.parts ?? []).some(part => part.kind === 'rival') && assembly.move !== 'ball' ? 'reach' as const : assembly.objective;

/**
 * Factory a composed movement compiles through: `drive` and `native` (glide, walk, ball)
 * read native params, anything else a legacy genre – the director validates answer content by it.
 */
export function assemblyFactory(assembly: RecipeAssembly): 'drive' | 'native' | undefined {
  if (assembly.move === 'drive') return 'drive';
  if (assembly.move === 'glide' && assembledObjective(assembly) === 'land') return undefined;
  return ['glide', 'walk', 'ball'].includes(assembly.move) ? 'native' : undefined;
}

/** Names belong to parts: the content without the things the parts play; a named projectile stays the ammunition. */
export function withoutPartNames(content: GenreSpec, parts: readonly { readonly label: string }[]): GenreSpec {
  const head = (label: string) => singular(label.toLowerCase()).split(' ').at(-1);
  return { ...content, cast: content.cast?.filter(member => member.does === 'scenery' && member.verb === 'shoot' || !parts.some(part => head(part.label) === head(member.label))) };
}

function compileAssembly(assembly: RecipeAssembly): GameSpecV1 {
  const { move } = assembly;
  const parts = assembly.parts ?? [];
  // Whoever wrote the content – the composer or the director – the base genre never plays a part's thing (no second shark).
  const content = withoutPartNames(assembly.content, parts);
  const separate = new Set<string>(parts.map(part => part.kind));
  const recipe = { move, objective: assembledObjective(assembly), actions: assembly.actions.filter(action => !separate.has(action)), threats: assembly.threats.filter(threat => !separate.has(threat)) };
  let base: GameSpecV1;
  // A catch with nothing else to do is the native catch game, not an arena that also collects.
  if (move === 'roam' && recipe.objective === 'catch' && recipe.actions.length === 0 && recipe.threats.length === 0 && parts.length === 0) {
    return catchSpec(recipe, { ...content, params: { ...CATCH_TUNING, ...content.params } });
  }
  if (move === 'drive') {
    base = driveSpec({ ...recipe, objective: ['race', 'escape'].includes(recipe.objective) ? recipe.objective : 'reach',
      actions: recipe.actions.filter(action => ['shoot', 'collect', 'deliver'].includes(action)),
      threats: recipe.threats.filter(threat => ['rival', 'chaser', 'obstacle'].includes(threat)) },
    { ...content, params: { lengthM: 700, roadWidth: 3600, roadEntryWidth: 10000, crashBudget: 3, ...content.params } });
    // A drive with parts gets no pacing (`GENRE_PACING.steer_track`), so no paced road or dodging bot either: the track stays as it was.
    const { segments: _segments, ...road } = (base.controlParams ?? {}) as Record<string, unknown>;
    if (parts.length > 0) base = { ...base, controlParams: road as GameSpecV1['controlParams'] };
  } else if (move === 'glide' && recipe.objective === 'land') {
    base = compileWith(GENRE_MODULES.voyage as GenreModule, { ...content, genre: 'voyage', mode: 'land', params: { touchdownSpeed: 19, gravityRisePct: 1, lives: 1, ...content.params } });
  } else if (['glide', 'walk', 'ball'].includes(move)) {
    const objective = move === 'ball' ? recipe.objective === 'defeat' ? 'defeat' : 'score' : ['collect', 'race', 'escape'].includes(recipe.objective) ? recipe.objective : 'reach';
    const sport = /\b(?:basketball|hoop|golf|hole)\b/.test([content.setting, ...(content.cast ?? []).map(item => item.label)].join(' '));
    base = nativeSpec({ ...recipe, objective,
      actions: recipe.actions.filter(action => move === 'ball' ? ['kick', 'throw'].includes(action) : move === 'walk' ? action === 'collect' : ['shoot', 'collect'].includes(action)),
      threats: recipe.threats.filter(threat => move === 'ball' ? threat === 'rival' : move === 'walk' ? ['guard', 'chaser', 'obstacle'].includes(threat) : ['rival', 'chaser', 'obstacle'].includes(threat)) },
    { ...content, params: { ...(move === 'glide' ? { clearancePermille: 275, clearanceRisePermille: 10 } : move === 'ball' && !sport ? BALL_DIFFICULTY[`ball.${objective}${recipe.threats.includes('rival') ? '+rival' : ''}`] : {}), ...content.params } },
    // A glide or walk with parts gets no pacing (`GENRE_PACING`), so no finale course either (P51 T3).
    parts.length === 0);
  } else {
    base = compileWith(GENRE_MODULES[content.genre] as GenreModule, content);
  }
  if (move === 'ball' && recipe.threats.includes('rival')) base = { ...base, controlParams: { ...base.controlParams, team: true } };
  const roles = [...base.roles, ...parts.map(part => ({ id: part.role, label: part.label, count: 1,
    kind: (part.kind === 'escape' ? 'zone' : part.kind === 'hazard' ? 'hazard' : part.kind === 'chaser' ? 'chaser' : ['deliver', 'interact'].includes(part.kind) ? 'item' : 'patrol') as GameSpecV1['roles'][number]['kind'] }))];
  const verbs: Record<string, string> = { catch: 'Catch', duel: 'Defeat', fight: 'Fight', deliver: 'Deliver', interact: 'Rescue', escape: 'Escape', hazard: 'Dodge', chaser: 'Escape', rival: 'Beat' };
  const steps = parts.map(part => `${verbs[part.kind]} the ${part.label}`);
  const sequential = parts.some(part => part.phase === 1);
  const partsLine = steps.map((step, index) => sequential && index > 0 ? step.charAt(0).toLowerCase() + step.slice(1) : step).join(sequential ? ', then ' : '. ');
  // `assembly_finish` still waits for the native win, so the tutorial keeps its goal too.
  const nativeGoal = base.tutorial?.goalLine ?? '';
  const goalLine = [`${partsLine}. ${nativeGoal}`, `Complete the named goals. ${nativeGoal}`].map(line => line.trim()).find(line => line.length <= 80) ?? 'Complete the named goals and reach the finish.';
  const combat = parts.some(part => part.kind === 'duel' || part.kind === 'fight');
  const dribble = move === 'ball' && parts.some(part => ['catch', 'deliver', 'interact', 'duel', 'fight'].includes(part.kind));
  const travelHint = move === 'flap' ? 'Space flaps.' : move === 'jump' ? 'Arrows move. Space jumps.' : move === 'run' ? 'Arrows dodge. Space jumps.' : 'Arrows move.';
  return { ...base, roles, ...(parts.length ? { assemblyParts: parts.map(({ label: _label, ...part }) => part),
    tutorial: { ...base.tutorial, goalLine,
      ...(combat ? { controlsHint: `${travelHint} J or Attack strikes nearby opponents.` } : dribble ? { controlsHint: 'Arrows move. Drag to aim; hold and release to shoot.' } : {}) } } : {}) };
}
export const DEPTH_PARAM_BOUNDS = {
  lives: { min: 1, max: 9 },
  targetScore: { min: 0, max: 9999 },
  timeLimit: { min: 0, max: ARCADE_LIMITS.maxTicks / ARCADE_HZ },
} as const satisfies ParamBounds;
type DepthParam = keyof typeof DEPTH_PARAM_BOUNDS;
type Depth = Partial<Readonly<Record<DepthParam, number>>>;

/**
 * Překlad modulem `module` a pak hloubka (P36A T8): parametry hloubky modul
 * nevidí, hra je dostane až hotová – jen časový limit dostane modul s hodinami
 * (`clockParam`) i předem. Bez nich je výsledek přesně překlad modulu.
 * Jediná cesta pro rychlý návrh, odpověď režiséra i opravné kolo.
 */
export function compileWith(module: GenreModule, spec: GenreSpec): GameSpecV1 {
  const own = { ...(spec.params ?? {}) };
  const depth: Record<string, number> = {};
  for (const key of Object.keys(DEPTH_PARAM_BOUNDS)) {
    if (own[key] === undefined) continue;
    depth[key] = own[key];
    delete own[key];
  }
  // Limit režiséra jsou hodiny, do kterých modul plánuje délku (úkol svá kola, F3); hodiny pak nastaví `withDepth` stejně.
  if (module.clockParam !== undefined && depth.timeLimit !== undefined && depth.timeLimit > 0) own[module.clockParam] = depth.timeLimit;
  const { params: _params, ...rest } = spec;
  const plain = (Object.keys(own).length === 0 ? rest : { ...rest, params: own }) as GenreSpec;
  const game = withEnemyAddon(withDepth(module.compile(withCounts(plain) as never), depth), spec);
  // Činnost hrdiny je jen vzhled (P37A T3): modul ji nečte, hra ji dostane hotová.
  return spec.heroAction === undefined ? game : { ...game, heroAction: spec.heroAction };
}

/**
 * Životy do mechaniky `health` (hra žánru ji nese, výchozí 3), cílové skóre do
 * `scoring.target` (kompilátor ho ořízne na dosažitelné, mez specu je 10),
 * časový limit do časovače, který končí prohrou: hodiny, které hra už má,
 * dostanou novou délku; přežití (časovač končící výhrou) délku nese v `seconds`
 * modulu a limit ho nemění. Exportované pro rychlý návrh (životy a skóre z věty).
 */
export function withDepth(spec: GameSpecV1, depth: Depth): GameSpecV1 {
  const { lives, targetScore, timeLimit } = depth;
  let mechanics = spec.mechanics;
  if (lives !== undefined) mechanics = mechanics.map((mechanic) => (mechanic.id === 'health' ? { id: 'health', params: { max: lives } } : mechanic));
  if (timeLimit !== undefined && timeLimit > 0) {
    const clock = mechanics.find((mechanic) => mechanic.id === 'timer');
    if (clock === undefined) mechanics = [...mechanics, { id: 'timer', params: { id: 'clock', seconds: timeLimit, onEnd: 'lose' } }];
    else if ((clock.params as { readonly onEnd?: string }).onEnd === 'lose') mechanics = mechanics.map((mechanic) => (mechanic === clock ? { id: 'timer', params: { ...mechanic.params, seconds: timeLimit } } : mechanic));
  }
  const target = targetScore !== undefined && targetScore > 0 && spec.scoring !== undefined ? Math.max(10, targetScore) : null;
  return {
    ...spec,
    mechanics,
    ...(lives !== undefined && spec.controlParams?.crashBudget !== undefined ? {
      controlParams: { ...spec.controlParams, crashBudget: lives },
      ...(spec.tutorial === undefined || lives <= 1 ? {} : {
        tutorial: { ...spec.tutorial, controlsHint: spec.tutorial.controlsHint.replace('Banks end run.', 'Avoid banks.') },
      }),
    } : {}),
    ...(target === null ? {} : { scoring: { ...spec.scoring, target } }),
  };
}

/** Role obsazení jako doplněk ovládání (`chase_me` → pronásledovatel, `shoot_at` → střelba). */
const ENEMY_ADDONS: Partial<Readonly<Record<CastRole, AddonId>>> = { chase_me: 'chaser', shoot_at: 'shoot' };

/**
 * Doplněk jen hře, která staví trať ovládáním (běžec, skákačka) a ovládání ho
 * bere (`CAPABILITIES`). Hra s generátorem režimu (aréna, plavba, úkol) hraje
 * chování ve svém modulu podle `does` (lovec, hlídka). Role, kterou žánr hraje
 * sám (`FOE_DOES`: aréna honí, střílečka střílí), doplněk nedostane. Každá
 * role obsazení dostane svůj doplněk (P39 T7), v pořadí obsazení.
 */
function withEnemyAddon(spec: GameSpecV1, genre: Pick<GenreSpec, 'genre' | 'cast'>): GameSpecV1 {
  const generator = (spec.controlParams as { readonly generator?: string } | undefined)?.generator;
  if (generator !== undefined || spec.control === undefined) return spec;
  const allowed = CAPABILITIES[spec.control].addons;
  const wanted = new Set((genre.cast ?? []).map((item) => (item.does === FOE_DOES[genre.genre] ? undefined : ENEMY_ADDONS[item.does])));
  // Pevné pořadí (pronásledovatel, střelba), ne pořadí obsazení: doplňky přidávají těla, takže pořadí obsazení by pohnulo hashem světa (T8).
  const added = Object.values(ENEMY_ADDONS).filter((addon) => wanted.has(addon) && allowed.includes(addon));
  if (added.length === 0) return spec;
  const fireHint = `${spec.tutorial.controlsHint} F or Fire to shoot.`;
  return {
    ...spec,
    addons: [...new Set([...(spec.addons ?? []), ...added])],
    ...(added.includes('shoot') && fireHint.length <= 80 ? { tutorial: { ...spec.tutorial, controlsHint: fireHint } } : {}),
  };
}
