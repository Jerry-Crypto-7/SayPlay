/**
 * P83A T3: zapečetěná sada P30 (`evals/play/p30/test-200.json`) – sběr bez počtu (`arena.collect`) a jestli ho
 * dveře publikace pustí (`playabilityIssues` na semínkách dveří: svět se přeloží a robot vyhraje). Ostatní věty
 * mají spec beze změny. Běh před a po `FIRST_MINUTE` se porovná po řádcích; `first` = věta dostala 8 věcí a 5 životů.
 *
 *   node --experimental-strip-types --no-warnings --import ./scripts/ts-paths.mjs evals/play/p83/a-heldout.ts
 */

import { readFileSync } from 'node:fs';

import { derivedSeeds, playabilityIssues, seedFrom } from '@/app/api/play/_publish';
import { loadRapier } from '@/play/arcade/physics/world';
import { draftGameSpecWithMeta } from '@/play/draft';

const { sentences } = JSON.parse(readFileSync('evals/play/p30/test-200.json', 'utf8')) as { sentences: { id: string; text: string }[] };

await loadRapier();
let collect = 0;
let first = 0;
let publishable = 0;
for (const { id, text } of sentences) {
  const spec = draftGameSpecWithMeta(text, 1).spec;
  if (spec.genre?.id !== 'arena' || spec.genre.mode !== 'collect') continue;
  collect += 1;
  const tuning = spec.controlParams?.tuning as { items?: number; calm?: true } | undefined;
  const eased = tuning?.calm === true;
  if (eased) first += 1;
  const issues = playabilityIssues(spec, derivedSeeds(seedFrom(text.trim())));
  if (issues.length === 0) publishable += 1;
  console.log(id, eased ? 'first' : '-', `items ${String(tuning?.items)}`, issues.length === 0 ? 'publishable' : `NOT ${issues.map((issue) => issue.code).join(',')}`);
}
console.log(JSON.stringify({ sentences: sentences.length, collect, first, publishable }));
