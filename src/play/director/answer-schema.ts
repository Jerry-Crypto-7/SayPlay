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
 */

import { z } from 'zod';

import { type GenreModule, genreSpecSchema } from '../genre/contract';
import { GENRE_MODULES } from '../genre/index';

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
 * s mezemi modulu jako pojmenovaná pole, ne volný slovník. Žánr bez hrajícího
 * režimu v odpovědi není; `null` = nic nenabízí.
 */
function genreVariant(module: GenreModule): Json | null {
  const modes = readyModes(module);
  if (modes.length === 0) return null;
  const base = genreSpecSchema.options.find((option) => option.shape.genre.value === module.id)!;
  const bounds = Object.entries(module.paramBounds);
  const params = z.object(Object.fromEntries(bounds.map(([key, range]) => [key, z.int().min(range.min).max(range.max).optional()]))).strict();
  const variant = bounds.length === 0 ? base.omit({ params: true }) : base.extend({ params: params.optional() });
  return strictSchema(toJson(variant.extend({ mode: z.enum(modes as [string, ...string[]]) })));
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
};
