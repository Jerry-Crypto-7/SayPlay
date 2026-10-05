/**
 * Dávka katalogu (P37-0 T4): platná fixtura projde celá, dávka bez licence
 * neprojde a důvod ukáže na pole – stopa knihovny podle něj opraví záznam.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { catalogBatchSchema, readBatch } from '../batch';

const fixture = (name: string): string => join(process.cwd(), 'src/play/assets/__fixtures__', `${name}.json`);

describe('readBatch (P37-0 T4)', () => {
  it('reads a valid batch with and without a LOD1', () => {
    const read = readBatch(fixture('batch-valid'));
    if (!read.ok) throw new Error(read.issues.join('; '));
    expect(read.batch.entries.map((entry) => [entry.id, entry.lod1 !== undefined, entry.checked.verdict])).toEqual([
      ['acorn', true, 'pass'],
      ['alien-bug', false, 'fail'],
    ]);
  });

  it('refuses an entry without a licence and names the field', () => {
    const read = readBatch(fixture('batch-no-licence'));
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.issues).toEqual(['/entries/0/licence: Invalid input: expected string, received undefined']);
  });

  const valid = (): { schema: string; entries: Record<string, unknown>[] } => JSON.parse(readFileSync(fixture('batch-valid'), 'utf8'));

  it('refuses two entries with the same id', () => {
    const batch = valid();
    batch.entries[1] = { ...batch.entries[1], id: batch.entries[0].id };
    const parsed = catalogBatchSchema.safeParse(batch);
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.map((issue) => [issue.path.join('/'), issue.message])).toEqual([['entries', 'entry ids must be unique']]);
  });

  it('refuses an entry with a key the schema does not know', () => {
    const batch = valid();
    batch.entries[0] = { ...batch.entries[0], tags: ['food'] };
    const parsed = catalogBatchSchema.safeParse(batch);
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.map((issue) => [issue.path.join('/'), issue.code])).toEqual([['entries/0', 'unrecognized_keys']]);
  });
});
