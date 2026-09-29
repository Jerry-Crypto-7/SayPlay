/**
 * Schéma odpovědi režiséra pro `codex exec --output-schema` (P26 T6).
 *
 * Odpověď je `{plan, spec}`: volné pole `plan` pro úvahu stojí před specem,
 * protože přísné schéma bez místa na úvahu zhoršuje přemýšlení („Let Me Speak
 * Freely“). `spec` je unie – jedna varianta na ovládání a v ní jen to, co
 * tabulka schopností (`capabilities.ts`) dovolí: arkáda jen mechaniky, které
 * hraje, svoje `controlParams` a žádné `verification` (ověřuje robot).
 *
 * Přísný režim OpenAI chce u každého objektu všechna pole v `required`,
 * `additionalProperties: false`, u každého uzlu `type` a nezná volné slovníky.
 * `strictSchema` proto: volitelné pole → „nebo null“, konstantu → výčet,
 * slovník → seznam dvojic `{key, value}`. `unwrapAnswer` v `read.ts` to vrací
 * zpátky, takže `readGameSpec` vidí obyčejný spec.
 */

import { z } from 'zod';

import { modelRulesSchema } from '../arcade/rules/schema';
import { CAPABILITIES } from '../capabilities';
import { MECHANICS, MECHANIC_IDS, type MechanicEntry, type MechanicId } from '../registry';
import { CONTROLS, CONTROL_PARAMS, gameSpecSchema, themeSchema, type ControlId } from '../spec';

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
      // Slovník: seznam dvojic, `unwrapAnswer` z něj udělá zpátky objekt.
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

function mechanicsOf(control: ControlId): z.ZodType {
  const plays = CAPABILITIES[control].mechanics;
  const ids = plays === 'all' ? MECHANIC_IDS : MECHANIC_IDS.filter((id) => plays.includes(id));
  const entries = ids.map((id: MechanicId) => z.object({ id: z.literal(id), params: (MECHANICS[id] as MechanicEntry<unknown>).params as z.ZodType }).strict());
  return z.array(entries.length === 1 ? entries[0] : z.union(entries as unknown as [z.ZodType, z.ZodType, ...z.ZodType[]])).max(5);
}

/** Spec, jak ho píše model: pravidla bez pahýlu `interact` (`modelRulesSchema`). */
const modelSpecSchema = gameSpecSchema.extend({ rules: modelRulesSchema.optional() });

function variant(control: ControlId): z.ZodType {
  // `theme` bez počasí sdílené verze (P29D T10) – to model nepíše.
  // `genre` (P32) zapisuje překlad žánru, ne model – dokud režisér píše GameSpec, v odpovědi není.
  if (control === 'tap_go') return modelSpecSchema.omit({ controlParams: true, genre: true }).extend({ control: z.literal('tap_go'), theme: themeSchema, mechanics: mechanicsOf(control) });
  return modelSpecSchema.omit({ verification: true, genre: true }).extend({
    control: z.literal(control),
    theme: themeSchema,
    controlParams: CONTROL_PARAMS[control] as z.ZodType,
    mechanics: mechanicsOf(control),
  });
}

/** Celé schéma odpovědi; staví se jednou, registr se za běhu nemění. */
export const DIRECTOR_ANSWER_SCHEMA: Json = {
  type: 'object',
  additionalProperties: false,
  required: ['plan', 'spec'],
  properties: {
    plan: { type: 'string' },
    spec: { anyOf: CONTROLS.map((control) => strictSchema(toJson(variant(control)))) },
  },
};
