/**
 * Prompt režiséra (P23-B T3, na žánrech od P32B T4): model píše `GenreSpec` –
 * žánr, režim, hrdinu, obsazení s rolí každé věci (P39) a prostředí – a hru
 * z něj složí modul žánru. Nabídka
 * žánrů je **vyrenderovaná ze zdroje** (`GENRE_MODULES`): jen režimy `ready`,
 * narážky, třídy hrdinů a meze parametrů, takže režim, který modul dokončí,
 * projde do promptu sám a nedokončený v něm není. `DIRECTOR_PROMPT_VERSION`
 * je hash celého systémového textu: změna modulu zneplatní cache.
 *
 * `renderRegistry` (registr mechanik a archetypů) zůstává pro remix a opravná
 * kola, která dál pracují nad `GameSpecV1`.
 */

import { z } from 'zod';

import { canonicalHash } from '@/ir/worlddoc';
import { EMISSION_MODEL, type UpstreamRequest } from '@/model/prompt';

import { liveCells } from '../compose/allowed';
import { ABILITIES, BOSS_ATTACKS } from '../arcade/contract';
import { LOOK_IDS } from '../arcade/look';
import { SEGMENT_NEWS } from '../arcade/pieces/pacing';
import { sentenceChecklist } from '../fidelity/checklist';
import { CAST_MAX, CAST_ROLES, COUNT_PARAMS, COUNT_ROLES, type CastRole, type GenreModule, type GenreSpec } from '../genre/contract';
import { DEPTH_PARAM_BOUNDS, GENRE_MODULES } from '../genre/index';
import { ARCHETYPES, ARCHETYPE_IDS, MECHANICS, MECHANIC_IDS, type MechanicEntry } from '../registry';
import { ROLE_KINDS } from '../spec';

import { GENRE_ANSWER_SCHEMA, readyModes } from './answer-schema';

/** Úvod plného promptu; kompaktní má vlastní kratší. */
export const GENRE_RULES =
  "Return ONLY {plan, spec}: plan is one short line. Prefer a recipe selected from LIVE COMBINATIONS, with the sentence's actors and objects. Legacy GenreSpec remains accepted. Never output code. A requested action must be played with evidence or listed explicitly in unmet; naming a genre or a cast role is not evidence.";

/** Co smí věc obsazení dělat – hrdina do obsazení nepatří, je v `hero`. */
const CAST_DOES = CAST_ROLES.filter((does): does is Exclude<CastRole, 'hero'> => does !== 'hero');

/** Jeden řádek promptu na každé `does` (P39): co věc ve hře dělá a které sloveso věty ji tak obsadí. */
const CAST_DOES_LINES: Readonly<Record<Exclude<CastRole, 'hero'>, string>> = {
  shoot_at: 'the player shoots it down ("shoot the drones", "a shooting game against animals")',
  chase_me: 'it hunts the player ("a ghost chases you", "run from the bear"); patrol: true when it wanders until it sees the player ("guards patrol")',
  avoid: 'an obstacle or threat the player dodges or jumps over ("dodge rocks", "jump over logs")',
  collect: 'the player gathers it ("grab 5 coins", "eat plankton")',
  reach: 'the goal, or what the main verb acts on, with verb and states ({"label":"candle","does":"reach","verb":"light","states":2})',
  fight: 'a rival the player beats up close ("duel a ninja", "fight monsters")',
  throw_at: 'what the player throws at ("throw snowballs at a snowman")',
  scenery: 'a thing of the place with no rule',
};

export const GENRE_SHAPE_LINE = `spec: {recipe: {move, actions, objective, threats}, unmet: [{actor, verb, object: string|null}], hero: string<=60, cast?: [{label: string<=60, does: ${CAST_DOES.join('|')}, verb?: string<=24, states?: 2|3, patrol?: bool}]<=${String(CAST_MAX)}, setting: string<=80, palette?, params?, counts?: {enemy?, collectible?, target?: int}, ruleRoles?, things?, rules?}; a missing optional field is null.`;

