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

import { LOOK_IDS } from '../arcade/look';
import type { GenreId, GenreMode, GenreModule } from '../genre/contract';
import { GENRE_MODULES } from '../genre/modules';
import { READ_CONTROLS } from '../spec';

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

/**
 * Živé žánry, které čtečka zatím nejmenuje – jako `DIRECTOR_PENDING` u režiséra: bez řádku popisu v promptu čtečky by
 * je model volil naslepo a schéma odpovědi by se pohnulo dřív než prompt. P66 T12 pustil pět nových žánrů do rychlé
 * hry, P66 T13 je čtečce popsal (`MODE_HINTS`). P68 T1 (brána aktivace): pět her P68 – kategorie smí modul přepnout
 * na `ready`, čtečka ho uvidí, až ho odsud odebere úloha „zapoj X“ v P68-I (spolu s `ROUTE_PENDING` a `DIRECTOR_PENDING`). T11 pustil `buildshift` jen do rychlé hry; čtečka a režisér
 * ho dostanou spolu (R5 v plánu P68-I), řádek `MODE_HINTS` je připravený. R7 pustil `drawsave` (zapojený v T12).
 */
export const READER_PENDING: ReadonlySet<string> = new Set<string>(['stunt', 'minigolf', 'railfps', 'buildshift']);

/** Režimy, které hrají (`availability = 'ready'`), po žánrech – jen ty smí čtečka jmenovat (P56A T3). */
export const READY_GENRE_MODES: readonly { readonly genre: GenreModule['id']; readonly modes: readonly [string, ...string[]] }[] = (Object.values(GENRE_MODULES) as GenreModule[])
  .map((module) => ({ genre: module.id, modes: READER_PENDING.has(module.id) ? [] : (module.modes.filter((mode) => module.availability(mode) === 'ready') as string[]) }))
  .filter((entry): entry is { genre: GenreModule['id']; modes: [string, ...string[]] } => entry.modes.length > 0);

/**
 * Žánr a režim jako jedna z dvojic, které hrají: `anyOf` objektů, ne dva nezávislé výčty – gramatika llama.cpp ani
 * `strict` u Groq tak dvojici, která neexistuje („runner.stack“), nepustí.
 */
const genreChoice = z.union(
  READY_GENRE_MODES.map(({ genre, modes }) => z.object({ genre: z.literal(genre), mode: z.enum(modes) }).strict()) as unknown as readonly [z.ZodObject, z.ZodObject, ...z.ZodObject[]],
) as unknown as z.ZodType<{ genre: GenreId; mode: GenreMode }>;

export const readingSchema = z
  .object({
    /** Ovládání, které nejlíp hraje hlavní sloveso věty. */
    control: z.enum(READ_CONTROLS),
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
    /** P56A T3: hra, kterou věta chce – žánr a režim, nebo `null`, když žádný nesedí. */
    genre: genreChoice.nullable(),
    /**
     * P58B T5: `false`, když věta sedí na dva řádky žánru zhruba stejně nebo čtečka hádá – pak rozhodne slovník, slyší-li
     * něco (`classifyGenre`). Hned za `genre`, ať ho model píše s žánrem v hlavě.
     */
    sure: z.boolean(),
    /** S kým nebo čím hrdina bojuje, před čím utíká nebo čemu se vyhýbá; 1–3 slova z věty. */
    foe: word.nullable(),
    /** Věc, se kterou hrdina hlavně pracuje (sbírá, hází, chrání). */
    item: word.nullable(),
    /** Sada vzhledu (`LOOK_IDS`), které místo věty odpovídá. */
    world: z.enum(LOOK_IDS).nullable(),
    /** Krátký název hry ze slov věty. */
    title: z.string().min(1).max(32).nullable(),
  })
  .strict();
export type Reading = z.infer<typeof readingSchema>;

/** JSON Schema pro `response_format` llama.cpp; staví se jednou ze zod. */
export const READING_JSON_SCHEMA: Record<string, unknown> = (() => {
  const { $schema: _drop, ...schema } = z.toJSONSchema(readingSchema, { io: 'input' }) as Record<string, unknown>;
  return schema;
})();
