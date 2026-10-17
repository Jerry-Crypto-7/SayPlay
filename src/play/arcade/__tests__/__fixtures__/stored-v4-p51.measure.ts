/**
 * Generátor fixtury `stored-v4-p51.json` (P51 T2): specy rychlého návrhu vět dev sady P51, jak je uložila
 * verze `genre.v4` (`origin/main` `04700849`), a otisk jejich světa na semínkách 1–3. Žánry bez `genre`
 * (chodec, klouzání, míč, chytání) jsou uložené hry bez značky nové hry. Pouští se jen nad kódem `genre.v4`;
 * nová verze by zapsala spec `genre.v5`, a ten už uložená hra není.
 *
 * `npx vitest run --config vitest.measure.mts src/play/arcade/__tests__/__fixtures__/stored-v4-p51.measure.ts`
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

import { expect, it } from 'vitest';

import { arcadeWorldOf } from '@/play/arcade/compile';
import { loadRapier } from '@/play/arcade/physics/world';
import { draftGameSpecWithMeta } from '@/play/draft';
import { GENRE_COMPILER_VERSION } from '@/play/genre/contract';

/** Táž semínka a týž otisk čte `../p51-stored-v4.test.ts`. */
const STORED_V4_SEEDS = [1, 2, 3] as const;

/** Otisk světa: SHA-256 nad JSON světa, prvních 16 znaků (vzor `pacing-template.test.ts`). */
const worldPrint = (world: unknown): string => createHash('sha256').update(JSON.stringify(world)).digest('hex').slice(0, 16);

it('freezes the genre.v4 specs of the P51 dev set and their worlds', async () => {
  expect(GENRE_COMPILER_VERSION).toBe('genre.v4');
  await loadRapier();
  const dev = (JSON.parse(readFileSync('evals/play/p51/dev.json', 'utf8')) as { sentences: { id: string; text: string }[] }).sentences;
  const stored = Object.fromEntries(dev.map(({ id, text }) => {
    const { spec } = draftGameSpecWithMeta(text, 1);
    const worlds = Object.fromEntries(STORED_V4_SEEDS.map((seed) => {
      const made = arcadeWorldOf(spec, seed);
      return [seed, made.ok ? worldPrint(made.world) : `issues: ${made.issues.join('; ')}`];
    }));
    return [id, { spec, worlds }];
  }));
  writeFileSync('src/play/arcade/__tests__/__fixtures__/stored-v4-p51.json', `${JSON.stringify(stored, null, 1)}\n`);
});