const ID_PATTERN_SOURCE = '^[A-Za-z][A-Za-z0-9_.]{0,63}$';

type JsonSchema = Record<string, unknown>;

/** Zhuštěný zápis jednoho uzlu JSON Schema, čitelný pro model i pro člověka. */
export function compactSchema(node: JsonSchema): string {
  if (Array.isArray(node.enum)) return (node.enum as string[]).join('|');
  if (node.const !== undefined) return JSON.stringify(node.const);
  switch (node.type) {
    case 'string': {
      if (node.pattern === ID_PATTERN_SOURCE) return 'roleId';
      if (typeof node.pattern === 'string') return 'word';
      return typeof node.maxLength === 'number' ? `string<=${String(node.maxLength)}` : 'string';
    }
    case 'integer': {
      const min = typeof node.minimum === 'number' && node.minimum > -1e15 ? String(node.minimum) : '';
      const max = typeof node.maximum === 'number' && node.maximum < 1e15 ? String(node.maximum) : '';
      return min === '' && max === '' ? 'int' : `int ${min}..${max}`;
    }
    case 'boolean':
      return 'bool';
    case 'array': {
      const items = compactSchema(node.items as JsonSchema);
      const bounds = typeof node.maxItems === 'number' ? `<=${String(node.maxItems)}` : '';
      return `[${items}]${bounds}`;
    }
    case 'object': {
      const properties = node.properties as Record<string, JsonSchema> | undefined;
      if (properties === undefined) {
        const keys = node.propertyNames === undefined ? 'string' : compactSchema(node.propertyNames as JsonSchema);
        const values = typeof node.additionalProperties === 'object' && node.additionalProperties !== null ? compactSchema(node.additionalProperties as JsonSchema) : 'any';
        return `{${keys}: ${values}}`;
      }
      const required = new Set((node.required as string[] | undefined) ?? []);
      const fields = Object.entries(properties).map(([key, value]) => {
        const defaulted = value.default !== undefined ? `=${JSON.stringify(value.default)}` : '';
        return `${key}${required.has(key) && defaulted === '' ? '' : '?'}: ${compactSchema(value)}${defaulted}`;
      });
      return `{${fields.join(', ')}}`;
    }
    default:
      return 'any';
  }
}

function schemaOf(schema: z.ZodType): string {
  return compactSchema(z.toJSONSchema(schema) as JsonSchema);
}

/** Registr mechanik a archetypů jako text – ze zdroje, při každém volání. */
export function renderRegistry(): string {
  const mechanics = MECHANIC_IDS.map((id) => {
    const entry = MECHANICS[id] as MechanicEntry<unknown>;
    return `- ${id} ${schemaOf(entry.params as z.ZodType)} – ${entry.explanation}`;
  });
  const archetypes = ARCHETYPE_IDS.map((id) => {
    const entry = ARCHETYPES[id];
    return `- ${id}: objective=${entry.objective}; required=${entry.requiredMechanics.join(',')}; allowed=${[...new Set(entry.allowedMechanics)].join(',')} – ${entry.pitch}`;
  });
  return [
    'MECHANICS (id {params} – what it does; roleId = id of a role declared in roles):',
    ...mechanics,
    'ARCHETYPES (pick exactly one; objective.kind must match; mechanics only from allowed, all required present):',
    ...archetypes,
  ].join('\n');
}

/**
 * Nabídka žánrů a smlouva rolí (`genre/roles.ts`) pro oba prompty: jeden řádek
 * na žánr s aspoň jedním režimem `ready`, pak co která role znamená.
 */
