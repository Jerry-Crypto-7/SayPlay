/**
 * Dávka katalogu (P37-0 T4): modely, které výroba (`ops/gen3d`) vyrobila
 * a zkontrolovala, ve tvaru, který stopa knihovny píše a stopa sloves čte.
 * Popis polí pro čtenáře zvenku: `docs/play/catalog-batch.md`.
 *
 * Soubor přichází z disku, takže `readBatch` soudí celý tvar a vrací verdikt,
 * ne výjimku – jako `readGameSpec`.
 */

import { readFileSync } from 'node:fs';

import { z } from 'zod';

export const CATALOG_BATCH_SCHEMA = 'catalog-batch.v1' as const;

const glb = z.string().regex(/\.glb$/, 'a .glb file');

export const batchEntrySchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9-]*$/),
    /** Slova věty, která model jmenují (malými písmeny, jednotné číslo; víceslovné „alien bug“ smí). */
    nouns: z.array(z.string().regex(/^[a-z][a-z -]*$/)).min(1),
    glb,
    lod1: glb.optional(),
    /** Rozměr v jednotkách GLB (x, y, z) v klidové póze, jako `dims` v manifestu. */
    bounds: z.tuple([z.number().positive(), z.number().positive(), z.number().positive()]),
    /** Barvy modelu po stylizaci (`ops/gen3d/palette.py`). */
    palette: z.array(z.string().regex(/^#[0-9a-f]{6}$/)).min(1).max(16),
    source: z
      .object({
        pipeline: z.string().min(1),
        imageModel: z.string().min(1),
        shapeModel: z.string().min(1),
        seed: z.int().min(0),
      })
      .strict(),
    licence: z.string().min(1),
    /** Kdo model slepě soudil a jak dopadl; `fail` do katalogu nejde. */
    checked: z.object({ judge: z.string().min(1), verdict: z.enum(['pass', 'fail']) }).strict(),
  })
  .strict();
export type BatchEntry = z.infer<typeof batchEntrySchema>;

export const catalogBatchSchema = z
  .object({
    schema: z.literal(CATALOG_BATCH_SCHEMA),
    entries: z
      .array(batchEntrySchema)
      .min(1)
      .refine((entries) => new Set(entries.map((entry) => entry.id)).size === entries.length, 'entry ids must be unique'),
  })
  .strict();
export type CatalogBatch = z.infer<typeof catalogBatchSchema>;

export type BatchResult = { readonly ok: true; readonly batch: CatalogBatch } | { readonly ok: false; readonly issues: readonly string[] };

export function readBatch(path: string): BatchResult {
  const parsed = catalogBatchSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')));
  return parsed.success
    ? { ok: true, batch: parsed.data }
    : { ok: false, issues: parsed.error.issues.map((issue) => `/${issue.path.join('/')}: ${issue.message}`) };
}
