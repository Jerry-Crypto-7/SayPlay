/**
 * Schéma odpovědi režiséra pro `codex exec --output-schema` (P26 T6, na
 * žánrech od P32B T4).
 *
 * Odpověď je `{plan, spec}`: volné pole `plan` pro úvahu stojí před specem,
 * protože přísné schéma bez místa na úvahu zhoršuje přemýšlení („Let Me Speak
 * Freely“). `spec` je `GenreSpec` – unie, jedna varianta na žánr a v ní jen
 * režimy `ready` a parametry s mezemi modulu. Hru z něj složí modul žánru
 * (`readGenreAnswer` v `read.ts`).
 *
 * Přísný režim OpenAI chce u každého objektu všechna pole v `required`,
 * `additionalProperties: false`, u každého uzlu `type` a nezná volné slovníky.
 * `strictSchema` proto: volitelné pole → „nebo null“, konstantu → výčet,
 * slovník → seznam dvojic `{key, value}`. `readGenreAnswer` pole `null` zahodí.
 *
 * Gramatika pravidel je ve všech žánrech stejná, a tak ji schéma nese jednou
 * v `$defs` kořene a žánry na ni odkazují (P36A T7).
 */

import { z } from 'zod';

import { THINGS_MAX, modelRulesSchema, thingsSchema } from '../arcade/rules/schema';
import { COUNT_PARAMS, COUNT_ROLES, type CountRole, type GenreModule, genreSpecSchema, ruleRoleSchema } from '../genre/contract';
import { GENRE_MODULES, paramBoundsOf } from '../genre/index';
import { ROLE_KINDS } from '../spec';

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

const toJson = (schema: z.ZodType): Json => z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as Json;

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
  const schema = strictSchema(toJson(counted.extend({ mode: z.enum(modes as [string, ...string[]]) })));
  // Pole zůstane na svém místě (pořadí polí drží i gramatika llama.cpp), obsah je odkaz do `$defs`.
  const properties = schema.properties as Record<string, Json>;
  for (const key of Object.keys(RULE_DEFS)) properties[key] = { anyOf: [{ $ref: `#/$defs/${key}` }, { type: 'null' }] };
  return schema;
}

/** Druhy rolí, které smí nést jen pravidla – hráče staví modul. */
const RULE_ROLE_KINDS = ROLE_KINDS.filter((kind) => kind !== 'player') as [string, ...string[]];

/**
 * Pravidla P29A s jejich rolemi a doplňky (B-R5), jednou pro všechny žánry
 * (P36A T7): dřív je nesla každá varianta zvlášť, 5× po 6 KB. `$defs` v kořeni
 * a `$ref` bez sourozenců bere přísný režim OpenAI (i `codex --output-schema`)
 * a Groq; llama.cpp odkaz `#/$defs/…` rozbalí při převodu na gramatiku.
 */
const RULE_DEFS: Readonly<Record<'ruleRoles' | 'things' | 'rules', Json>> = {
  ruleRoles: strictSchema(toJson(z.array(ruleRoleSchema.extend({ kind: z.enum(RULE_ROLE_KINDS) })).max(THINGS_MAX))),
  things: strictSchema(toJson(thingsSchema)),
  rules: strictSchema(toJson(modelRulesSchema)),
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
export const GENRE_ANSWER_SCHEMA: Json = {
  type: 'object',
  additionalProperties: false,
  required: ['plan', 'spec'],
  properties: {
    plan: { type: 'string' },
    spec: { anyOf: (Object.values(GENRE_MODULES) as GenreModule[]).flatMap((module) => genreVariant(module) ?? []) },
  },
  $defs: RULE_DEFS,
};
