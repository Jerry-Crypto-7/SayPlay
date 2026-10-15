/**
 * Director answer schema: recipe + named content, with legacy GenreSpec variants.
 * strictSchema turns optional fields into nullable required fields. All rule
 * schemas are inline: providers receive neither $ref nor $defs.
 */

import { z } from 'zod';

import { ABILITIES } from '../arcade/contract';
import { SEGMENT_NEWS } from '../arcade/pieces/pacing';
import { THINGS_MAX, logicSchema, modelRulesSchema, thingsSchema } from '../arcade/rules/schema';
import { COUNT_PARAMS, COUNT_ROLES, type CountRole, type GenreModule, genreSpecSchema, ruleRoleSchema } from '../genre/contract';
import { GENRE_MODULES, paramBoundsOf } from '../genre/index';
import { ROLE_KINDS } from '../spec';
import { recipeSchema } from '../compose/recipe';
import { glideCourseParams } from '../arcade/pieces/glide';
import { walkerParamsSchema } from '../arcade/pieces/walker';
import { ballParams } from '../arcade/pieces/ball';
import { arenaCatchParams } from '../arcade/pieces/arena-catch';
import { STEER_TRACK } from '../arcade/pieces/steer';

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Klíče, které přísný režim odmítne a pro model nic nenesou. */
const DROPPED = new Set(['$schema', 'default', 'propertyNames']);

/** zod JSON Schema → přísný režim OpenAI (viz hlavičku). */
export function strictSchema(node: Json): Json {
  if (Array.isArray(node.anyOf) || Array.isArray(node.oneOf)) {
    return { anyOf: ((node.anyOf ?? node.oneOf) as Json[]).map(strictSchema) };
  }
  if (node.const !== undefined) return { type: typeof node.const === 'number' ? 'number' : typeof node.const, enum: [node.const] };
  const out: Json = {};
  for (const [key, value] of Object.entries(node)) if (!DROPPED.has(key)) out[key] = value;
  // N-tice (`contact: [role, role]`) přísný režim nezná: pole stejných prvků s pevnou délkou.
  if (Array.isArray(out.prefixItems)) {
    const items = (out.prefixItems as Json[]).map(strictSchema);
    const same = items.every((item) => JSON.stringify(item) === JSON.stringify(items[0]));
    out.items = same ? items[0] : { anyOf: items };
    out.minItems = items.length;
    out.maxItems = items.length;
    delete out.prefixItems;
  } else if (out.type === 'array' && isObject(out.items)) out.items = strictSchema(out.items);
  if (out.type === 'object') {
    const properties = out.properties as Record<string, Json> | undefined;
    if (properties === undefined) {
      // Slovník: seznam dvojic.
      const value = isObject(out.additionalProperties) ? strictSchema(out.additionalProperties) : { type: 'string' };
      return { type: 'array', items: { type: 'object', additionalProperties: false, required: ['key', 'value'], properties: { key: { type: 'string' }, value } } };
    }
    const required = new Set((out.required as string[] | undefined) ?? []);
    out.properties = Object.fromEntries(
      Object.entries(properties).map(([key, value]) => {
        const strict = strictSchema(value);
        return [key, required.has(key) && value.default === undefined ? strict : { anyOf: [strict, { type: 'null' }] }];
      }),
    );
    out.required = Object.keys(properties);
    out.additionalProperties = false;
  }
  return out;
}

const toJson = (schema: z.ZodType): Json => z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any', reused: 'inline', cycles: 'throw' }) as Json;

/** Režimy žánru, které hrají, co slibují – jen ty režisér nabízí (P32B T4). */
export const readyModes = (module: GenreModule): string[] => module.modes.filter((mode) => module.availability(mode) === 'ready');

/**
 * Varianta `GenreSpec` pro režiséra (P32B T4): jen režimy `ready` a parametry
 * s mezemi modulu jako pojmenovaná pole, ne volný slovník. Od T5b i počty rolí
 * (B-R4) a pravidla P29A se svými rolemi (B-R5). Žánr bez hrajícího
 * režimu v odpovědi není; `null` = nic nenabízí.
 */
function genreVariant(module: GenreModule): Json | null {
  const modes = readyModes(module);
  if (modes.length === 0) return null;
  const base = genreSpecSchema.options.find((option) => option.shape.genre.value === module.id)!;
  // Parametry modulu a hloubky (P36A T8: životy, cílové skóre, časový limit).
  const bounds = Object.entries(paramBoundsOf(module));
  const params = z.object(Object.fromEntries(bounds.map(([key, range]) => [key, z.int().min(range.min).max(range.max).optional()]))).strict();
  const counts = countsOf(module, modes);
  const variant = bounds.length === 0 ? base.omit({ params: true }) : base.extend({ params: params.optional() });
  const counted = counts === null ? variant.omit({ counts: true }) : variant.extend({ counts: counts.optional() });
  const schema = strictSchema(toJson(counted.extend({ mode: z.enum(modes as [string, ...string[]]), ...MODEL_EXTRAS })));
  // Keep rule fields in place, but inline their provider-compatible schemas.
  const properties = schema.properties as Record<string, Json>;
  for (const key of Object.keys(RULE_DEFS)) properties[key] = { anyOf: [RULE_DEFS[key as keyof typeof RULE_DEFS], { type: 'null' }] };
  return schema;
}

/**
 * Meze novinek AI verze, jak je dostane model (P46E T3): nejvýš 2 akce a přesně 3 změny úseků. Čtečka
 * (`genreSpecSchema`) je volnější – víc akcí ořízne a neznámou změnu zahodí, místo aby odmítla celou odpověď.
 */
const MODEL_EXTRAS = {
  abilities: z.array(z.enum(ABILITIES)).max(2).optional(),
  segments: z.array(z.enum(SEGMENT_NEWS)).length(3).optional(),
};

