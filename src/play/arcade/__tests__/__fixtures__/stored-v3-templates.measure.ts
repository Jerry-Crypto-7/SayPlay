/**
 * Generátor fixtury `stored-v3-templates.json` (P47A T2): specy rychlého návrhu, jak je uložila verze `genre.v3`
 * (tip P46 `abe38f04`) – s overlay šablonou P45B. Pouští se jen nad kódem `abe38f04`; nová verze by zapsala
 * spec `genre.v4`, a ten už uložená hra není.
 *
 * `npx vitest run --config vitest.measure.mts src/play/arcade/__tests__/__fixtures__/stored-v3-templates.measure.ts`
 */

import { writeFileSync } from 'node:fs';

import { expect, it } from 'vitest';

import { loadRapier } from '@/play/arcade/physics/world';
import { draftGameSpecWithMeta } from '@/play/draft';
import { GENRE_COMPILER_VERSION } from '@/play/genre/contract';

/** Po jedné větě dev sady P47A na šablonu a generátor. */
export const STORED_V3_SENTENCES = [
  'Grab every gem in a cave while bats swoop at you',
  'Pick up glowing mushrooms in a dark forest and avoid the wolves',
  'Collect three keys in a pyramid while mummies chase you',
  'Survive a horde of skeletons in a graveyard until sunrise',
  'A lighthouse keeper lights every lamp along the stormy coast',
] as const;

it('freezes the genre.v3 specs with their overlay templates', async () => {
  expect(GENRE_COMPILER_VERSION).toBe('genre.v3');
  await loadRapier();
  const specs = Object.fromEntries(STORED_V3_SENTENCES.map((text) => [text, draftGameSpecWithMeta(text, 1).spec]));
  writeFileSync('src/play/arcade/__tests__/__fixtures__/stored-v3-templates.json', `${JSON.stringify(specs, null, 1)}\n`);
});