export function genrePromptLines(): string {
  const genres = (Object.values(GENRE_MODULES) as GenreModule[]).flatMap((module) => {
    const modes = readyModes(module);
    if (modes.length === 0) return [];
    const params = Object.entries(module.paramBounds).map(([key, range]) => `${key} ${String(range.min)}..${String(range.max)}`);
    const counted = COUNT_ROLES.filter((role) => modes.some((mode) => (COUNT_PARAMS[module.id] as Readonly<Record<string, Partial<Record<string, string>> | undefined>>)[mode]?.[role] !== undefined));
    return [
      `- ${module.id} (${module.cues.join(', ')}): modes ${modes.join('|')}; hero ${module.heroClasses.join('/')}${params.length === 0 ? '' : `; params ${params.join(', ')}`}${counted.length === 0 ? '' : `; counts ${counted.join('/')}`}`,
    ];
  });
  return [
    'LIVE COMBINATIONS (move | actions | objective | threats; - means empty array; select one; staged unavailable):',
    ...new Set(liveCells().map(cell => `- ${cell.recipe.move} | ${cell.recipe.actions.join(',') || '-'} | ${cell.recipe.objective} | ${cell.recipe.threats.join(',') || '-'}`)),
    'LEGACY GENRES (compatibility format; recipe answers omit genre/mode):',
    ...genres,
    `NEW IN YOUR VERSION (else null): boss {role: cast label of the foe that comes last, name: what the player sees, attack: ${BOSS_ATTACKS.join('|')}}; abilities: 1–2 hero actions on buttons the sentence implies (${ABILITIES.join('|')}); segments: exactly 3 changes the run brings in order (${SEGMENT_NEWS.join('|')}). EXAMPLE: {"boss":{"role":"police car","name":"police helicopter","attack":"drop"},"abilities":["shoot","dash"],"segments":["newFoe","narrow","faster"]}`,
    'Preserve all essential movement, actions, goals and threats together; driving + racing + shooting cannot become stationary shooting.',
    'hero: 1-3 English words naming the player ("pirate ship", "wizard"); choose compatible movement.',
    // P39: obsazení místo jednoho `enemy` – každá věc věty a co s ní dělá její sloveso.
    'cast: every thing the sentence names except the hero and the place, each {label, does}; does = what the verb at that thing makes it:',
    ...CAST_DOES.map((does) => `- ${does}: ${CAST_DOES_LINES[does]}`),
    'Never claim a nearby mechanic plays a different action. List every unsupported actor-verb-object triple in unmet. Use unmet: [] only if nothing was omitted. Null cast when nothing is named; setting defaults then supply roles.',
    `setting: where it happens, <=80 chars. palette: the scene set that best shows it, or null: ${LOOK_IDS.join('|')}. params: only for a number the sentence says, else null.`,
    'counts: how many the sentence says ("grab 5 coins" = collectible 5): enemy for shoot_at|chase_me|avoid|fight, collectible for collect, target for reach|throw_at; only roles the genre counts, else null.',
    `Every genre takes params ${Object.entries(DEPTH_PARAM_BOUNDS)
      .map(([key, range]) => `${key} ${String(range.min)}..${String(range.max)}`)
      .join(', ')} when the sentence says them: lives ("3 lives"), points to win ("score 200 points"), seconds before the player loses.`,
    "Keep the user's nouns, numbers and names. Cast labels are singular (\"rock\", not \"rocks\"). A cast thing is never what the player holds, sprays or throws.",
    // P38: výchozí bod je odhad ze slov, ne kostra – „ponech a přidej jednu věc“ držel AI verzi u návrhu.
    'The starting point is a keyword guess, not a constraint. Replace errors; preserve the sentence.',
    'Multiple actions must coexist in the live recipe. Labels, generic wins and score do not certify verbs; actual runtime effects must witness every requested triple.',
    'A sentence in another language is read for its meaning; every label you write stays English.',
    'Checklist and main verb (in the request) are what the keyword reader found. FULL INTENT is authoritative; a suggested genre is not proof. Preserve its named roles and all essential triples.',
  ].join('\n');
}

/**
 * Kontrolní seznam věty a hlavní sloveso s rodinou (P37A T8, `fidelity/checklist.ts`)
 * jako řádky požadavku – podle téhož seznamu brána upgradu AI verzi pustí, nebo ne.
 */
