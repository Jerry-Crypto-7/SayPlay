/**
 * Prompt režiséra (P23-B T3): model dostane pravidla balíčku, registr
 * mechanik a archetypů **vyrenderovaný ze zdroje** (`MECHANICS`, `ARCHETYPES`
 * – žádný ručně opsaný seznam, který by zestárl), dva kompaktní příklady a
 * tvar `verification`; v `user` větu a návrh ze slov jako výchozí bod.
 *
 * Schémata se nerendrují jako plné JSON Schema – to má 4,7 kB jen pro
 * parametry mechanik – ale zhuštěným zápisem `{role: roleId, speed:
 * slow|normal|fast}`, odvozeným z `z.toJSONSchema`, aby cokoli, co se v
 * registru změní, prošlo do promptu samo. `DIRECTOR_PROMPT_VERSION` je hash
 * celého systémového textu: změna registru nebo pravidel zneplatní cache.
 *
 * Volání je prostý text (`UpstreamRequest`), žádný structured output –
 * odpověď čte `readDirectorAnswer`.
 */

import { z } from 'zod';

import { canonicalHash } from '@/ir/worlddoc';
import { EMISSION_MODEL, type UpstreamRequest } from '@/model/prompt';

import chaseEscape from '../__fixtures__/chase_escape.json';
import collectExit from '../__fixtures__/collect_exit.json';
import { ARCHETYPES, ARCHETYPE_IDS, MECHANICS, MECHANIC_IDS, type MechanicEntry } from '../registry';
import { GAME_SPEC_SCHEMA, gameSpecSchema, verificationSchema, type GameSpecV1 } from '../spec';

/** Doslova `docs/play/pack/director.md`; test drží shodu se souborem. */
export const DIRECTOR_RULES =
  'Return ONLY GameSpecV1. Use only supplied registry IDs. Never output code. Preserve explicit constraints. For vague prompts invent a coherent 45–180 second loop. One machine-checkable objective; <=2 losses; 2–4 core mechanics plus <=1 escalation. First meaningful action <=5s by design. Every requested mechanic gets a verification assertion. Infeasible requests preserve fantasy but substitute closest feasible registered mechanic.';

export const ANSWER_SHAPE_LINE = `Answer with a single JSON object matching ${GAME_SPEC_SCHEMA} and nothing else.`;

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

function compactExample(fixture: unknown): string {
  const { verification: _verification, ...rest } = fixture as GameSpecV1;
  return JSON.stringify(rest);
}

function renderShape(): string {
  const top = z.toJSONSchema(gameSpecSchema) as JsonSchema;
  const properties = top.properties as Record<string, JsonSchema>;
  const outline = Object.entries(properties)
    .filter(([key]) => key !== 'verification')
    .map(([key, value]) => `${key}: ${compactSchema(value)}`)
    .join('\n');
  return [
    'GAMESPEC SHAPE:',
    outline,
    'verification: list (1..20) of assertions, at least one keypoint per mechanic you use plus one reachability {runState: won}:',
    schemaOf(verificationSchema),
    'Keys in setup/assert maps are role ids or counter names from this spec. actions use the same verbs as the player: moveTo, pickup, use.',
  ].join('\n');
}

/** Systémový prompt bez věty. Stavěný při každém volání, aby změna registru prošla ven. */
export function directorSystemPrompt(): string {
  return [
    DIRECTOR_RULES,
    ANSWER_SHAPE_LINE,
    'Runtime is a tap-to-move grid: the player taps a target to walk there, picks items up and uses things next to them. Everything happens by walking, picking up and using; express any other fantasy through the registered mechanics.',
    'control: omit it for the grid above; if the starting point has control, keep it. Arcade controls keep archetype hazard_crossing and win at the finish. "runner" (endless runner, subway surfers): runs forward itself, tap = jump, swipe = lane or slide; roles player, obstacle, coin, finish; controlParams {speed, density, lengthM}. "platform" (platformer, mario, obby, jumping between platforms): arrows move, tap = jump; roles player, spikes, coin, finish; controlParams {difficulty, lengthM, movingPlatforms, checkpoints, doubleJump}. "flap" (flappy bird): flies forward, tap = flap through pipe gaps; roles player, pipe, coin, finish; controlParams {difficulty, lengthM}. "steer" (racing, fly a plane): roles player, barrier, rival, turbo, finish; controlParams {difficulty, lengthM, rivals, turbo, drift}. "move_free" (agar.io, eat smaller, grow): archetype survival_timer, timer onEnd lose = outgrow all in time, win = survive; roles player, hunter, coin; controlParams {density}.',
    renderRegistry(),
    renderShape(),
    'EXAMPLES (verification omitted for length; write it in full in your answer):',
    compactExample(collectExit),
    compactExample(chaseEscape),
    'Role ids and mechanic ids are lowercase words with underscores. Labels, title, descriptions and the tutorial are English and short. Keep the user\'s explicit numbers, names and constraints.',
  ].join('\n\n');
}

/** Hash systémového textu – klíč cache a otisk verze promptu. */
export const DIRECTOR_PROMPT_VERSION = canonicalHash(directorSystemPrompt());

export function buildDirectorRequest(sentence: string, draft: GameSpecV1): UpstreamRequest {
  return {
    model: EMISSION_MODEL,
    system: directorSystemPrompt(),
    user: `${sentence.trim()}\n\nStarting point (keep or improve): ${JSON.stringify(draft)}`,
  };
}
