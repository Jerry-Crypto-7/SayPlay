/**
 * P83A T3: věta sady P37A (`evals/play/p37a/dev-150.json`, id v argumentu) na prvních 4 semínkách dveří – ladění,
 * životy, pravidla šablony a verdikt robota i nečinného hráče. Robot u34 („A raccoon scrubs … dishes“) s 8 věcmi
 * ve vlně prohrál všechna semínka; tím se měří, jestli úleva první minuty nerozbila hratelnost.
 *
 *   node --experimental-strip-types --no-warnings --import ./scripts/ts-paths.mjs evals/play/p83/a-seeds.ts u34
 */
import { readFileSync } from 'node:fs';

import { derivedSeeds, seedFrom } from '@/app/api/play/_publish';
import { arcadeWorldOf } from '@/play/arcade/compile';
import { loadRapier } from '@/play/arcade/physics/world';
import { verifyArcade } from '@/play/arcade/verify';
import { draftGameSpecWithMeta } from '@/play/draft';

await loadRapier();
const { sentences } = JSON.parse(readFileSync('evals/play/p37a/dev-150.json', 'utf8')) as { sentences: { id: string; text: string }[] };
const text = sentences.find((s) => s.id === (process.argv[2] ?? 'u34'))!.text;
const spec = draftGameSpecWithMeta(text, 1).spec;
console.log(text, JSON.stringify(spec.controlParams?.tuning), JSON.stringify(spec.mechanics), (spec.rules ?? []).map((r) => r.id).join(' '));
for (const seed of [...derivedSeeds(seedFrom(text.trim()))].slice(0, 4)) {
  const made = arcadeWorldOf(spec, seed);
  if (!made.ok) { console.log(seed, 'not ok', JSON.stringify(made).slice(0, 200)); continue; }
  const v = verifyArcade(made.world);
  console.log(seed, v.bot.outcome, v.bot.tick, 'idle', v.idle.outcome, JSON.stringify(v).slice(0, 300));
}