export function checklistLines(sentence: string): string {
  const { checklist, verb } = sentenceChecklist(sentence);
  const nouns = checklist.filter((entry) => entry.slot !== 'verb').map((entry) => `${entry.slot} "${entry.item}"`);
  const played = verb === null ? '' : verb.mode === 'default' ? `genre ${verb.genre}` : `genre ${verb.genre}, mode ${verb.mode}`;
  return [
    `Checklist: ${nouns.length === 0 ? 'none' : nouns.join('; ')}.`,
    verb === null ? 'Main verb: none – the sentence names no game verb.' : `Main verb: "${verb.word}"${verb.family === null ? '' : ` (family ${verb.family})`} – ${played}.`,
  ].join('\n');
}

/**
 * Průběh hry jako poslední řádek zprávy (P45B T11): gpt-oss-20b nechával `logic`
 * na `null` (2 z 25 vět), i když ho systémový prompt chtěl – řádek u věty je vidět víc.
 * T12a: řádek říká celé zapojení – model jinak časovač spustil, ale skončil výhrou
 * místo `goPhase`, takže druhá fáze zůstala mrtvá a výhra přebila cíl věty.
 */
export const COURSE_LINE = 'Course: give this game a course wired like the LOGIC EXAMPLE – {"when":{"phase":first}} starts a timer once (60 ticks = 1 s), its {"when":{"timer"}} rule does {"goPhase":second} (plus a wave, spawn or toggle), a {"when":{"phase":second}} rule reacts; every timer and phase you declare is used this way. Never win or lose on a timer or phase – the genre keeps its goal. null only when nothing in the game changes over time.';

/** Zpráva požadavku: věta, její seznam, výchozí bod a průběh; plný i kompaktní prompt ji sdílejí. */
export function directorUser(sentence: string, draft: GenreSpec | null): string {
  return `${sentence.trim()}\n\n${checklistLines(sentence)}\n\n${startingPoint(draft)}\n\n${COURSE_LINE}`;
}

/**
 * Pravidla P29A v první odpovědi (B-R5): sloveso, které žánr nehraje, dopíše
 * model pravidlem. Gramatika je `modelRulesSchema`; jeden příklad stačí, zbytek
 * nese schéma odpovědi. Role pravidel jsou „player“ a vlastní `ruleRoles`.
 * Od P45B T10 i průběh hry: blok `logic` jedním řádkem a příklad s fází, časovačem a vlnou.
 */
