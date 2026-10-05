/**
 * Čtení věty lokálním modelem (P29B T2) – co model z věty vyčetl, dřív než
 * se staví draft. Dnes to dělají regulární výrazy (`draft/lexicon.ts`,
 * `draft/controls.ts`); `Reading` je jejich náhrada tam, kde model odpoví.
 *
 * Všechna pole jsou povinná a „nic“ je `null` nebo prázdný seznam: llama.cpp
 * z JSON Schema staví gramatiku a volitelné klíče by modelu dovolily je
 * vynechat bez rozhodnutí.
 */

import { z } from 'zod';

import { CONTROLS } from '../spec';

/**
 * Třídy slovesa – legenda ručních štítků `evals/play/demand/labels.json`.
 * Širší než `CONTROLS`: jmenuje i slovesa, která hra ještě neumí
 * (`manipulate`, `build_place`…), aby měření poznalo, co čtečka pochopila.
 */
export const VERB_CLASSES = [
  'tap_go', 'runner', 'platform', 'flap', 'steer', 'aim_shoot', 'throw', 'timing',
  'rhythm', 'melee', 'move_free', 'manipulate', 'build_place', 'idle', 'sandbox',
] as const;
export type VerbClass = (typeof VERB_CLASSES)[number];

/** Co role ve hře dělá; odpovídá rolím, které dnes vyčítá `readRoles`. */
export const ROLE_KINDS = ['collectible', 'target', 'threat', 'chaser', 'hazard', 'obstacle', 'destination', 'item', 'ally'] as const;
export type RoleKind = (typeof ROLE_KINDS)[number];

const word = z.string().min(1).max(40);

export const readingSchema = z
  .object({
    /** Ovládání, které nejlíp hraje hlavní sloveso věty. */
    control: z.enum(CONTROLS),
    /** Slovesa věty v pořadí důležitosti; první je hlavní. */
    verbs: z.array(z.object({ word, class: z.enum(VERB_CLASSES) }).strict()).max(4),
    /** Za koho hráč hraje, 1–3 slova z věty. */
    hero: word.nullable(),
    roles: z
      .array(z.object({ noun: word, kind: z.enum(ROLE_KINDS), count: z.int().min(1).max(99).nullable() }).strict())
      .max(6),
    setting: z.string().min(1).max(80).nullable(),
    mood: word.nullable(),
    numbers: z.object({ seconds: z.int().min(1).max(3600).nullable(), counts: z.array(z.int().min(1).max(999)).max(6) }).strict(),
  })
  .strict();
export type Reading = z.infer<typeof readingSchema>;

/** JSON Schema pro `response_format` llama.cpp; staví se jednou ze zod. */
export const READING_JSON_SCHEMA: Record<string, unknown> = (() => {
  const { $schema: _drop, ...schema } = z.toJSONSchema(readingSchema, { io: 'input' }) as Record<string, unknown>;
  return schema;
})();
