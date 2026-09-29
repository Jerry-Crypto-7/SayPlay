/**
 * Prompt režiséra (P23-B T3, na žánrech od P32B T4): model píše `GenreSpec` –
 * žánr, režim, role a prostředí – a hru z něj složí modul žánru. Nabídka
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
import type { GenreModule, GenreSpec } from '../genre/contract';
import { GENRE_MODULES } from '../genre/index';
import { ARCHETYPES, ARCHETYPE_IDS, MECHANICS, MECHANIC_IDS, type MechanicEntry } from '../registry';

import { GENRE_ANSWER_SCHEMA, readyModes } from './answer-schema';

/** Úvod plného promptu; kompaktní má vlastní kratší. */
export const GENRE_RULES =
  'Return ONLY a GenreSpec: pick the genre and mode the sentence plays and name its roles with the sentence\'s nouns; the game is built from it. Never output code. Answer {plan, spec}: plan = one short line of reasoning.';

export const GENRE_SHAPE_LINE =
  'spec: {genre, mode, hero: string<=60, enemy?: string<=60, collectible?: string<=60, target?: {label: string<=60, verb: string<=24, states: 2|3}, setting: string<=80, palette?, params?}; a missing optional field is null.';

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
    return [`- ${module.id} (${module.cues.join(', ')}): modes ${modes.join('|')}; hero ${module.heroClasses.join('/')}${params.length === 0 ? '' : `; params ${params.join(', ')}`}`];
  });
  return [
    'GENRES (cues; modes; what the hero can be; params):',
    ...genres,
    'genre and mode: the ones whose cues fit the main verb – the verb that carries the goal or the win. A task (light, fight, land) beats moving (run, sail, jump), moving beats collecting, collecting beats escaping.',
    'hero: the 1–3 word English noun the player is ("pirate ship", "wizard"). It must be a kind the genre lists (a ship sails, a car drives); if it cannot be, pick the genre it can play.',
    'enemy: the chaser, threat or rival the sentence names. collectible: what the player gathers. target {label, verb, states}: what the main verb acts on ("light" a "candle"). Null when the sentence names none – the game then picks one from the setting.',
    `setting: where it happens, <=80 chars. palette: the scene set that best shows it, or null: ${LOOK_IDS.join('|')}. params: only for a number the sentence says, else null.`,
    "Keep the user's nouns, numbers and names. Improve the starting point, do not copy it blindly.",
  ].join('\n');
}

/** Systémový prompt bez věty. Stavěný při každém volání, aby změna modulu prošla ven. */
export function directorSystemPrompt(): string {
  return [GENRE_RULES, GENRE_SHAPE_LINE, genrePromptLines()].join('\n\n');
}

/** Hash systémového textu – klíč cache a otisk verze promptu. */
export const DIRECTOR_PROMPT_VERSION = canonicalHash(directorSystemPrompt());

/** Návrh ze slov jako výchozí bod; hra bez žánru (mřížka archetypu) žádný nedá. */
export function startingPoint(draft: GenreSpec | null): string {
  return draft === null ? 'Starting point: none – choose from the sentence.' : `Starting point (keep or improve): ${JSON.stringify(draft)}`;
}

export function buildDirectorRequest(sentence: string, draft: GenreSpec | null): UpstreamRequest {
  return {
    model: EMISSION_MODEL,
    system: directorSystemPrompt(),
    user: `${sentence.trim()}\n\n${startingPoint(draft)}`,
    outputSchema: GENRE_ANSWER_SCHEMA,
  };
}
