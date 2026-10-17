/**
 * Uložené hry před P51 (T2): specy vět dev sady P51, jak je uložila verze `genre.v4`
 * (`__fixtures__/stored-v4-p51.measure.ts` nad `04700849`), staví bajtově týž svět na
 * semínkách 1–3. Žánry bez `genre` (chodec, klouzání, míč, chytání) jsou uložené hry
 * bez značky nové hry. Každá změna světa v P51 platí jen pro nové hry.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';

import { arcadeWorldOf } from '../compile';
import { loadRapier } from '../physics/world';
import { FINALE5_GENRE_VERSION, genreAtLeast } from '../pieces/pacing-parts';
import type { GameSpecV1 } from '@/play/spec';

/** Táž semínka a týž otisk jako generátor fixtury (ten se neimportuje – jeho `it` by fixturu přepsal). */
const STORED_V4_SEEDS = [1, 2, 3] as const;
const worldPrint = (world: unknown): string => createHash('sha256').update(JSON.stringify(world)).digest('hex').slice(0, 16);

const STORED: Readonly<Record<string, { readonly spec: GameSpecV1; readonly worlds: Readonly<Record<string, string>> }>> = JSON.parse(
  readFileSync(join(__dirname, '__fixtures__', 'stored-v4-p51.json'), 'utf8'),
);

beforeAll(async () => {
  await loadRapier();
});

describe('stored genre.v4 games of the P51 genres build the same world', () => {
  it('covers all 30 dev sentences and none of them is a genre.v5 game', () => {
    expect(Object.keys(STORED)).toHaveLength(30);
    for (const [id, { spec }] of Object.entries(STORED)) expect(genreAtLeast(spec, FINALE5_GENRE_VERSION), id).toBe(false);
  });

  for (const [id, { spec, worlds }] of Object.entries(STORED)) {
    it(`${id}: seeds ${STORED_V4_SEEDS.join(', ')}`, () => {
      for (const seed of STORED_V4_SEEDS) {
        const made = arcadeWorldOf(spec, seed);
        expect(made.ok ? worldPrint(made.world) : `issues: ${made.issues.join('; ')}`, `${id} seed ${seed}`).toBe(worlds[seed]);
      }
    });
  }
});