export function rulesPromptLines(): string {
  return [
    'rules: for a verb of the sentence the genre cannot play (carry, push, open, pull, give…) and for the course (logic below); else null. Each rule {id, verb, when, if, do}; verb = that sentence verb, one lowercase English word – the robot must see every rule fire while it wins (a lose or damage rule: when a robot walks into it), or the game is refused.',
    `when: {"contact":[role,role]} | {"press":"action"|"alt"} | {"every":ticks60Hz} | {"counter":{"name":"score"|"items"|"health","atLeast":n}} | {"hit":role} | {"interact":{"role","radius":m,"hold":ticks,"states":2|3}} (hold Use at it; only as the winning rule, do {"win":true}, won when all targets are done; one per game, not with +shoot/+chaser). if (all hold, or null): {"holding":role} | {"notHolding":true} | {"counter":{"name","atLeast"|"below"}} | {"near":{"role","within":m}}. do: {"score":n} {"damage":n} {"win":true} {"lose":true} {"despawn":"other"|"self"|"held"} {"spawn":{"role","at":"player"|"other"}} {"count":{"counter","amount"}} {"respawn":true} {"checkpoint":"other"|"self"} {"grab":"other"|"self"} {"release":true} {"throwHeld":true} {"push":"other"|"self"} {"toggle":role} (bodies of that role switch once).`,
    `A role is "player" or an id from ruleRoles [{id, kind, label, count}] (kind: ${ROLE_KINDS.filter((kind) => kind !== 'player').join('|')}). things [{role, start:"hidden"}] = starts invisible until toggled. In arena or quest a rule that wins plays in a walled yard: carried things in front, the goal behind the gate.`,
    'RULE EXAMPLE: {"ruleRoles":[{"id":"key","kind":"key","label":"golden key","count":null},{"id":"door","kind":"door","label":"castle door","count":null},{"id":"stairs","kind":"exit","label":"tower stairs","count":null}],"things":null,"rules":[{"id":"take_key","verb":"carry","when":{"contact":["player","key"]},"if":[{"notHolding":true}],"do":[{"grab":"other"}]},{"id":"open_door","verb":"open","when":{"contact":["player","door"]},"if":[{"holding":"key"}],"do":[{"toggle":"door"},{"despawn":"held"}]},{"id":"climb","verb":"climb","when":{"contact":["player","stairs"]},"if":null,"do":[{"win":true}]}]}',
    'logic – REQUIRED when the sentence has a course (survive, defend, waves, escape, race, rescue, fight, a time limit, stages), else null: {"vars":[{id,start}],"timers":[{id}],"phases":[{id}] (2–4, first is the start),"events":[id]}. Every phase and timer you declare must be entered/started by one rule and read by another: the first phase is entered at tick 0, so {"when":{"phase":first}} starts a timer once (never restart it with every); a later phase needs goPhase; the genre keeps its goal. Its rules – when: {"timer":id} (ran out) | {"phase":id} (entered) | {"phaseExit":id} | {"var":{"name","atLeast"|"below"}} | {"event":id}; if: {"var":…} | {"inPhase":id} | {"timerRunning":id} | {"timerStopped":id}; do: {"set":{"var","value"}} {"add":{"var","amount"}} {"goPhase":id} {"startTimer":{"timer","ticks"}} {"stopTimer":id} {"emit":id} {"wave":{"role","count","at":"edge"|"player"|"other"}} (bodies of a role appear at once).',
    'LOGIC EXAMPLE: {"ruleRoles":[{"id":"bat","kind":"chaser","label":"bat","count":null}],"things":null,"logic":{"vars":null,"timers":[{"id":"dusk"}],"phases":[{"id":"day"},{"id":"night"}],"events":null},"rules":[{"id":"sunset","verb":"wait","when":{"phase":"day"},"if":null,"do":[{"startTimer":{"timer":"dusk","ticks":900}}]},{"id":"fall","verb":"darken","when":{"timer":"dusk"},"if":null,"do":[{"goPhase":"night"}]},{"id":"swarm","verb":"swarm","when":{"phase":"night"},"if":null,"do":[{"wave":{"role":"bat","count":1,"at":"edge"}}]}]}',
  ].join('\n');
}

/** Systémový prompt bez věty. Stavěný při každém volání, aby změna modulu prošla ven. */
export function directorSystemPrompt(): string {
  return [GENRE_RULES, GENRE_SHAPE_LINE, genrePromptLines(), rulesPromptLines()].join('\n\n');
}

/**
 * Hash systémového textu a schématu odpovědi – klíč cache a otisk verze
 * promptu. Schéma je v něm od P36A T7: dřív jeho změna cache nezneplatnila.
 */
export const DIRECTOR_PROMPT_VERSION = canonicalHash({ system: directorSystemPrompt(), schema: GENRE_ANSWER_SCHEMA, course: COURSE_LINE });

/** Návrh ze slov jako výchozí bod; hra bez žánru (mřížka archetypu) žádný nedá. */
export function startingPoint(draft: GenreSpec | null): string {
  return draft === null ? 'Starting point: none – choose from the sentence.' : `Starting point (a keyword guess, replace what it got wrong): ${JSON.stringify(draft)}`;
}

export function buildDirectorRequest(sentence: string, draft: GenreSpec | null): UpstreamRequest {
  return {
    model: EMISSION_MODEL,
    system: directorSystemPrompt(),
    user: directorUser(sentence, draft),
    outputSchema: GENRE_ANSWER_SCHEMA,
  };
}