/** Druhy rolí, které smí nést jen pravidla – hráče staví modul. */
const RULE_ROLE_KINDS = ROLE_KINDS.filter((kind) => kind !== 'player') as [string, ...string[]];

/** Shared construction source; emitted independently inside every variant. `logic` + its rule constructs since P45B T10. */
const RULE_DEFS: Readonly<Record<'ruleRoles' | 'things' | 'rules' | 'logic', Json>> = {
  ruleRoles: strictSchema(toJson(z.array(ruleRoleSchema.extend({ kind: z.enum(RULE_ROLE_KINDS) })).max(THINGS_MAX))),
  things: strictSchema(toJson(thingsSchema)),
  rules: strictSchema(toJson(modelRulesSchema)),
  logic: strictSchema(toJson(logicSchema)),
};

/**
 * Počty rolí, které žánr čte (B-R4): jen role, které některý režim `ready`
 * převádí na parametr (`COUNT_PARAMS`), s mezemi toho parametru – u dvou
 * režimů jejich sjednocením. Přesnou mez režimu hlídá `readGenreSpec`. `null` = žánr počty nečte.
 */
function countsOf(module: GenreModule, modes: readonly string[]): z.ZodObject | null {
  const table = COUNT_PARAMS[module.id] as Readonly<Record<string, Readonly<Partial<Record<CountRole, string>>> | undefined>>;
  const fields = COUNT_ROLES.flatMap((role) => {
    const ranges = modes.flatMap((mode) => {
      const key = table[mode]?.[role];
      return key === undefined ? [] : [module.paramBounds[key]!];
    });
    if (ranges.length === 0) return [];
    return [[role, z.int().min(Math.min(...ranges.map((range) => range.min))).max(Math.max(...ranges.map((range) => range.max))).optional()] as const];
  });
  return fields.length === 0 ? null : z.object(Object.fromEntries(fields)).strict();
}

/** Odpověď režiséra na novou hru: `{plan, spec}` se `GenreSpec`; hru z něj složí modul žánru (`readGenreAnswer`). */
/** Numeric parameter vocabulary and envelopes come from existing bounded modules. */
/** Native factories read these content fields, not legacy genre parameters. */
export const nativeRecipeParams = {
  catch: arenaCatchParams.pick({ half: true, preySpeed: true }).partial().extend({ seconds: arenaCatchParams.shape.catchSeconds.optional() }),
  drive: z.object({ roadWidth: z.int().min(3600).max(10000).optional(), roadEntryWidth: z.int().min(3600).max(10000).optional(), crashBudget: z.int().min(1).max(9).optional(), lengthM: z.int().min(STEER_TRACK.minLengthM).max(STEER_TRACK.maxLengthM).optional(), turbo: z.union([z.literal(0), z.literal(1)]).optional(), drift: z.union([z.literal(0), z.literal(1)]).optional(), grip: z.int().min(4).max(20).optional(), brakeDrift: z.int().min(4).max(20).optional() }).strict(),
  glide: glideCourseParams.pick({ lengthM: true, topSpeed: true, clearancePermille: true, clearanceRisePermille: true }).partial(),
  walk: walkerParamsSchema.pick({ size: true, speed: true, paceBudgetPct: true, corridorRisePermille: true }).partial().extend({ lives: z.int().min(1).max(9).optional() }),
  ball: ballParams.pick({ targets: true, shotRecoveryTicks: true, shotRecoveryRiseTicks: true, paceSeconds: true }).partial(),
} as const;
const recipeParamBounds = Object.values(GENRE_MODULES).reduce<Record<string, { min: number; max: number }>>((all, module) => {
  for (const [key, range] of Object.entries(paramBoundsOf(module as GenreModule))) {
    const old = all[key];
    all[key] = old === undefined ? range : { min: Math.min(old.min, range.min), max: Math.max(old.max, range.max) };
  }
  return all;
}, {});
// The model receives the union envelope; readRecipeContent enforces the exact
// selected factory's keys and bounds before the factory can clamp anything.
for (const schema of Object.values(nativeRecipeParams)) {
  const properties = toJson(schema).properties as Record<string, Json>;
  for (const [key, node] of Object.entries(properties)) {
    const range = { min: typeof node.minimum === 'number' ? node.minimum : 0, max: typeof node.maximum === 'number' ? node.maximum : 1 };
    const old = recipeParamBounds[key];
    recipeParamBounds[key] = old === undefined ? range : { min: Math.min(old.min, range.min), max: Math.max(old.max, range.max) };
  }
}
export const recipeParamsSchema = z.object(Object.fromEntries(Object.entries(recipeParamBounds).map(([key, range]) => [key, z.int().min(range.min).max(range.max).optional()]))).strict();
const contentShape = genreSpecSchema.options[0].omit({ genre: true, mode: true, params: true });
export const recipeAnswerSchema = contentShape.extend({
  recipe: recipeSchema,
  params: recipeParamsSchema.optional(),
  unmet: z.array(z.object({ actor: z.string().min(1).max(60), verb: z.string().min(1).max(40), object: z.string().min(1).max(60).nullable() }).strict()).max(64),
}).strict();
export type RecipeAnswer = z.infer<typeof recipeAnswerSchema>;

export const GENRE_ANSWER_SCHEMA: Json = {
  type: 'object',
  additionalProperties: false,
  required: ['plan', 'spec'],
  properties: {
    plan: { type: 'string' },
    spec: { anyOf: [strictSchema(toJson(recipeAnswerSchema.extend(MODEL_EXTRAS))), ...(Object.values(GENRE_MODULES) as GenreModule[]).flatMap((module) => genreVariant(module) ?? [])] },
  },
};
