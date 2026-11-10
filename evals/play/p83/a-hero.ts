/**
 * P83A T4: hrdina místo budovy. Dvanáct vět „místo + činnost“ (psaných před opravou) a zapečetěná sada P30 – kdo je
 * hrdina a kde se hraje. S cestou souboru zapíše řádky `id<TAB>hrdina<TAB>místo` pro porovnání před a po opravě.
 *
 *   node --experimental-strip-types --no-warnings --import ./scripts/ts-paths.mjs evals/play/p83/a-hero.ts [out.tsv]
 */

import { readFileSync, writeFileSync } from 'node:fs';

import { loadRapier } from '@/play/arcade/physics/world';
import { draftGameSpecWithMeta } from '@/play/draft';

/** Věta o místě a činnosti; hrdinou má být postava, ne budova. */
export const PLACE_SENTENCES = [
  'A small shop where I pick up three items and put them on the counter to see the total price',
  'A library where I find lost books before closing time',
  'A castle where you defend the gate from goblins',
  'A bakery where I catch falling donuts',
  'A small shop where customers grab apples from the shelves',
  'A library where a librarian collects scattered books',
  'A castle where a knight fights skeletons in the courtyard',
  'A haunted house where I collect candles and avoid ghosts',
  'A farm where I gather eggs while foxes sneak around',
  'A museum where a guard catches thieves at night',
  'A school where I dodge paper planes',
  'A hospital where a doctor collects pills',
] as const;

export function heroOf(sentence: string): { hero: string; setting: string; look: string } {
  const { genre, spec } = draftGameSpecWithMeta(sentence, 1);
  return { hero: genre?.hero ?? '-', setting: genre?.setting ?? '-', look: genre?.palette ?? spec.theme.look ?? '-' };
}

if (process.argv[1]?.endsWith('a-hero.ts')) {
  await loadRapier();
  for (const sentence of PLACE_SENTENCES) console.log(JSON.stringify({ sentence: sentence.slice(0, 44), ...heroOf(sentence) }));
  const out = process.argv[2];
  if (out !== undefined) {
    const { sentences: heldOut } = JSON.parse(readFileSync('evals/play/p30/test-200.json', 'utf8')) as { sentences: { id: string; text: string }[] };
    const sentences = [...PLACE_SENTENCES.map((text, k) => ({ id: `p${String(k + 1).padStart(2, '0')}`, text })), ...heldOut];
    writeFileSync(out, sentences.map(({ id, text }) => { const { hero, setting, look } = heroOf(text); return `${id}\t${hero}\t${setting}\t${look}\t${text}`; }).join('\n') + '\n');
  }
}
