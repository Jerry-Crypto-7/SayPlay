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

import { LOOK_IDS } from '../arcade/look';
import { sentenceChecklist } from '../fidelity/checklist';
import { CAST_MAX, CAST_ROLES, COUNT_PARAMS, COUNT_ROLES, type CastRole, type GenreModule, type GenreSpec } from '../genre/contract';
import { DEPTH_PARAM_BOUNDS, GENRE_MODULES } from '../genre/index';
import { ARCHETYPES, ARCHETYPE_IDS, MECHANICS, MECHANIC_IDS, type MechanicEntry } from '../registry';
import { ROLE_KINDS } from '../spec';

import { GENRE_ANSWER_SCHEMA, readyModes } from './answer-schema';

/** Úvod plného promptu; kompaktní má vlastní kratší. */
export const GENRE_RULES =
  'Return ONLY a GenreSpec: pick the genre and mode the sentence plays and name its roles with the sentence\'s nouns; the game is built from it. Never output code. Answer {plan, spec}: plan = one short line of reasoning.';

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

export const GENRE_SHAPE_LINE = `spec: {genre, mode, hero: string<=60, cast?: [{label: string<=60, does: ${CAST_DOES.join('|')}, verb?: string<=24, states?: 2|3, patrol?: bool}]<=${String(CAST_MAX)}, setting: string<=80, palette?, params?, counts?: {enemy?, collectible?, target?: int}, ruleRoles?, things?, rules?}; a missing optional field is null.`;

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
    'GENRES (cues; modes; what the hero can be; params):',
    ...genres,
    'genre and mode: the ones whose cues fit the main verb – the verb that carries the goal or the win. A task (light, fight, land) beats moving (run, sail, jump), moving beats collecting, collecting beats escaping.',
    'hero: the 1–3 word English noun the player is ("pirate ship", "wizard"). It must be a kind the genre lists (a ship sails, a car drives); if it cannot be, pick the genre it can play.',
    // P39: obsazení místo jednoho `enemy` – každá věc věty a co s ní dělá její sloveso.
    'cast: every thing the sentence names except the hero and the place, each {label, does}; does = what the verb at that thing makes it:',
    ...CAST_DOES.map((does) => `- ${does}: ${CAST_DOES_LINES[does]}`),
    'The genre plays each does it can and the nearest one for the rest. Null cast when the sentence names nothing – the game then picks from the setting. Never add a thing the sentence does not name.',
    `setting: where it happens, <=80 chars. palette: the scene set that best shows it, or null: ${LOOK_IDS.join('|')}. params: only for a number the sentence says, else null.`,
    'counts: how many the sentence says ("grab 5 coins" = collectible 5): enemy for shoot_at|chase_me|avoid|fight, collectible for collect, target for reach|throw_at; only roles the genre counts, else null.',
    `Every genre takes params ${Object.entries(DEPTH_PARAM_BOUNDS)
      .map(([key, range]) => `${key} ${String(range.min)}..${String(range.max)}`)
      .join(', ')} when the sentence says them: lives ("3 lives"), points to win ("score 200 points"), seconds before the player loses.`,
    "Keep the user's nouns, numbers and names. Cast labels are singular (\"rock\", not \"rocks\"). A cast thing is never what the player holds, sprays or throws.",
    // P38: výchozí bod je odhad ze slov, ne kostra – „ponech a přidej jednu věc“ držel AI verzi u návrhu.
    'The starting point is a rough keyword guess the player sees while you work, not a frame. Build the game the sentence asks for: change the genre, mode, hero, cast or anything else the guess got wrong; keep only what it got right.',
    'Every action the player does in the sentence must be playable. When it names two (jump and shoot, run and collect), the genre plays one and the other rides on it: jump + shoot = platformer with the shot things shoot_at; run + shoot = runner with shoot_at.',
    'A sentence in another language is read for its meaning; every label you write stays English.',
    'Checklist and main verb (in the request) are what the keyword reader found – a sentence it could not read gives none, then read the sentence yourself. Carry each checklist thing in a cast label or the setting, and play the main verb in its genre and mode.',
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

/** Zpráva požadavku: věta, její seznam a výchozí bod; plný i kompaktní prompt ji sdílejí. */
export function directorUser(sentence: string, draft: GenreSpec | null): string {
  return `${sentence.trim()}\n\n${checklistLines(sentence)}\n\n${startingPoint(draft)}`;
}

/**
 * Pravidla P29A v první odpovědi (B-R5): sloveso, které žánr nehraje, dopíše
 * model pravidlem. Gramatika je `modelRulesSchema`; jeden příklad stačí, zbytek
 * nese schéma odpovědi. Role pravidel jsou „player“ a vlastní `ruleRoles`.
 */
export function rulesPromptLines(): string {
  return [
    'rules: only for a verb of the sentence the genre cannot play (carry, push, open, pull, give…); else null. Each rule {id, verb, when, if, do}; verb = that sentence verb, one lowercase English word – the robot must see every rule fire while it wins (a lose or damage rule: when a robot walks into it), or the game is refused.',
    `when: {"contact":[role,role]} | {"press":"action"|"alt"} | {"every":ticks60Hz} | {"counter":{"name":"score"|"items"|"health","atLeast":n}} | {"hit":role} | {"interact":{"role","radius":m,"hold":ticks,"states":2|3}} (hold Use at it; only as the winning rule, do {"win":true}, won when all targets are done; one per game, not with +shoot/+chaser). if (all hold, or null): {"holding":role} | {"notHolding":true} | {"counter":{"name","atLeast"|"below"}} | {"near":{"role","within":m}}. do: {"score":n} {"damage":n} {"win":true} {"lose":true} {"despawn":"other"|"self"|"held"} {"spawn":{"role","at":"player"|"other"}} {"count":{"counter","amount"}} {"respawn":true} {"checkpoint":"other"|"self"} {"grab":"other"|"self"} {"release":true} {"throwHeld":true} {"push":"other"|"self"} {"toggle":role} (bodies of that role switch once).`,
    `A role is "player" or an id from ruleRoles [{id, kind, label, count}] (kind: ${ROLE_KINDS.filter((kind) => kind !== 'player').join('|')}). things [{role, start:"hidden"}] = starts invisible until toggled. In arena or quest a rule that wins plays in a walled yard: carried things in front, the goal behind the gate.`,
    'RULE EXAMPLE: {"ruleRoles":[{"id":"key","kind":"key","label":"golden key","count":null},{"id":"door","kind":"door","label":"castle door","count":null},{"id":"stairs","kind":"exit","label":"tower stairs","count":null}],"things":null,"rules":[{"id":"take_key","verb":"carry","when":{"contact":["player","key"]},"if":[{"notHolding":true}],"do":[{"grab":"other"}]},{"id":"open_door","verb":"open","when":{"contact":["player","door"]},"if":[{"holding":"key"}],"do":[{"toggle":"door"},{"despawn":"held"}]},{"id":"climb","verb":"climb","when":{"contact":["player","stairs"]},"if":null,"do":[{"win":true}]}]}',
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
export const DIRECTOR_PROMPT_VERSION = canonicalHash({ system: directorSystemPrompt(), schema: GENRE_ANSWER_SCHEMA });

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
